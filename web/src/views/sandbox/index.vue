<script setup lang="ts">
/**
 * 沙盒。
 *
 * 在网页里伪造一条消息事件喂给云崽的插件加载器，把插件的回复截下来显示，
 * 不经过任何适配器，所以不会真的发到 QQ 上。用来验证插件是否响应某句指令、
 * 回复长什么样，不用真去群里刷屏。
 */
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import GBackTop from '@/components/GBackTop.vue'
import MsgSegment from '@/components/msg/MsgSegment.vue'
import SceneDrawer from './components/SceneDrawer.vue'
import RulesDrawer from './components/RulesDrawer.vue'
import {
  apiSandboxDefaults,
  apiSandboxSend,
  sandboxAssetUrl,
  type SandboxBlocked,
  type SandboxBot,
  type SandboxButton,
  type SandboxQuote,
  type SandboxReply,
  type SandboxScene,
  type SandboxSegment,
} from '@/api'
import { filesFromHtml, writeRich, writeText, toDataUrl } from '@/utils/clipboard'
import { scrollPageToBottom } from '@/utils/scroll'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

/** 会话与场景存本地，刷新页面不丢 */
const SCENE_KEY = 'guoba-sandbox-scene'
const CHAT_KEY = 'guoba-sandbox-chat'
/** 本地最多留多少条，太多会拖慢渲染，图片也占内存 */
const MAX_CHAT = 100
/** 入站图片张数上限，与后端一致 */
const MAX_IMAGES = 5
/** 引用最多回传几段给后端，与 SandboxService 的 MAX_QUOTE_SEGMENTS 一致 */
const MAX_QUOTE_SEGMENTS = 8
/** 右键复制时最多带几张图，一次粘贴几十张图没有意义 */
const MAX_COPY_IMAGES = 9

interface ChatItem {
  id: string
  role: 'user' | 'bot'
  time: number
  segments: SandboxSegment[]
  /** 机器人这一轮的执行信息 */
  meta?: {
    hit: string
    elapsed: number
    count: number
    blocked: SandboxBlocked
    error: string | null
  }
}

const defaultScene: SandboxScene = {
  selfId: '',
  isGroup: true,
  userId: '80000000',
  nickname: '沙盒用户',
  groupId: '100000000',
  groupName: '沙盒测试群',
  card: '',
  isMaster: true,
  isOwner: false,
  isAdmin: false,
  atBot: true,
  platform: 'default',
}

const scene = ref<SandboxScene>({ ...defaultScene })
const bots = ref<SandboxBot[]>([])
const masterQQ = ref<string[]>([])

const chat = ref<ChatItem[]>([])
const text = ref('')
const images = ref<string[]>([])
const sending = ref(false)
/** 正在引用的那条气泡，发送后清掉 */
const replyTo = ref<ChatItem | null>(null)

/** 右键菜单的上下文：点的是哪条气泡、指针下有没有图片 */
const ctxItem = ref<ChatItem | null>(null)
const ctxImg = ref('')

const sceneOpen = ref(false)
const rulesOpen = ref(false)

const boxEl = ref<HTMLElement>()
const fileEl = ref<HTMLInputElement>()
const inputEl = ref<any>(null)

let seq = 0
const nextId = () => `c${Date.now().toString(36)}-${++seq}`

/* ---------------- 初始化 ---------------- */

onMounted(async () => {
  restore()
  try {
    const data = await apiSandboxDefaults()
    bots.value = data.bots
    masterQQ.value = data.masterQQ
    // 本地没存过场景时才用后端给的默认值，别覆盖用户改过的
    if (!localStorage.getItem(SCENE_KEY)) {
      scene.value = { ...data.scene }
    } else if (!scene.value.selfId) {
      scene.value.selfId = data.scene.selfId
    }
  } catch {
    // 拉不到就用内置默认值，页面照常能用
  }
  scrollToEnd()
  // 手机上回复区在页面下半截，首屏把页面也一起拖到底 ——
  // 之后有新回复只滚容器，页面不再动
  await nextTick()
  scrollPageToBottom()
})

