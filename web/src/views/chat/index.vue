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
import SessionList from './components/SessionList.vue'
import ChatMessage from './components/ChatMessage.vue'
import ChatInput from './components/ChatInput.vue'
import {
  apiChatForward,
  apiChatHistory,
  apiChatPoke,
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
  type ChatSession,
  type ChatStatus,
  type ChatType,
  type MsgBtn,
  type MsgSeg,
} from '@/api'
import { useAuthStore } from '@/stores/auth'

/** 轮询间隔。消息没有日志那么密，2 秒的延迟看着还算即时 */
const INTERVAL = 2000
/** 一次向上翻多少条 */
const PAGE = 20
/** 页面上最多留多少条，太多 DOM 会卡，图片也占内存 */
const MAX_KEEP = 400
/** 摘要长度，引用条与引用段都用 */
const SUMMARY_LEN = 30

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
const sideRef = ref<InstanceType<typeof SessionList> | null>(null)
const inputRef = ref<InstanceType<typeof ChatInput> | null>(null)

/** 「查看原始消息」弹窗里展示的那条 */
const rawMsg = ref<ChatMsg | null>(null)

let timer: number | undefined
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

/* ---------------- 会话 ---------------- */

async function openSession(session: ChatSession) {
  if (current.value?.key === session.key) return
  current.value = session
  messages.value = []
  replyTo.value = null
  missed.value = false
  hasMore.value = false
  historySupported.value = true
  follow.value = true
  newTip.value = false
  errMsg.value = ''
  await loadHistory(true)
  await clearUnread(session.key)
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

async function scrollToEnd() {
  await nextTick()
  const box = boxEl.value
  if (box) box.scrollTop = box.scrollHeight
  newTip.value = false
}

function onScroll() {
  const box = boxEl.value
  if (!box) return
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  if (follow.value !== atBottom) follow.value = atBottom
  if (atBottom) newTip.value = false
  // 快到顶了就继续往上翻
  if (box.scrollTop < 60 && hasMore.value && !loadingHistory.value) loadHistory(false)
}

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

/** 右键「查看原始」：把这条消息的完整结构弹出来，排障用 */
function onRaw(msg: ChatMsg) {
  rawMsg.value = msg
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

onMounted(async () => {
  await loadStatus()
  await pull()
  timer = window.setInterval(pull, INTERVAL)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  timer = undefined
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
      <aside class="g-chat-side">
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

      <main class="g-chat-main">
        <template v-if="current">
          <div class="g-chat-head">
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
            <div v-if="loadingHistory && messages.length" class="g-chat-loading">
              <a-spin size="small" />
            </div>
            <div v-else-if="hasMore" class="g-chat-loading">
              <a-button size="small" type="text" @click="loadHistory(false)">加载更早的消息</a-button>
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

    <!-- 右键「查看原始消息」：展示这条消息的完整结构 -->
    <a-modal
      :open="!!rawMsg"
      :title="rawMsg ? `原始消息 · ${rawMsg.messageId || rawMsg.seq || '无 id'}` : ''"
      :footer="null"
      width="640"
      @cancel="rawMsg = null"
    >
      <pre class="g-chat-raw">{{ rawMsg ? JSON.stringify(rawMsg, null, 2) : '' }}</pre>
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
  max-height: 60vh;
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

/* 窄屏放不下两栏，改成上下：列表压成一小块，消息流占剩下的 */
@media (max-width: 860px) {
  .g-chat-body {
    flex-direction: column;
    height: auto;
  }

  .g-chat-side {
    width: 100%;
    max-height: 260px;
  }

  .g-chat-main {
    min-height: 60vh;
  }
}
</style>
