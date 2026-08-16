<script setup lang="ts">
/**
 * 消息记录。
 *
 * 与沙盒相反，这里是真收真发：消息来自适配器（实时事件 + QQ 服务端的历史记录），
 * 发出去的会真的出现在群里。实时部分照日志页的路子按秒轮询取增量（后端
 * ChatService 维护环形缓冲 + 单调游标），比长连接省事，断网恢复后自己接上。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import GBackTop from '@/components/GBackTop.vue'
import SessionList from './components/SessionList.vue'
import ChatMessage from './components/ChatMessage.vue'
import ChatInput from './components/ChatInput.vue'
import {
  apiChatForward,
  apiChatHistory,
  apiChatPoke,
  apiChatRaw,
  apiChatRead,
  apiChatRecall,
  apiChatResend,
  apiChatSend,
  apiChatSendRaw,
  apiChatStatus,
  apiChatTail,
  chatAssetUrl,
  chatProxyUrl,
  type ChatActiveItem,
  type ChatMsg,
  type ChatRaw,
  type ChatSession,
  type ChatStatus,
  type ChatType,
  type MsgBtn,
  type MsgSeg,
} from '@/api'
import { writeText } from '@/utils/clipboard'
import { scrollPageToBottom } from '@/utils/scroll'
import { useAuthStore } from '@/stores/auth'

/** 轮询间隔。消息没有日志那么密，2 秒的延迟看着还算即时 */
const INTERVAL = 2000
/** 一次向上翻多少条 */
const PAGE = 20
/** 页面上最多留多少条，太多 DOM 会卡，图片也占内存 */
const MAX_KEEP = 400
/** 摘要长度，引用条与引用段都用 */
const SUMMARY_LEN = 30
/** 窄屏断点，跟样式里的 media query 保持一致（原始消息弹窗的定位要按它分支） */
const NARROW_WIDTH = 860

const SEG_TEXT: Record<string, string> = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  face: '[表情]',
  node: '[合并转发]',
  forward: '[合并转发]',
  markdown: '[Markdown]',
}

/**
 * 「查看原始消息」的四档，名字沿用 QQ 里 `#取`（Packet-plugin）的叫法，内容也对齐：
 * 前两档来自 `get_msg`，后两档走 send_packet 取 protobuf。
 *
 * pb 两档要 Packet-plugin + 协议端开 packet 模式，取不到时后端会给一句原因（pbNote）。
 */
type RawKey = 'array' | 'raw' | 'pbElem' | 'pbRaw'

const RAW_TABS: Array<{ key: RawKey; title: string; hint: string; miss: string }> = [
  {
    key: 'array',
    title: 'msg array',
    hint: 'get_msg 回来的消息段数组',
    miss: '取不到段数组（适配器没有 get_msg，面板内存里也没有了）。下面是面板规范化后的结构：',
  },
  {
    key: 'raw',
    title: 'msg raw',
    hint: 'get_msg 回来的完整结构 / 协议端的上报原文',
    miss: '取不到原文：适配器没有 get_msg，这条也不在面板内存里了。',
  },
  {
    key: 'pbElem',
    title: 'pb elem',
    hint: 'protobuf 里的 elem 元素（已滤掉 37 / 9 / 16 那几项杂项）',
    miss: '没取到 protobuf 元素。',
  },
  {
    key: 'pbRaw',
    title: 'pb raw',
    hint: 'SsoGetGroupMsg 回来的完整 protobuf',
    miss: '没取到 protobuf 原文。',
  },
]

const auth = useAuthStore()

const status = ref<ChatStatus | null>(null)
const bots = computed(() => status.value?.bots ?? [])
const maxImages = computed(() => status.value?.maxImages ?? 5)

const botId = ref('')
const type = ref<ChatType>('group')
const keyword = ref('')
/** 后端活跃表快照：会话 key -> 最后一条 + 未读，左侧列表拿它显示 */
const active = ref<Record<string, ChatActiveItem>>({})

const current = ref<ChatSession | null>(null)
/**
 * 手机屏（窄屏）不并排显示两栏 —— 一屏就那么高，对半分谁都不够看。
 * 改成微信 / QQ 那种两屏：没选会话时整屏是列表，点开后整屏是消息流，靠标题栏的返回键回列表。
 */
const narrowMq = window.matchMedia(`(max-width: ${NARROW_WIDTH}px)`)
const narrow = ref(narrowMq.matches)
const messages = ref<ChatMsg[]>([])
/** 适配器能不能拉历史，不能就只有面板运行期间的消息 */
const historySupported = ref(true)
const hasMore = ref(false)
const loadingHistory = ref(false)
const sending = ref(false)
/** 缓冲被挤掉过一段，页面上给个重载入口 */
const missed = ref(false)
const errMsg = ref('')
const replyTo = ref<{ messageId: string; name: string; text: string } | null>(null)
/** 在底部时新消息自动跟随，往上翻了就只提示不跳 */
const follow = ref(true)
const newTip = ref(false)