function restore() {
  try {
    const rawScene = localStorage.getItem(SCENE_KEY)
    if (rawScene) scene.value = { ...defaultScene, ...JSON.parse(rawScene) }
    const rawChat = localStorage.getItem(CHAT_KEY)
    if (rawChat) {
      const list = JSON.parse(rawChat) as ChatItem[]
      // 旧版资源 id 是自增 a1/a2，重启后会与浏览器缓存串图；丢掉含这类 id 的历史
      const legacy = (segs: SandboxSegment[] = []) =>
        segs.some((s) => typeof s.assetId === 'string' && /^a\d+$/.test(s.assetId))
      chat.value = Array.isArray(list) ? list.filter((item) => !legacy(item.segments)) : []
      if (chat.value.length !== list.length) {
        localStorage.setItem(CHAT_KEY, JSON.stringify(chat.value))
      }
    }
  } catch {
    // 存的东西坏了就当没存过
  }
}

watch(scene, (v) => localStorage.setItem(SCENE_KEY, JSON.stringify(v)), { deep: true })

watch(
  chat,
  (v) => {
    if (v.length > MAX_CHAT) v.splice(0, v.length - MAX_CHAT)
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(v))
    } catch {
      // 图片多了可能超 localStorage 配额，丢掉持久化即可，不影响当前会话
    }
  },
  { deep: true },
)

/* ---------------- 发送 ---------------- */

/** override 有值时发它、不动输入框（点 callback 按钮走这条） */
async function send(override?: string) {
  if (sending.value) return
  const useInput = override === undefined
  const content = (useInput ? text.value : override).trim()
  const imgs = useInput ? [...images.value] : []
  // 按钮触发的那条不带引用，跟图片一样只属于手动输入的这一次
  const quote = useInput && replyTo.value ? buildQuote(replyTo.value) : null
  if (!content && !imgs.length) return
  if (!scene.value.userId) {
    message.warning('请先在场景配置里填写发送者 QQ')
    return
  }

  const outSegments: SandboxSegment[] = [
    ...(quote ? [{ type: 'reply', id: quote.id }] : []),
    ...imgs.map((url) => ({ type: 'image', url })),
    ...(content ? [{ type: 'text', text: content }] : []),
  ]
  chat.value.push({ id: nextId(), role: 'user', time: Date.now(), segments: outSegments })

  const payload = { scene: scene.value, text: content, images: imgs, reply: quote }
  if (useInput) {
    text.value = ''
    images.value = []
    replyTo.value = null
  }
  sending.value = true
  scrollToEnd()

  try {
    const res = await apiSandboxSend(payload)
    const meta = {
      hit: res.hit,
      elapsed: res.elapsed,
      count: res.replies.length,
      blocked: res.blocked,
      error: res.error,
    }
    if (res.replies.length) {
      res.replies.forEach((reply: SandboxReply, i: number) => {
        chat.value.push({
          // 客户端自己生成 id。服务端 reply.id 重启后可能与 localStorage 里旧气泡撞车，
          // Vue 会复用错误的 DOM，看起来就像发火神面板却渲染出别的角色
          id: nextId(),
          role: 'bot',
          time: reply.time,
          segments: reply.segments,
          // 执行信息只挂在最后一条上，免得一次多条回复时重复一遍
          meta: i === res.replies.length - 1 ? meta : undefined,
        })
      })
    } else {
      chat.value.push({ id: nextId(), role: 'bot', time: Date.now(), segments: [], meta })
    }
  } catch (e: any) {
    message.error(e?.message ?? '发送失败')
  } finally {
    sending.value = false
    scrollToEnd()
  }
}

function onEnter(e: KeyboardEvent) {
  // Shift+Enter 换行，其余情况回车即发送
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return
  e.preventDefault()
  send()
}

/* ---------------- 按钮 ---------------- */

