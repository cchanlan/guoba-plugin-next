<script setup lang="ts">
/**
 * 运行日志。
 *
 * 日志在 Bot 进程里被 LogService 接管 stdout / stderr 收下来（见
 * server/service/both/LogService.js），这里按秒轮询取增量：带上上次的 cursor，
 * 后端只返回更新的行。比长连接省事，断网恢复后自己就接上了。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button, Empty, Input, Select, Switch, Tag, Tooltip, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import GBackTop from '@/components/GBackTop.vue'
import { scrollPageToBottom } from '@/utils/scroll'
import {
  apiClearLog,
  apiLogSendImage,
  apiLogStatus,
  apiTailLog,
  type LogLine,
  type LogStatus,
} from '@/api'

/** 轮询间隔，1 秒足够跟上刷屏，也不至于让面板一直忙着请求 */
const INTERVAL = 1000
/** 页面上最多留多少行，超了从头砍，浏览器渲染吃不住太多 DOM */
const MAX_KEEP = 3000

const LEVELS = [
  { value: 'all', label: '全部' },
  { value: 'debug', label: 'Debug 以上' },
  { value: 'info', label: 'Info 以上' },
  { value: 'warn', label: 'Warn 以上' },
  { value: 'error', label: '只看错误' },
]

const lines = ref<LogLine[]>([])
const status = ref<LogStatus | null>(null)
const level = ref('all')
const keyword = ref('')
/** 自动滚到底，用户往上翻的时候自动关掉 */
const follow = ref(true)
const paused = ref(false)
const loading = ref(true)
const errMsg = ref('')

const boxEl = ref<HTMLElement | null>(null)
let timer: number | undefined
/** 上次取到的游标，0 表示还没取过 */
let cursor = 0
/** 请求在飞的时候不再发下一个，慢网络下别把请求堆起来 */
let inflight = false

const empty = computed(() => !loading.value && !lines.value.length)

async function pull(reset = false) {
  if (inflight) return
  inflight = true
  try {
    const data = await apiTailLog({
      cursor: reset ? undefined : cursor,
      limit: reset ? 800 : 500,
      level: level.value,
      keyword: keyword.value.trim(),
    })
    cursor = data.cursor
    if (reset) {
      lines.value = data.lines
    } else if (data.lines.length) {
      if (data.missed) {
        // 缓冲被挤掉了一段，插一条提示，免得看的人以为日志是连续的
        lines.value.push({
          seq: -Date.now(),
          time: '',
          level: 'warn',
          text: '…… 中间有日志因缓冲上限被丢弃 ……',
          cont: false,
        })
      }
      lines.value.push(...data.lines)
      if (lines.value.length > MAX_KEEP) {
        lines.value.splice(0, lines.value.length - MAX_KEEP)
      }
    }
    errMsg.value = ''
    if (follow.value) await scrollToEnd()
  } catch (e: any) {
    errMsg.value = e?.message || '日志获取失败'
  } finally {
    inflight = false
    loading.value = false
  }
}

async function scrollToEnd() {
  await nextTick()
  const box = boxEl.value
  if (box) box.scrollTop = box.scrollHeight
}

/** 手动往上翻就别再抢着往下拉了，滚回底部自动恢复 */
function onScroll() {
  const box = boxEl.value
  if (!box) return
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  if (follow.value !== atBottom) follow.value = atBottom
}

function start() {
  stop()
  timer = window.setInterval(() => {
    if (!paused.value) pull()
  }, INTERVAL)
}

function stop() {
  if (timer) window.clearInterval(timer)
  timer = undefined
}

/** 筛选条件变了，整个重新取一遍 —— 筛选在后端做，本地这份对不上了 */
async function refresh() {
  loading.value = true
  cursor = 0
  await pull(true)
}

watch(level, refresh)

let keywordTimer: number | undefined
watch(keyword, () => {
  // 输入框防抖，别每敲一个字就打一次请求
  if (keywordTimer) window.clearTimeout(keywordTimer)
  keywordTimer = window.setTimeout(refresh, 300)
})

async function clear() {
  await apiClearLog()
  lines.value = []
  await refresh()
  await loadStatus()
}

async function loadStatus() {
  try {
    status.value = await apiLogStatus()
  } catch {
    // 状态栏是附加信息，取不到就算了
  }
}

/** 复制文本：clipboard API 可用就走它，否则退回 execCommand（http://ip 下 clipborad 是 undefined） */
function copyText(text: string, done: () => void, fail: () => void) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, fail)
  } else {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (ok) done()
    else fail()
  }
}