const boxEl = ref<HTMLElement | null>(null)
/** 消息列表本体，高度变化靠它来盯（见 ResizeObserver） */
const listEl = ref<HTMLElement | null>(null)
/** 消息流那一栏，原始消息弹窗要跟它左对齐 */
const mainEl = ref<HTMLElement | null>(null)
const sideRef = ref<InstanceType<typeof SessionList> | null>(null)
const inputRef = ref<InstanceType<typeof ChatInput> | null>(null)

/** 「查看原始消息」弹窗里展示的那条 */
const rawMsg = ref<ChatMsg | null>(null)
/** 四档原始数据，按 messageId 单独取 */
const rawData = ref<ChatRaw | null>(null)
const rawLoading = ref(false)
const rawTab = ref<RawKey>('array')
/** 弹窗的左上角位置，取消息流那栏的左上角 */
const rawLeft = ref(0)
const rawTop = ref(0)

let timer: number | undefined
/** 上次见到的内容高度，用来分辨「内容长高」和「用户在滚」 */
let lastHeight = 0
/** 上次取到的游标，0 表示还没取过 */
let cursor = 0
/** 活跃表版本，没变后端就不重复回传摘要 */
let rev = 0
let inflight = false

/* ---------------- 摘要 ---------------- */

function senderName(msg: ChatMsg) {
  const s = msg.sender
  return s.card || s.nickname || s.userId || '未知'
}