/**
 * 回复里的按钮点击。link 交给浏览器，callback 直接当成一条新消息发出去，
 * input 只填进输入框等用户补参数 —— 跟 QQ 官方 Bot 的按钮行为一致。
 * 用 provide 传给 MsgSegment，转发消息里嵌套的按钮才能一并接上。
 */
function onButtonClick(btn: SandboxButton) {
  if (btn.callback) {
    send(btn.callback)
    return
  }
  if (btn.input) {
    text.value = btn.input
    nextTick(() => inputEl.value?.focus())
  }
}

provide('msgButtonClick', onButtonClick)
// 沙盒的图片都在服务端的沙盒资源表里，没有 http 直链，所以不用 provide 代理地址
provide('msgAssetUrl', (assetId: string) => sandboxAssetUrl(assetId, auth.token))
// reply 段只带被引用消息的 id，气泡上要显示「谁说了什么」就得回本页的记录里查
provide('msgReply', (id: string) => {
  const item = chat.value.find((i) => i.id === id)
  if (!item) return null
  return { name: nameOf(item), text: brief(item, 40) }
})

/* ---------------- 引用与右键菜单 ---------------- */

function nameOf(item: ChatItem) {
  return item.role === 'user' ? senderName.value : currentBot.value
}

/**
 * 段数组拍成一行纯文本，复制、引用摘要、raw_message 都用它。
 *
 * `withImage` 为 false 时不写 `[图片]` 占位 —— 整条复制时图片本身也进了剪贴板，
 * 再写占位粘出来就多一串没用的文字。
 */
function segsText(segs: SandboxSegment[], withImage = true) {
  let out = ''
  for (const seg of segs) {
    if (seg.type === 'text') out += seg.text ?? ''
    else if (seg.type === 'at') out += `@${seg.name || seg.qq} `
    else if (seg.type === 'image') out += withImage ? '[图片] ' : ''
    else if (seg.type === 'record') out += '[语音] '
    else if (seg.type === 'video') out += '[视频] '
    else if (seg.type === 'file') out += '[文件] '
    else if (seg.type === 'face') out += '[表情] '
    else if (seg.type === 'node') out += '[合并转发] '
    else if (seg.type === 'markdown') out += seg.content ?? '[markdown] '
    // reply 段跳过：摘要里再嵌一层引用只会更难读
  }
  return out.trim()
}

/** 一句话摘要，引用条和 reply 段上显示 */
function brief(item: ChatItem, max: number) {
  const str = segsText(item.segments)
  if (!str) return '[空消息]'
  return str.length > max ? `${str.slice(0, max)}…` : str
}

/**
 * 把一条气泡包成发给后端的引用信息。
 *
 * 服务端不存沙盒会话，插件的 `e.getReply()` 要读到内容，只能由这里把段一并带上；
 * 段里图片的 assetId / dataURL 后端都认（见 SandboxService 的 #quoteImage）。
 */
function buildQuote(item: ChatItem): SandboxQuote {
  const isUser = item.role === 'user'
  return {
    id: item.id,
    userId: String(isUser ? scene.value.userId : scene.value.selfId),
    nickname: nameOf(item),
    time: item.time,
    text: segsText(item.segments),
    segments: item.segments
      .filter((seg) => seg.type === 'text' || seg.type === 'image')
      .slice(0, MAX_QUOTE_SEGMENTS),
  }
}

function startReply(item: ChatItem) {
  replyTo.value = item
  nextTick(() => inputEl.value?.focus())
}

function cancelReply() {
  replyTo.value = null
}

/**
 * 右键按下时先记下上下文再让 dropdown 弹出来。
 *
 * 一条消息可能有好几张图，所以顺着事件目标往上找 `img`，找到了菜单里才出现图片相关的项，
 * 复制的也正是指针底下那一张。
 */
function onContextMenu(ev: MouseEvent, item: ChatItem) {
  ctxItem.value = item
  const img = (ev.target as HTMLElement | null)?.closest?.('img') as HTMLImageElement | null
  ctxImg.value = img?.currentSrc || img?.src || ''
}