/** 日志级别在截图里的配色：error 红、warn 黄、info 绿，其余灰 */
const LOG_LEVEL_COLORS: Record<string, string> = {
  info: '#7fd6a0',
  warn: '#e6b566',
  error: '#ef6f6f',
  debug: '#7fa8d9',
  trace: '#8f9aa8',
  mark: '#c792ea',
}

/** 把日志画成 PNG（深色终端背景），返回 blob */
function drawLogImage(text: string, total: number): Promise<{ blob: Blob | null; truncated: boolean }> {
  const font = '12px ui-monospace, Menlo, Consolas, monospace'
  const pad = 16
  const lineH = 18
  const width = 900
  // PC 截图最多 100 行，太长画出来贴不下
  const maxRows = 100
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve({ blob: null, truncated: false })
  ctx.font = font
  const charW = ctx.measureText('M').width || 7.2
  const maxCols = Math.floor((width - pad * 2) / charW)
  // 折行 + 限高（日志太长画不下就截断，等宽字体按字符数切行）
  let rows = 0
  let truncated = false
  const wrapped: string[] = []
  for (const line of text.split('\n')) {
    if (!line) { wrapped.push(''); rows++ }
    else {
      for (let i = 0; i < line.length; i += maxCols) {
        wrapped.push(line.slice(i, i + maxCols))
        if (++rows >= maxRows) { truncated = true; break }
      }
    }
    if (rows >= maxRows) { truncated = true; break }
  }
  const height = rows * lineH + pad * 2
  canvas.width = width
  canvas.height = height
  ctx.fillStyle = '#1e1e1e'
  ctx.fillRect(0, 0, width, height)
  ctx.font = font
  let y = pad + lineH - 5
  for (const line of wrapped.slice(0, maxRows)) {
    // 按行首的 [时间][级别] 给整行上色：error 红、warn 黄、info 绿，默认灰
    ctx.fillStyle = '#d4d4d4'
    const m = line.match(/^\[([^\]]*)\]\[([^\]]*)\]/)
    if (m && LOG_LEVEL_COLORS[m[2]]) ctx.fillStyle = LOG_LEVEL_COLORS[m[2]]
    ctx.fillText(line, pad, y)
    y += lineH
  }
  if (truncated) {
    ctx.fillStyle = '#f0a35c'
    ctx.fillText(`… 日志过长，已截取前 ${maxRows} 行（共 ${total} 行）`, pad, y)
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve({ blob, truncated }), 'image/png')
  })
}

/** 复制最近 100 行日志的文本（要图就点「发给主人」） */
function copyAll() {
  const all = lines.value
  if (!all.length) return
  const text = all
    .slice(-100)
    .map((it) => (it.time ? `[${it.time}][${it.level}]${it.text}` : it.text))
    .join('\n')
  copyText(
    text,
    () => message.success(`已复制最近 ${Math.min(all.length, 100)} 行`),
    () => message.warn('复制失败，浏览器不允许访问剪贴板'),
  )
}

const sendingImage = ref(false)

/** 把最近 100 行日志渲染成图，私聊发给主人 */
async function sendImageToMaster() {
  const all = lines.value
  if (!all.length) {
    message.info('还没有日志')
    return
  }
  const rows = all
    .slice(-100)
    .map((it) => (it.time ? `[${it.time}][${it.level}]${it.text}` : it.text))
  const { blob } = await drawLogImage(rows.join('\n'), rows.length)
  if (!blob) {
    message.error('截图生成失败')
    return
  }
  // 图片走 multipart：base64 塞 JSON 会撞宿主 express.json 的 body 上限（413）
  const fd = new FormData()
  fd.append('image', blob, 'log.png')
  sendingImage.value = true
  try {
    const data = await apiLogSendImage(fd)
    message.success(`已发送给 ${data.sent.length} 个主人`)
  } catch {
    // 发送失败的错误已由请求层弹出
  } finally {
    sendingImage.value = false
  }
}

onMounted(async () => {
  await Promise.all([pull(true), loadStatus()])
  // 手机上日志框只占页面的一部分，光贴容器底还是看不到最新几行 ——
  // 首屏连页面一起拖到底。之后来新日志只滚容器，页面不再动。
  await nextTick()
  scrollPageToBottom()
  start()
})

onBeforeUnmount(() => {
  stop()
  if (keywordTimer) window.clearTimeout(keywordTimer)
})
</script>