/** 段数组压成一行文本，给引用条和 reply 段用 */
function summarize(segments: MsgSeg[]) {
  let out = ''
  for (const seg of segments) {
    if (seg.type === 'text') out += seg.text ?? ''
    else if (seg.type === 'at') out += `@${seg.name || seg.qq} `
    else if (seg.type === 'reply') continue
    else out += SEG_TEXT[seg.type] ?? ''
    if (out.length > SUMMARY_LEN) break
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > SUMMARY_LEN ? `${out.slice(0, SUMMARY_LEN)}…` : out
}

/* ---------------- 段渲染要用的注入 ---------------- */

provide('msgAssetUrl', (assetId: string) => chatAssetUrl(assetId, auth.token))
// QQ 直链的 rkey 会过期，加载失败时由服务端代拉一次
provide('msgProxyUrl', (url: string) => chatProxyUrl(url, auth.token))

/**
 * reply 段显示「昵称：摘要」—— 被引用的那条得在页面上还留着才查得到，
 * 翻页翻掉了就退回只显示「引用」两个字。
 */
provide('msgReply', (id: string) => {
  const msg = messages.value.find((it) => it.messageId === id)
  if (!msg) return null
  return { name: senderName(msg), text: summarize(msg.segments) }
})

/**
 * 按钮段的点击。这里是真发，不能一点就送出去，所以 callback 也只填进输入框，
 * 由人确认后再发。
 */
provide('msgButtonClick', (btn: MsgBtn) => {
  const text = btn.callback || btn.input
  if (!text) return
  inputRef.value?.setText(text)
})

/**
 * 某个账号的适配器名。头像地址要按适配器分开拼（QQBot 用 appid + openid），
 * 所以按 uin 查在线账号表；多账号混适配器时也能对上，查不到就退回当前选中的那个。
 */
function adapterOf(uin?: string) {
  const hit = bots.value.find((b) => b.uin === String(uin ?? ''))
  if (hit) return hit.adapter ?? ''
  return bots.value.find((b) => b.uin === botId.value)?.adapter ?? ''
}

provide('chatBotAdapter', adapterOf)

/**
 * 某个账号的 QQBot appid。openid 头像得配上它才拼得出来，而 appid 不等于 uin ——
 * 有的 fork 用机器人 QQ 号当 self_id，所以只能按 uin 查在线账号表。
 */
function appIdOf(uin?: string) {
  return bots.value.find((b) => b.uin === String(uin ?? ''))?.appId ?? ''
}

provide('chatBotAppId', appIdOf)

/* ---------------- 会话 ---------------- */

async function openSession(session: ChatSession) {
  if (current.value?.key === session.key) return
  current.value = session
  messages.value = []
  lastHeight = 0
  replyTo.value = null
  missed.value = false
  hasMore.value = false
  historySupported.value = true
  follow.value = true
  newTip.value = false
  errMsg.value = ''
  await loadHistory(true)
  await clearUnread(session.key)
  // 手机上点开会话是整屏看消息，列表让位；页面本身不滚，容器自己贴底
  await nextTick()
  scrollPageToBottom()
}

/** 手机上从会话退回列表（宽屏两栏并排，用不到） */
function backToList() {
  current.value = null
  messages.value = []
  replyTo.value = null
  newTip.value = false
}

async function clearUnread(key: string) {
  try {
    const data = await apiChatRead(key)
    // 后端已清零，本地这份也跟上，免得等到下一次活跃表变化才刷掉红点
    if (active.value[key]) active.value[key] = { ...active.value[key], unread: 0 }
    rev = data.rev
  } catch {
    // 未读只是个红点，清不掉不影响看消息
  }
}

/**
 * 拉历史。
 *
 * @param first true 为打开会话时的首屏，false 为向上翻页
 */
async function loadHistory(first = false) {
  const session = current.value
  if (!session || loadingHistory.value) return
  loadingHistory.value = true
  const box = boxEl.value
  const prevHeight = box?.scrollHeight ?? 0
  const prevTop = box?.scrollTop ?? 0

  try {
    const data = await apiChatHistory({
      botId: session.botId,
      type: session.type,
      id: session.id,
      // 翻页游标是本地最早那条的 seq，首屏传空取最新
      seq: first ? '' : (messages.value[0]?.messageSeq ?? ''),
      count: PAGE,
    })
    // 期间可能已经切走了，别把结果盖到新会话上
    if (current.value?.key !== session.key) return
    historySupported.value = data.supported

    if (first) {
      cursor = data.cursor
      messages.value = data.messages
      hasMore.value = data.hasMore
      // 拉不了历史时退而取实时缓冲里已有的：cursor 传 0 就是「从头给我」
      if (!data.supported) await fillFromBuffer(session)
      follow.value = true
      await scrollToEnd()
    } else {
      const add = dedupe(data.messages)
      messages.value.unshift(...add)
      // 有些实现会把游标那条也带回来，全是重复的就说明到顶了
      hasMore.value = data.hasMore && add.length > 0
      await nextTick()
      // 往上插了内容，把滚动位置补回去，视觉上停在原处
      if (box) box.scrollTop = prevTop + (box.scrollHeight - prevHeight)
    }
    errMsg.value = ''
  } catch (e: any) {
    errMsg.value = e?.message || '历史消息拉取失败'
  } finally {
    loadingHistory.value = false
  }
}

/** 适配器不支持拉历史时的兜底：把内存缓冲里这个会话的消息倒出来 */
async function fillFromBuffer(session: ChatSession) {
  try {
    const data = await apiChatTail({ key: session.key, cursor: 0, rev })
    if (current.value?.key !== session.key) return
    cursor = data.cursor
    messages.value = data.messages
    if (data.sessions) active.value = data.sessions
    rev = data.rev
    // 这里的 missed 只说明「缓冲里更早的已被挤掉」，不是漏收，不用提示
  } catch {
    // 兜底失败就只等实时消息进来
  }
}

/** 与页面上已有的按 messageId 去重 —— 本地回显、实时事件、历史记录会撞同一条 */
function dedupe(list: ChatMsg[]) {
  const seen = new Set(messages.value.map((it) => it.messageId).filter(Boolean))
  return list.filter((it) => !it.messageId || !seen.has(it.messageId))
}

/* ---------------- 轮询 ---------------- */

async function pull() {
  // 标签页在后台就不请求，回到前台再一次性取增量
  if (inflight || document.hidden) return
  inflight = true
  const key = current.value?.key ?? ''
  try {
    const data = await apiChatTail({ key, cursor, rev })
    // 请求在飞的时候切了会话，这份结果对不上了 —— 游标也别推进，否则会漏消息
    if ((current.value?.key ?? '') !== key) return
    cursor = data.cursor
    if (data.sessions) active.value = data.sessions
    rev = data.rev
    if (data.missed) missed.value = true

    const add = dedupe(data.messages)
    if (add.length) {
      messages.value.push(...add)
      if (messages.value.length > MAX_KEEP) {
        messages.value.splice(0, messages.value.length - MAX_KEEP)
      }
      if (follow.value) await scrollToEnd()
      else newTip.value = true
    }
    // 当前会话开着，进来的新消息不该算未读
    if (current.value && data.unread) await clearUnread(current.value.key)
    errMsg.value = ''
  } catch (e: any) {
    errMsg.value = e?.message || '消息获取失败'
  } finally {
    inflight = false
  }
}

/** 同步贴底，DOM 已经是最新时用它 */
function stick() {
  const box = boxEl.value
  if (box) box.scrollTop = box.scrollHeight
}

async function scrollToEnd() {
  await nextTick()
  stick()
  newTip.value = false
}

function onScroll() {
  const box = boxEl.value
  if (!box) return
  // 内容长高也会触发 scroll（scrollTop 没动但离底更远了），那不是用户在往上翻，跟随状态别动
  const grew = box.scrollHeight !== lastHeight
  lastHeight = box.scrollHeight
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  if (!grew && follow.value !== atBottom) follow.value = atBottom
  if (atBottom) {
    follow.value = true
    newTip.value = false
  }
  // 快到顶了就继续往上翻
  if (box.scrollTop < 60 && hasMore.value && !loadingHistory.value) loadHistory(false)
}

/**
 * 贴底跟随。
 *
 * 首屏的图片是懒加载 + 服务端代拉，气泡高度会在设完 scrollTop 之后才一路长出来，
 * 只贴一次底就会停在半空 —— 所以盯着消息列表的高度，只要人还在底部就一直跟。
 * 往上翻（follow 变 false）就撒手，翻历史往上插内容时也不会被拽走。
 */
let ro: ResizeObserver | undefined

watch(listEl, (el) => {
  ro?.disconnect()
  ro = undefined
  if (!el || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(() => {
    if (!follow.value) return
    stick()
    // 这一下是我们自己滚的，别让 onScroll 当成内容长高
    lastHeight = boxEl.value?.scrollHeight ?? lastHeight
  })
  ro.observe(el)
})

/* ---------------- 发送 ---------------- */

async function onSend(payload: { text: string; images: File[]; ats: { qq: string; name: string }[] }) {
  const session = current.value
  if (!session) return
  sending.value = true
  try {
    // 图片以原始 File 走 multipart：base64 塞 JSON 会撞宿主 express 的 body 上限（413）
    const fd = new FormData()
    fd.set('botId', session.botId)
    fd.set('type', session.type)
    fd.set('id', session.id)
    fd.set('text', payload.text)
    fd.set('replyTo', replyTo.value?.messageId ?? '')
    // ats 把 name 也带上，不然后端拼出来的 at 段只有 qq，页面上显示不出被 @ 的人叫啥
    if (payload.ats?.length) {
      fd.set('ats', JSON.stringify(payload.ats.map((a) => ({ qq: a.qq, name: a.name }))))
    }
    for (const file of payload.images) fd.append('files', file)
    const data = await apiChatSend(fd)
    inputRef.value?.reset()
    replyTo.value = null
    // 后端也把这条塞进了缓冲，轮询会再送一次，靠 messageId 去重
    if (data.message) {
      const add = dedupe([data.message])
      messages.value.push(...add)
    }
    follow.value = true
    await scrollToEnd()
  } catch {
    // 请求层已经弹过错误了，内容留在输入框里好改
  } finally {
    sending.value = false
  }
}

async function onSendRaw(raw: string) {
  const session = current.value
  if (!session) return
  sending.value = true
  try {
    const data = await apiChatSendRaw({
      botId: session.botId,
      type: session.type,
      id: session.id,
      raw,
    })
    inputRef.value?.reset()
    if (data.message) {
      const add = dedupe([data.message])
      messages.value.push(...add)
    }
    follow.value = true
    await scrollToEnd()
  } catch {
    // 同上，Raw 内容不清空
  } finally {
    sending.value = false
  }
}

function onReply(msg: ChatMsg) {
  if (!msg.messageId) {
    message.warning('这条消息没有 id，没法引用')
    return
  }
  replyTo.value = { messageId: msg.messageId, name: senderName(msg), text: summarize(msg.segments) }
}

async function onRecall(msg: ChatMsg) {
  const session = current.value
  if (!session) return
  if (!msg.messageId) {
    message.warning('这条消息没有 id，没法撤回')
    return
  }
  try {
    await apiChatRecall({
      botId: session.botId,
      type: session.type,
      id: session.id,
      messageId: msg.messageId,
    })
    msg.recalled = true
    message.success('已撤回')
  } catch {
    // 撤别人的消息、或超过时限都会失败，错误由请求层弹出
  }
}

/** 右键 @：把消息发送者塞进输入框的 @ 列表，发送时转成真 at 段 */
function onAt(msg: ChatMsg) {
  inputRef.value?.addAt({ qq: msg.sender.userId, name: senderName(msg) })
}

/** 右键「查看原始」：弹窗里分四档看，pb 两档现取（走协议，稍慢） */
async function onRaw(msg: ChatMsg) {
  rawMsg.value = msg
  rawTab.value = 'array'
  rawData.value = null
  syncRawPos()
  const session = current.value
  if (!msg.messageId || !session) return
  rawLoading.value = true
  try {
    rawData.value = await apiChatRaw({
      botId: session.botId,
      type: session.type,
      id: session.id,
      messageId: msg.messageId,
    })
  } catch {
    // 取不到就只显示面板自己的结构，错误由请求层弹出
  } finally {
    rawLoading.value = false
  }
}

/** 弹窗的左上角贴着消息流那栏的左上角，看的时候不用左右上下找 */
function syncRawPos() {
  // 窄屏是上下两栏、整页滚动，消息流那栏的顶边往往已经滚出视口上方
  // （getBoundingClientRect().top 是负数），照抄坐标会把弹窗顶到屏幕外，看起来就是「打不开」。
  // 手机上不跟栏位对齐，固定贴视口左上角留一点边距。
  if (window.innerWidth <= NARROW_WIDTH) {
    rawLeft.value = 8
    rawTop.value = 12
    return
  }
  const box = mainEl.value?.getBoundingClientRect()
  // 宽屏也可能往下滚过一段，坐标钳在视口内，保证弹窗始终露得出来
  rawLeft.value = Math.round(Math.max(box?.left ?? 0, 8))
  rawTop.value = Math.round(Math.min(Math.max(box?.top ?? 0, 12), window.innerHeight * 0.4))
}

/** 位置与宽度都不写死：左上角对齐消息流那栏，宽度由内容撑，到视口边留点余量就换行 */
const rawStyle = computed(() => ({
  top: `${rawTop.value}px`,
  marginLeft: `${rawLeft.value}px`,
  marginRight: 'auto',
  maxWidth: `min(880px, calc(100vw - ${rawLeft.value + 24}px))`,
  // 顶边下移之后 JSON 区也得跟着收，不然长内容会顶出视口底部（200 是标题 + 页签 + 内边距）
  '--g-rawmax': `calc(100vh - ${rawTop.value + 200}px)`,
}))

function closeRaw() {
  rawMsg.value = null
  rawData.value = null
}

/** 面板规范化后的结构，msg array 档没有原始数据时兜底显示 */
const rawFallback = computed(() => (rawMsg.value ? JSON.stringify(rawMsg.value, null, 2) : ''))

const rawTextOf = (key: RawKey) => rawData.value?.[key] ?? ''

/** 某档为空时的说明。pb 两档的具体原因由后端给（没装 Packet-plugin、私聊、协议端没开…） */
function rawMissOf(t: { key: RawKey; miss: string }) {
  const note = rawData.value?.pbNote ?? ''
  if (note && (t.key === 'pbElem' || t.key === 'pbRaw')) return note
  return t.miss
}

/** 复制当前这一档，排障时贴给别人看 */
async function copyRaw() {
  const text = rawTextOf(rawTab.value) || (rawTab.value === 'array' ? rawFallback.value : '')
  if (!text) {
    message.info('这一档没有内容')
    return
  }
  if (await writeText(text)) message.success('已复制')
  else message.error('复制失败，请手动选中文本')
}

/** 右键「戳一戳」：对消息发送者 */
async function onPoke(msg: ChatMsg) {
  const session = current.value
  if (!session) return
  try {
    await apiChatPoke({
      botId: session.botId,
      type: session.type,
      id: session.id,
      userId: msg.sender.userId,
    })
    message.success(`戳了戳 ${senderName(msg)}`)
  } catch {
    // 适配器不支持或群权限不够，错误由请求层弹出
  }
}

/** 右键「复读」：按段原样再发一条（图片取回字节、表情带 id），不是只发文字 */
async function onResend(msg: ChatMsg) {
  const session = current.value
  if (!session) return
  if (!msg.messageId) {
    message.warning('这条消息没有 id，没法复读')
    return
  }
  sending.value = true
  try {
    const data = await apiChatResend({
      botId: session.botId,
      type: session.type,
      id: session.id,
      messageId: msg.messageId,
    })
    // 后端也把这条塞进了缓冲，轮询会再送一次，靠 messageId 去重
    if (data.message) {
      const add = dedupe([data.message])
      messages.value.push(...add)
    }
    follow.value = true
    await scrollToEnd()
  } catch {
    // 复读失败（比如图片资源已过期）由请求层弹出
  } finally {
    sending.value = false
  }
}

/** 合并转发的内容在 QQ 服务端，点开时才去取，取回来填进段里 */
async function onForward({ msg, seg }: { msg: ChatMsg; seg: MsgSeg }) {
  const session = current.value
  if (!session) return
  const messageId = seg.id || msg.messageId
  if (!messageId) {
    message.warning('这条合并转发没有 id，展不开')
    return
  }
  try {
    const data = await apiChatForward({
      botId: session.botId,
      type: session.type,
      id: session.id,
      messageId,
    })
    seg.nodes = data.nodes
  } catch {
    // 错误由请求层弹出
  }
}

/** 重新加载：消息重拉一遍，顺手刷一下左侧（群名、成员变动都可能对不上了） */
function reload() {
  missed.value = false
  loadHistory(true)
  sideRef.value?.reload()
}

/* ---------------- 生命周期 ---------------- */

async function loadStatus() {
  try {
    status.value = await apiChatStatus()
    if (!botId.value) botId.value = bots.value[0]?.uin ?? ''
  } catch {
    // 状态栏是附加信息，取不到就算了
  }
}

/** 切账号 / 切群聊私聊后原来的会话就不在列表里了，一并断开 */
watch([botId, type], () => {
  current.value = null
  messages.value = []
  replyTo.value = null
})

function syncNarrow() {
  narrow.value = narrowMq.matches
}

onMounted(async () => {
  await loadStatus()
  await pull()
  timer = window.setInterval(pull, INTERVAL)
  // 改窗宽会挪动消息流那一栏，开着的弹窗跟着走
  window.addEventListener('resize', syncRawPos)
  narrowMq.addEventListener('change', syncNarrow)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  timer = undefined
  ro?.disconnect()
  ro = undefined
  window.removeEventListener('resize', syncRawPos)
  narrowMq.removeEventListener('change', syncNarrow)
})

/* ---------------- 视图 ---------------- */

const title = computed(() => {
  const session = current.value
  if (!session) return ''
  return session.name || session.id
})

/** 跨天的那条把日期一起显示出来 */
const dateFlags = computed(() => {
  let prev = ''
  return messages.value.map((msg) => {
    const day = msg.time ? new Date(msg.time * 1000).toDateString() : ''
    const changed = day !== prev
    prev = day
    return changed
  })
})
</script>

<template>
  <div class="g-page g-chat">
    <div class="g-page-head">
      <h2 class="g-page-title">消息记录</h2>
      <p class="g-page-desc">
        真收真发：这里看到的是机器人真实收到的消息，发出去的也会<b>真的出现在 QQ 里</b>。
        消息只留在内存（约 {{ status?.max ?? 1000 }} 条），重启即丢；历史记录取自 QQ 服务端，
        需要适配器支持（OneBot v11 的 NapCat / Lagrange 等可用）。
        撤回只对机器人自己发的、或机器人有管理权限的消息生效，且有时限。
      </p>
    </div>

    <div class="g-chat-body">
      <!-- 手机上两栏各占一屏：点开会话后列表让位给消息流 -->
      <aside v-if="!narrow || !current" class="g-chat-side">
        <div class="g-chat-side-bar">
          <a-select
            v-if="bots.length > 1"
            v-model:value="botId"
            size="small"
            style="width: 100%"
            :options="bots.map((b) => ({
              value: b.uin,
              label: b.nickname ? `${b.nickname}（${b.uin}）` : b.uin,
            }))"
          />
          <a-radio-group v-model:value="type" size="small" button-style="solid" class="g-chat-tabs">
            <a-radio-button value="group">
              <GIcon icon="ant-design:team-outlined" :size="13" />
              群聊
            </a-radio-button>
            <a-radio-button value="friend">
              <GIcon icon="ant-design:user-outlined" :size="13" />
              私聊
            </a-radio-button>
          </a-radio-group>
          <a-input
            v-model:value="keyword"
            size="small"
            allow-clear
            :placeholder="type === 'group' ? '搜索群名 / 群号' : '搜索昵称 / QQ'"
          >
            <template #prefix>
              <GIcon icon="ant-design:search-outlined" :size="13" />
            </template>
          </a-input>
        </div>

        <SessionList
          ref="sideRef"
          :type="type"
          :bot-id="botId"
          :keyword="keyword"
          :active-key="current?.key ?? ''"
          :active="active"
          @select="openSession"
        />
      </aside>

      <main v-if="!narrow || current" ref="mainEl" class="g-chat-main">
        <template v-if="current">
          <div class="g-chat-head">
            <!-- 手机上列表被这一屏顶掉了，得有个回去的入口 -->
            <button v-if="narrow" type="button" class="g-chat-back" title="返回列表" @click="backToList">
              <GIcon icon="ant-design:left-outlined" :size="14" />
            </button>
            <span class="g-chat-title">{{ title }}</span>
            <span class="g-chat-sub">
              {{ current.type === 'group' ? '群' : 'QQ' }} {{ current.id }}
              <template v-if="bots.length > 1"> · 账号 {{ current.botId }}</template>
            </span>
            <span class="g-chat-gap" />
            <a-button size="small" type="text" :loading="loadingHistory" @click="reload">
              <GIcon icon="ant-design:sync-outlined" :size="13" />
              重新加载
            </a-button>
          </div>

          <div v-if="!historySupported" class="g-chat-note">
            当前适配器不支持拉取历史消息，只能看到面板运行期间收到的消息。
          </div>
          <div v-if="missed" class="g-chat-note is-warn">
            有消息因内存缓冲上限被丢弃，中间可能不连续。
            <a @click="reload">重新加载</a>
          </div>
          <div v-if="errMsg" class="g-chat-note is-warn">{{ errMsg }}</div>

          <div ref="boxEl" class="g-chat-msgs" @scroll.passive="onScroll">
            <!-- 包一层是给 ResizeObserver 用的：图片加载完内容长高，好继续贴底 -->
            <div ref="listEl">
              <div v-if="loadingHistory && messages.length" class="g-chat-loading">
                <a-spin size="small" />
              </div>
              <div v-else-if="hasMore" class="g-chat-loading">
                <a-button size="small" type="text" @click="loadHistory(false)">
                  加载更早的消息
                </a-button>
              </div>
              <div v-else-if="messages.length" class="g-chat-loading">没有更早的消息了</div>

              <a-empty v-if="!messages.length && !loadingHistory" class="g-chat-empty">
                <template #description>
                  <span>还没有消息，等新消息进来，或者直接在下面发一条</span>
                </template>
              </a-empty>

              <ChatMessage
                v-for="(msg, i) in messages"
                :key="msg.messageId || `${msg.seq}-${i}`"
                :msg="msg"
                :show-date="dateFlags[i]"
                @reply="onReply"
                @recall="onRecall"
                @forward="onForward"
                @at="onAt"
                @raw="onRaw"
                @poke="onPoke"
                @resend="onResend"
              />
            </div>
          </div>

          <!-- 往上翻着看的时候来了新消息，不打断阅读，给个跳回底部的提示 -->
          <button v-if="newTip" type="button" class="g-chat-new" @click="scrollToEnd()">
            <GIcon icon="ant-design:arrow-down-outlined" :size="12" />
            有新消息
          </button>

          <ChatInput
            ref="inputRef"
            :disabled="!bots.length"
            :sending="sending"
            :max-images="maxImages"
            :reply="replyTo"
            @send="onSend"
            @send-raw="onSendRaw"
            @cancel-reply="replyTo = null"
          />
        </template>

        <div v-else class="g-chat-none">
          <GIcon icon="ant-design:message-outlined" :size="28" />
          <p>左边挑一个会话开始</p>
          <p class="g-chat-none-sub">
            列表按最近活跃排序，有新消息的会话会带红点
            <template v-if="status && !status.attached">
              <br />
              消息监听没挂上，重启 Bot 后再看看
            </template>
          </p>
        </div>
      </main>
    </div>

    <GBackTop />

    <!-- 右键「查看原始消息」：四档分别看段数组 / 上报原文 / protobuf -->
    <!-- 左边跟消息流那栏对齐，宽度交给内容（见下方非 scoped 样式） -->
    <a-modal
      :open="!!rawMsg"
      :title="rawMsg ? `原始消息 · ${rawMsg.messageId || rawMsg.seq || '无 id'}` : ''"
      :footer="null"
      :style="rawStyle"
      wrap-class-name="g-chat-rawwrap"
      @cancel="closeRaw"
    >
      <p v-if="rawMsg && !rawMsg.messageId" class="g-chat-rawtip">
        这条消息没有 id，面板没法把原始数据对上，只能看规范化后的结构。
      </p>
      <a-spin :spinning="rawLoading">
        <a-tabs v-model:active-key="rawTab" size="small">
          <a-tab-pane v-for="t in RAW_TABS" :key="t.key" :tab="t.title">
            <div class="g-chat-rawbar">
              <span class="g-chat-rawhint">{{ t.hint }}</span>
              <a-button type="text" size="small" @click="copyRaw">
                <GIcon icon="ant-design:copy-outlined" :size="13" />
                复制
              </a-button>
            </div>
            <pre v-if="rawTextOf(t.key)" class="g-chat-raw">{{ rawTextOf(t.key) }}</pre>
            <template v-else-if="t.key === 'array'">
              <p class="g-chat-rawtip">{{ rawMissOf(t) }}</p>
              <pre class="g-chat-raw">{{ rawFallback }}</pre>
            </template>
            <p v-else class="g-chat-rawtip">{{ rawMissOf(t) }}</p>
          </a-tab-pane>
        </a-tabs>
      </a-spin>
    </a-modal>
  </div>