function onMsgMenuClick({ key }: { key: string }) {
  const item = ctxItem.value
  if (!item) return
  if (key === 'copy') void copyMessage(item)
  else if (key === 'copyImgUrl') void copyImgUrl()
  else if (key === 'reply') startReply(item)
}

/** 图片段的取用地址：http 直链原样用，其余走沙盒资源接口 */
function imgSrc(seg: SandboxSegment) {
  if (seg.url) return seg.url
  return seg.assetId ? sandboxAssetUrl(seg.assetId, auth.token) : ''
}

/**
 * 复制整条消息：文本和图片一起进剪贴板。
 *
 * 图片先读成 dataURL 再塞进剪贴板的 HTML，粘到 QQ、文档里才带得上图 —— 直接给
 * 面板的资源地址，对方是拉不到的（要 token，还不一定同网）。
 */
async function copyMessage(item: ChatItem) {
  const str = segsText(item.segments, false)
  const srcs = item.segments
    .filter((seg) => seg.type === 'image')
    .map(imgSrc)
    .filter(Boolean)
    .slice(0, MAX_COPY_IMAGES)

  if (!str && !srcs.length) {
    message.info('这条消息没有可复制的内容')
    return
  }

  const datas = (await Promise.all(srcs.map(toDataUrl))).filter((v): v is string => !!v)
  if (srcs.length && !datas.length) {
    // 图都读不到时才退回带 [图片] 占位的纯文本
    if (await writeText(segsText(item.segments))) message.warning('图片读不到，只复制了文字')
    else message.error('复制失败，请手动选中文本')
    return
  }
  if (await writeRich(str, datas)) {
    message.success(datas.length ? `已复制（含 ${datas.length} 张图）` : '已复制')
  } else {
    message.error(datas.length ? '浏览器不允许复制图片（http 下常见）' : '复制失败，请手动选中文本')
  }
}

async function copyImgUrl() {
  const src = ctxImg.value
  if (!src) return
  if (src.startsWith('data:')) {
    message.info('这是本地选的图，没有地址可复制')
    return
  }
  if (await writeText(src)) message.success('图片地址已复制（含临时令牌）')
  else message.error('复制失败')
}

/* ---------------- 图片 ---------------- */

function pickImages() {
  fileEl.value?.click()
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  // 清掉才能连着选同一个文件两次
  input.value = ''
}

async function onPaste(e: ClipboardEvent) {
  const data = e.clipboardData
  if (!data) return
  const files = Array.from(data.items)
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f)
  if (files.length) {
    e.preventDefault()
    addFiles(files)
    return
  }

  /**
   * 没有文件项但 HTML 里有图 —— 面板自己复制的消息在 http 下就是这形状
   * （见 utils/clipboard 的 copyHtml），得自己把图抠出来。
   */
  const html = data.getData('text/html')
  if (!html.includes('<img')) return
  e.preventDefault()
  const picked = await filesFromHtml(html, MAX_IMAGES)
  if (picked.length) addFiles(picked)
  else message.warning('剪贴板里的图片读不出来，只粘了文字')
  const plain = data.getData('text/plain')
  if (plain) text.value += plain
}

