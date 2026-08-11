<script setup lang="ts">
/**
 * 沙盒。
 *
 * 在网页里伪造一条消息事件喂给云崽的插件加载器，把插件的回复截下来显示，
 * 不经过任何适配器，所以不会真的发到 QQ 上。用来验证插件是否响应某句指令、
 * 回复长什么样，不用真去群里刷屏。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import MsgSegment from './components/MsgSegment.vue'
import SceneDrawer from './components/SceneDrawer.vue'
import RulesDrawer from './components/RulesDrawer.vue'
import {
  apiSandboxDefaults,
  apiSandboxSend,
  type SandboxBlocked,
  type SandboxBot,
  type SandboxReply,
  type SandboxScene,
  type SandboxSegment,
} from '@/api'

/** 会话与场景存本地，刷新页面不丢 */
const SCENE_KEY = 'guoba-sandbox-scene'
const CHAT_KEY = 'guoba-sandbox-chat'
/** 本地最多留多少条，太多会拖慢渲染，图片也占内存 */
const MAX_CHAT = 100
/** 入站图片张数上限，与后端一致 */
const MAX_IMAGES = 5

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
}

const scene = ref<SandboxScene>({ ...defaultScene })
const bots = ref<SandboxBot[]>([])
const masterQQ = ref<string[]>([])

const chat = ref<ChatItem[]>([])
const text = ref('')
const images = ref<string[]>([])
const sending = ref(false)

const sceneOpen = ref(false)
const rulesOpen = ref(false)

const boxEl = ref<HTMLElement>()
const fileEl = ref<HTMLInputElement>()

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
})

function restore() {
  try {
    const rawScene = localStorage.getItem(SCENE_KEY)
    if (rawScene) scene.value = { ...defaultScene, ...JSON.parse(rawScene) }
    const rawChat = localStorage.getItem(CHAT_KEY)
    if (rawChat) chat.value = JSON.parse(rawChat)
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

async function send() {
  if (sending.value) return
  const content = text.value.trim()
  if (!content && !images.value.length) return
  if (!scene.value.userId) {
    message.warning('请先在场景配置里填写发送者 QQ')
    return
  }

  const outSegments: SandboxSegment[] = [
    ...images.value.map((url) => ({ type: 'image', url })),
    ...(content ? [{ type: 'text', text: content }] : []),
  ]
  chat.value.push({ id: nextId(), role: 'user', time: Date.now(), segments: outSegments })

  const payload = { scene: scene.value, text: content, images: [...images.value] }
  text.value = ''
  images.value = []
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
          id: reply.id,
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

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f)
  if (files.length) {
    e.preventDefault()
    addFiles(files)
  }
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

function clearChat() {
  chat.value = []
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
          <div class="g-msg-row">
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
      <div v-if="images.length" class="g-sandbox-imgs">
        <div v-for="(img, i) in images" :key="i" class="g-sandbox-img">
          <img :src="img" alt="" />
          <span class="g-sandbox-img-del" @click="removeImage(i)">
            <GIcon icon="ant-design:close-outlined" :size="10" />
          </span>
        </div>
      </div>

      <a-textarea
        v-model:value="text"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行；可粘贴或选择图片…"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :bordered="false"
        @keydown.enter="onEnter"
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
          @click="send"
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

.g-sandbox-box {
  flex: 1;
  min-height: 320px;
  max-height: calc(100vh - 340px);
  overflow-y: auto;
  padding: 14px;
  background: var(--g-bg-soft);
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
  margin-bottom: 14px;
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
  background: var(--g-bg);
  border: 1px solid var(--g-border);
  color: var(--g-text-sub);
}

.g-msg-main {
  min-width: 0;
  max-width: 78%;
}

.g-msg-name {
  margin-bottom: 3px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-msg-bubble {
  display: inline-block;
  padding: 8px 12px;
  background: var(--g-bg);
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
  background: var(--g-bg);
  overflow: hidden;
}

.g-sandbox-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 10px 0;
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
</style>