</template>

<style scoped>
.g-chat {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.g-chat-body {
  display: flex;
  gap: 10px;
  height: calc(100vh - 250px);
  min-height: 440px;
}

.g-chat-side {
  flex: none;
  display: flex;
  flex-direction: column;
  width: 250px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  overflow: hidden;
}

.g-chat-side-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--g-border);
}

/* 两个标签各占一半，宽度固定了才不会因为字数不同而跳 */
.g-chat-tabs {
  display: flex;
}

.g-chat-tabs :deep(.ant-radio-button-wrapper) {
  flex: 1;
  text-align: center;
}

.g-chat-main {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  overflow: hidden;
}

.g-chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--g-border);
}

/* 返回列表：只在手机屏出现，贴在标题左边 */
.g-chat-back {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: -4px;
  padding: 0;
  color: var(--g-text-sub);
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.g-chat-back:active {
  background: var(--g-bg-soft);
}

.g-chat-title {
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 500;
}

.g-chat-sub {
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-chat-gap {
  flex: 1;
}

.g-chat-note {
  padding: 6px 12px;
  border-bottom: 1px solid var(--g-border);
  background: var(--g-bg-soft);
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-chat-note.is-warn {
  color: var(--g-danger);
}

.g-chat-note a {
  margin-left: 4px;
}

.g-chat-msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  /* 容器压暗、气泡提亮，两个主题下都能看出层次 */
  background: var(--g-bg);
  /* 关掉浏览器的滚动锚定：它会在内容高度变化时自动调整 scrollTop，
     页面翻历史 / 图片懒加载时滚动条会自己动；我们有自己的滚动位置补偿，用不上它 */
  overflow-anchor: none;
  /* 滚动条槽位常驻，避免 hover 时滚动条出现/变宽把内容挤得左右晃 */
  scrollbar-gutter: stable;
}

.g-chat-loading {
  padding-bottom: 10px;
  text-align: center;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-chat-empty {
  margin-top: 50px;
  font-size: 12px;
}

/* 浮在输入框上方，不占布局 */
.g-chat-new {
  position: absolute;
  right: 16px;
  bottom: 120px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--g-brand);
  border-radius: 12px;
  background: var(--g-bg-elevated);
  color: var(--g-brand);
  font-family: inherit;
  font-size: 12px;
  box-shadow: var(--g-shadow);
  cursor: pointer;
}

.g-chat-none {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--g-text-dim);
  font-size: 13px;
}

.g-chat-none p {
  margin: 0;
}

.g-chat-none-sub {
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
}

/* 原始消息 JSON，等宽 + 可横向滚动 */
.g-chat-raw {
  max-height: min(420px, var(--g-rawmax, 52vh));
  overflow: auto;
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: var(--g-bg-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 每档上方一行：左边说明这档是什么，右边复制 */
.g-chat-rawbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.g-chat-rawhint {
  min-width: 0;
  color: var(--g-text-dim);
  font-size: 12px;
}

/* 某档没有数据时的说明，占位比空白清楚 */
.g-chat-rawtip {
  margin: 0 0 8px;
  color: var(--g-text-sub);
  font-size: 12px;
  line-height: 1.7;
}

/* 窄屏两栏各占一屏（谁显示由 narrow + current 决定，见模板），都铺满可视高度 */
@media (max-width: 860px) {
  /* 顶栏已经写着「消息记录」了，页面里这个大标题在手机上纯占高度 */
  .g-page-head {
    display: none;
  }

  /* 手机上整页不滚：页面撑满可视高度，那一栏在自己内部滚 ——
     容器底边正好落在屏幕底部，也不会「页面滚一层、容器再滚一层」把贴底跟随搞乱 */
  .g-chat {
    height: 100%;
    min-height: 0;
  }

  .g-chat-body {
    flex: 1;
    flex-direction: column;
    height: auto;
    min-height: 0;
  }

  .g-chat-side {
    flex: 1;
    width: 100%;
    min-height: 0;
  }

  .g-chat-main {
    flex: 1;
    height: auto;
    min-height: 0;
  }
}
</style>

<!-- 弹窗挂在 body 上，scoped 选择器管不到，这块只写 wrapClassName 限定的规则 -->
<style>
/**
 * 原始消息弹窗按内容自适应：宽度不写死，由里面的 JSON 撑，撑到上限就换行
 * （上限与左边距是内联给的，见 rawStyle —— 要按消息流那栏的位置算）。
 * 之前给的是 width="720" —— 字符串没单位，antd 直接把它塞进 style 里被 CSS 忽略，
 * 于是弹窗被长 JSON 拉成一整屏宽。
 */
.g-chat-rawwrap .ant-modal {
  width: auto !important;
  min-width: 360px;
}

/* 手机屏可能比 360 还窄，min-width 会把弹窗撑出屏幕，这里放开 */
@media (max-width: 860px) {
  .g-chat-rawwrap .ant-modal {
    min-width: 0;
  }
}
</style>