function addFiles(files: File[]) {
  const room = MAX_IMAGES - images.value.length
  if (room <= 0) {
    message.warning(`最多带 ${MAX_IMAGES} 张图`)
    return
  }
  files.slice(0, room).forEach((file) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') images.value.push(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function removeImage(index: number) {
  images.value.splice(index, 1)
}

/* ---------------- 其它 ---------------- */

/** 右键菜单挂到消息节点里，免得被聊天区的滚动条裁掉 */
function getPopupContainer(node: HTMLElement) {
  return node?.parentNode ?? document.body
}

function clearChat() {
  chat.value = []
  replyTo.value = null
  localStorage.removeItem(CHAT_KEY)
}

function scrollToEnd() {
  nextTick(() => {
    const el = boxEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const blockedText: Record<string, string> = {
  blacklist: '被黑白名单拦下，插件没有执行',
  onlyReplyAt: '群里开了「只回复@」，这条没有 @机器人',
  noRule: '没有插件匹配这句话',
  noReply: '插件执行了，但没有发出回复',
}

function metaText(meta: NonNullable<ChatItem['meta']>) {
  if (meta.error) return `执行出错：${meta.error}`
  if (meta.blocked) return blockedText[meta.blocked] ?? '没有回复'
  return `命中 ${meta.hit || '未知插件'}，捕获 ${meta.count} 条回复 · 耗时 ${meta.elapsed}ms`
}

const senderName = computed(() => scene.value.card || scene.value.nickname || '我')

const platformTip =
  '模拟目标平台：普通消息下按钮与 Markdown 段会被忽略（OneBot 等适配器的真实行为）；' +
  '切到 Markdown / 按钮则假装成 QQ 官方 Bot，这两类段会渲染出来，' +
  '插件里判断 e.bot.adapter.name === "QQBot" 的分支也会走通。'

const currentBot = computed(() => {
  const bot = bots.value.find((b) => b.uin === String(scene.value.selfId))
  return bot?.nickname || bot?.uin || '未选择账号'
})
</script>

<template>
  <div class="g-page g-sandbox">
    <div class="g-page-head">
      <h2 class="g-page-title">沙盒</h2>
      <p class="g-page-desc">
        在这里伪造一条消息喂给插件，回复只显示在本页，不会发到 QQ 上。
        注意跑的是<b>真实插件代码</b>，写数据库、调外部接口、扣次数这些副作用照样会发生；
        另外只拦截了 <code>e</code> 上下文，插件若绕开它直接用全局 <code>Bot</code> 给真实群发消息，沙盒拦不住。
      </p>
    </div>

    <div class="g-sandbox-bar">
      <a-select
        v-model:value="scene.selfId"
        size="small"
        style="width: 190px"
        placeholder="未检测到在线账号"
        :options="bots.map((b) => ({
          value: b.uin,
          label: b.nickname ? `${b.nickname}（${b.uin}）` : b.uin,
        }))"
      />

      <a-radio-group v-model:value="scene.isGroup" size="small" button-style="solid">
        <a-radio-button :value="true">群聊</a-radio-button>
        <a-radio-button :value="false">私聊</a-radio-button>
      </a-radio-group>

      <!-- 两组都是实心选中，挨着容易看成一组，中间隔一道 -->
      <span class="g-sandbox-sep" />

      <a-tooltip :title="platformTip">
        <a-radio-group v-model:value="scene.platform" size="small" button-style="solid">
          <a-radio-button value="default">普通消息</a-radio-button>
          <a-radio-button value="qqbot">Markdown / 按钮</a-radio-button>
        </a-radio-group>
      </a-tooltip>

      <span class="g-sandbox-gap" />

      <a-button size="small" @click="sceneOpen = true">
        <GIcon icon="ant-design:user-outlined" :size="13" />
        场景
      </a-button>
      <a-button size="small" @click="rulesOpen = true">
        <GIcon icon="ant-design:unordered-list-outlined" :size="13" />
        插件规则
      </a-button>
      <a-button size="small" :disabled="!chat.length" @click="clearChat">
        <GIcon icon="ant-design:clear-outlined" :size="13" />
        清空
      </a-button>
    </div>

    <div ref="boxEl" class="g-sandbox-box">
      <a-empty v-if="!chat.length" class="g-sandbox-empty">
        <template #description>
          <div>还没有消息</div>
          <div class="g-sandbox-hint">
            当前身份：{{ senderName }}（{{ scene.userId }}）
            {{ scene.isGroup ? `在群 ${scene.groupId}` : '私聊' }}
            对 {{ currentBot }} 说话
          </div>
        </template>
      </a-empty>

      <template v-else>
        <div v-for="item in chat" :key="item.id" class="g-msg" :class="`is-${item.role}`">
          <!-- 右键出菜单：整条复制（文本 + 图片）/ 引用这条 -->
          <a-dropdown
            :trigger="['contextmenu']"
            placement="bottomLeft"
            :get-popup-container="getPopupContainer"
          >
            <div class="g-msg-row" @contextmenu="onContextMenu($event, item)">
              <div class="g-msg-avatar">
                <GIcon
                  :icon="item.role === 'user' ? 'ant-design:user-outlined' : 'ant-design:robot-outlined'"
                  :size="16"
                />
              </div>
              <div class="g-msg-main">
                <div class="g-msg-name">
                  {{ item.role === 'user' ? senderName : currentBot }}
                </div>
                <div v-if="item.segments.length" class="g-msg-bubble">
                  <MsgSegment v-for="(seg, i) in item.segments" :key="i" :seg="seg" />
                </div>
              </div>
            </div>

            <template #overlay>
              <a-menu @click="onMsgMenuClick">
                <a-menu-item key="copy">
                  <GIcon icon="ant-design:copy-outlined" :size="13" />
                  复制
                </a-menu-item>
                <a-menu-item key="reply">
                  <GIcon icon="ant-design:rollback-outlined" :size="13" />
                  引用这条
                </a-menu-item>
                <a-menu-item v-if="ctxImg && !ctxImg.startsWith('data:')" key="copyImgUrl">
                  <GIcon icon="ant-design:link-outlined" :size="13" />
                  复制图片地址
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>

          <div
            v-if="item.meta"
            class="g-msg-meta"
            :class="{ 'is-warn': item.meta.blocked || item.meta.error }"
          >
            {{ metaText(item.meta) }}
          </div>
        </div>
      </template>

      <div v-if="sending" class="g-sandbox-loading">
        <a-spin size="small" />
        <span>插件执行中…</span>
      </div>
    </div>

    <div class="g-sandbox-input">
      <!-- 引用条：发出去时会在消息最前面加一段 reply，插件的 e.getReply() 就能读到它 -->
      <div v-if="replyTo" class="g-sandbox-quote">
        <GIcon icon="ant-design:rollback-outlined" :size="12" />
        <span class="g-sandbox-quote-name">{{ nameOf(replyTo) }}</span>
        <span class="g-sandbox-quote-text">{{ brief(replyTo, 60) }}</span>
        <span class="g-sandbox-quote-del" title="取消引用" @click="cancelReply">
          <GIcon icon="ant-design:close-outlined" :size="10" />
        </span>
      </div>

      <div v-if="images.length" class="g-sandbox-imgs">
        <div v-for="(img, i) in images" :key="i" class="g-sandbox-img">
          <img :src="img" alt="" />
          <span class="g-sandbox-img-del" @click="removeImage(i)">
            <GIcon icon="ant-design:close-outlined" :size="10" />
          </span>
        </div>
      </div>

      <a-textarea
        ref="inputEl"
        v-model:value="text"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行；可粘贴或选择图片…"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :bordered="false"
        @keydown.enter="onEnter"
        @keydown.esc="cancelReply"
        @paste="onPaste"
      />

      <div class="g-sandbox-actions">
        <a-button size="small" type="text" :disabled="images.length >= MAX_IMAGES" @click="pickImages">
          <GIcon icon="ant-design:picture-outlined" :size="15" />
        </a-button>
        <input
          ref="fileEl"
          type="file"
          accept="image/*"
          multiple
          hidden
          @change="onFileChange"
        />
        <span class="g-sandbox-gap" />
        <a-button
          type="primary"
          size="small"
          :loading="sending"
          :disabled="!text.trim() && !images.length"
          @click="send()"
        >
          <GIcon icon="ant-design:send-outlined" :size="13" />
          发送
        </a-button>
      </div>
    </div>

    <SceneDrawer
      v-model:open="sceneOpen"
      :scene="scene"
      :bots="bots"
      :masters="masterQQ"
      @update:scene="(v) => (scene = v)"
    />
    <RulesDrawer v-model:open="rulesOpen" :text="text" :is-group="scene.isGroup" />

    <GBackTop />
  </div>
</template>

<style scoped>
.g-sandbox {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.g-sandbox-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.g-sandbox-gap {
  flex: 1;
}

.g-sandbox-sep {
  width: 1px;
  height: 16px;
  background: var(--g-border);
}

.g-sandbox-box {
  flex: 1;
  min-height: 320px;
  max-height: calc(100vh - 340px);
  /* 手机浏览器的地址栏会吃掉高度，有 dvh 就按真正的可视高度算 */
  max-height: calc(100dvh - 340px);
  overflow-y: auto;
  padding: 14px;
  /* 容器压暗、气泡提亮，两个主题下都能看出层次 */
  background: var(--g-bg);
  border: 1px solid var(--g-border);
  border-radius: 10px;
}

.g-sandbox-empty {
  margin-top: 60px;
}

.g-sandbox-hint {
  margin-top: 6px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-msg {
  /* 右键菜单挂在这个节点里（getPopupContainer），得给它定位参照 */
  position: relative;
  margin-bottom: 18px;
}

.g-msg-row {
  display: flex;
  gap: 8px;
}

.g-msg-avatar {
  flex: none;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--g-bg-soft);
  border: 1px solid var(--g-border);
  color: var(--g-text-sub);
}

/* 机器人头像上品牌色，跟自己发的分开 */
.g-msg.is-bot .g-msg-avatar {
  background: var(--g-brand-soft);
  border-color: var(--g-brand);
  color: var(--g-brand);
}

.g-msg-main {
  min-width: 0;
  max-width: 78%;
}

.g-msg-name {
  margin-bottom: 4px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-msg-bubble {
  display: inline-block;
  padding: 8px 12px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.6;
  text-align: left;
  word-break: break-word;
}

/* 自己发的靠右 */
.g-msg.is-user .g-msg-row {
  flex-direction: row-reverse;
}

.g-msg.is-user .g-msg-main {
  text-align: right;
}

.g-msg.is-user .g-msg-bubble {
  background: var(--g-brand-soft);
  border-color: var(--g-brand);
}

.g-msg.is-user .g-msg-meta {
  text-align: right;
}

.g-msg-meta {
  margin: 6px 0 0 38px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-msg-meta.is-warn {
  color: #d48806;
}

.g-sandbox-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 4px 38px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-sandbox-input {
  margin-top: 10px;
  border: 1px solid var(--g-border);
  border-radius: 10px;
  background: var(--g-bg-card);
  overflow: hidden;
  transition: border-color 0.15s;
}

.g-sandbox-input:focus-within {
  border-color: var(--g-brand);
}

.g-sandbox-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 10px 0;
}

/* 引用条：贴在输入框顶部，左侧一道品牌色竖线 */
.g-sandbox-quote {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 10px 0;
  padding: 5px 8px;
  border-left: 2px solid var(--g-brand);
  border-radius: 0 6px 6px 0;
  background: var(--g-brand-soft);
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-sandbox-quote-name {
  flex: none;
  color: var(--g-brand);
}

.g-sandbox-quote-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-sandbox-quote-del {
  flex: none;
  display: flex;
  align-items: center;
  padding: 2px;
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-sandbox-quote-del:hover {
  color: var(--g-brand);
}

.g-sandbox-img {
  position: relative;
  width: 60px;
  height: 60px;
}

.g-sandbox-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--g-border);
}

.g-sandbox-img-del {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--g-text-sub);
  color: #fff;
  cursor: pointer;
}

.g-sandbox-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 8px;
}

/* 手机上整页不滚：页面撑满可视高度，回复只在框里滚 ——
   框底紧贴输入区、输入区紧贴屏幕底部，底下不再空一截。
   原来靠 min-height / max-height 猜高度，猜多了页面被撑长、猜少了下面空白 */
@media (max-width: 768px) {
  /* 顶栏已经写着「沙盒」了，页面里这个大标题在手机上纯占高度 */
  .g-page-head {
    display: none;
  }

  .g-sandbox {
    height: 100%;
    min-height: 0;
  }

  .g-sandbox-box {
    /* 输入框会随内容长高，给回复区留个下限，别被挤没了 */
    min-height: 140px;
    max-height: none;
  }
}
</style>