<template>
  <div class="g-page g-log">
    <div class="g-page-head">
      <h2 class="g-page-title">运行日志</h2>
      <p class="g-page-desc">
        云崽控制台的实时输出，每秒刷新一次。日志里可能带有 token、QQ 号等信息，截图分享前记得先打码。
      </p>
    </div>

    <div class="g-log-bar">
      <Select v-model:value="level" :options="LEVELS" style="width: 130px" size="small" />
      <Input
        v-model:value="keyword"
        placeholder="过滤关键字"
        size="small"
        allow-clear
        style="width: 200px"
      >
        <template #prefix><GIcon icon="ant-design:search-outlined" /></template>
      </Input>

      <span class="g-log-switch">
        <Switch v-model:checked="paused" size="small" />
        <span>{{ paused ? '已暂停' : '实时' }}</span>
      </span>
      <span class="g-log-switch">
        <Switch v-model:checked="follow" size="small" @change="follow && scrollToEnd()" />
        <span>自动滚动</span>
      </span>

      <span class="g-log-gap" />

      <Tooltip title="把当前显示的日志复制到剪贴板">
        <Button size="small" @click="copyAll">复制</Button>
      </Tooltip>
      <Tooltip title="把当前显示的日志渲染成图，私聊发给主人">
        <Button size="small" :loading="sendingImage" @click="sendImageToMaster">
          <GIcon icon="ant-design:send-outlined" :size="13" /> 发给主人
        </Button>
      </Tooltip>
      <Tooltip title="只清面板里的显示，磁盘上的日志文件不动">
        <Button size="small" @click="clear">清空</Button>
      </Tooltip>
      <Button size="small" :loading="loading" @click="refresh">刷新</Button>
    </div>

    <div ref="boxEl" class="g-log-box" @scroll="onScroll">
      <Empty v-if="empty" :description="errMsg || '还没有日志'" class="g-log-empty" />
      <template v-else>
        <div v-for="line in lines" :key="line.seq" class="g-log-line" :class="`is-${line.level}`">
          <span class="g-log-time">{{ line.time }}</span>
          <span class="g-log-level">{{ line.cont ? '' : line.level }}</span>
          <span class="g-log-text">{{ line.text }}</span>
        </div>
      </template>
    </div>

    <div class="g-log-foot">
      <span>{{ lines.length }} 行</span>
      <Tag v-if="paused" color="orange">已暂停，日志仍在后台累积</Tag>
      <Tag v-else-if="errMsg" color="red">{{ errMsg }}</Tag>
      <span v-if="status" class="g-log-dim">
        缓冲 {{ status.lines }} / {{ status.max }} 行
        <template v-if="status.logFile"> · 历史日志 {{ status.logFile }}</template>
      </span>
    </div>

    <GBackTop />
  </div>
</template>

<style scoped>
.g-log {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.g-log-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.g-log-gap {
  flex: 1;
}

.g-log-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-log-box {
  flex: 1;
  min-height: 420px;
  max-height: calc(100vh - 260px);
  /* 手机浏览器的地址栏会吃掉高度，有 dvh 就按真正的可视高度算 */
  max-height: calc(100dvh - 260px);
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--g-border);
  border-radius: 10px;
  background: var(--g-bg-soft);
  font-family: 'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
}

.g-log-empty {
  margin: 80px auto;
}

/* 手机上整页不滚：页面撑满可视高度，日志只在框里滚，框底正好贴到屏幕底部。
   原来靠 min-height / max-height 猜高度，猜多了页面被撑长、猜少了下面空一截 */
@media (max-width: 768px) {
  /* 顶栏已经写着「运行日志」了，页面里这个大标题在手机上纯占高度 */
  .g-page-head {
    display: none;
  }

  .g-log {
    height: 100%;
    min-height: 0;
  }

  .g-log-box {
    /* 工具栏折成两三行时也别把日志框挤没 */
    min-height: 160px;
    max-height: none;
  }
}

.g-log-line {
  display: flex;
  gap: 8px;
  color: var(--g-text);
  white-space: pre-wrap;
  word-break: break-all;
}

.g-log-line:hover {
  background: var(--g-bg-card);
}

.g-log-time {
  flex: none;
  width: 76px;
  color: var(--g-text-dim);
}

.g-log-level {
  flex: none;
  width: 42px;
  text-transform: uppercase;
  opacity: 0.85;
}

.g-log-text {
  flex: 1;
}

/* 级别配色，只染级别列与关键级别的正文，整屏不至于太花 */
.is-trace .g-log-level,
.is-debug .g-log-level {
  color: var(--g-text-dim);
}

.is-trace .g-log-text,
.is-debug .g-log-text {
  color: var(--g-text-sub);
}

.is-info .g-log-level {
  color: var(--g-brand);
}

.is-mark .g-log-level {
  color: #52c41a;
}

.is-warn .g-log-level,
.is-warn .g-log-text {
  color: #d48806;
}

.is-error .g-log-level,
.is-error .g-log-text,
.is-fatal .g-log-level,
.is-fatal .g-log-text {
  color: var(--g-danger);
}

.g-log-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-log-dim {
  color: var(--g-text-dim);
}
</style>
