<script setup lang="ts">
/**
 * 终端。
 *
 * 长驻 shell 会话（后端 TermService），轮询拉增量输出（同日志页范式）。
 * 命令在面板进程所在环境执行 —— 等同服务器 shell，能删文件、重启 Bot，页面顶部给了提示。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiTermExec,
  apiTermInterrupt,
  apiTermRestart,
  apiTermStatus,
  apiTermTail,
  type TermLine,
  type TermStatus,
} from '@/api'

/** 轮询间隔：命令输出要跟手，500ms 够即时又不至于打爆接口 */
const INTERVAL = 500
/** 页面最多留多少行，太多 DOM 卡 */
const MAX_KEEP = 2000

/** 危险命令：命中后弹确认才执行 */
const DANGEROUS = [
  /^\s*rm\s+(-[a-z]*r[a-z]*f?\s+)+[\w./~-]/i,
  /^\s*mkfs(\.\w+)?\s+/,
  /^\s*dd\s+/,
  /^\s*shutdown\b/i,
  /^\s*reboot\b/i,
  /^\s*poweroff\b/i,
  /^\s*:\(\)\{/,
  /^\s*format\s+/i,
  /^\s*del\s+\/s/i,
  /^\s*rd\s+\/s/i,
  /^\s*>.*\/dev\/(sda|sdb|sd[a-z]|nvme)/,
  /^\s*mv\s+.*\s+\/dev\/null/,
]

const status = ref<TermStatus | null>(null)
const lines = ref<TermLine[]>([])
const input = ref('')
const follow = ref(true)
const inflight = ref(false)
const errMsg = ref('')

/** 命令历史，上下键翻 */
const history = ref<string[]>([])
let historyIdx = -1

let cursor = 0
let timer: number | undefined

const boxEl = ref<HTMLElement | null>(null)
const inputEl = ref<any>(null)

function isDangerous(cmd: string) {
  return DANGEROUS.some((r) => r.test(cmd))
}

async function pull() {
  if (inflight.value) return
  inflight.value = true
  try {
    const data = await apiTermTail(cursor)
    cursor = data.cursor
    // 顶栏的 shell 状态、当前目录和提示符跟着轮询刷新（cd 后能看到新路径）
    if (status.value) {
      status.value.running = data.running
      status.value.cwd = data.cwd
      status.value.prompt = data.prompt
    }
    if (data.lines.length) {
      lines.value.push(...data.lines)
      if (lines.value.length > MAX_KEEP) {
        lines.value.splice(0, lines.value.length - MAX_KEEP)
      }
      if (follow.value) await scrollToEnd()
    }
    errMsg.value = ''
  } catch (e: any) {
    errMsg.value = e?.message || '输出获取失败'
  } finally {
    inflight.value = false
  }
}

async function scrollToEnd() {
  await nextTick()
  const box = boxEl.value
  if (box) box.scrollTop = box.scrollHeight
}

function onScroll() {
  const box = boxEl.value
  if (!box) return
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  follow.value = atBottom
}

/* ---------------- 输入 ---------------- */

async function doExec(cmd: string) {
  try {
    await apiTermExec(cmd)
    history.value.unshift(cmd)
    if (history.value.length > 100) history.value.pop()
    historyIdx = -1
    input.value = ''
    // 立即拉一次，命令回显更跟手，不用干等 500ms
    await pull()
    nextTick(() => inputEl.value?.focus())
  } catch {
    // 执行失败错误已由请求层弹出
  }
}

function onEnter(e: KeyboardEvent) {
  if (e.shiftKey) return
  const cmd = input.value.trim()
  if (!cmd) return
  e.preventDefault()
  if (isDangerous(cmd)) {
    Modal.confirm({
      title: '危险命令',
      content: `这条命令可能造成不可逆的破坏，确认执行？\n\n${cmd}`,
      okText: '执行',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => doExec(cmd),
    })
    return
  }
  void doExec(cmd)
}

/** 上下键翻历史命令 */
function onArrow(e: KeyboardEvent) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  if (!history.value.length) return
  e.preventDefault()
  if (e.key === 'ArrowUp') {
    historyIdx = Math.min(historyIdx + 1, history.value.length - 1)
  } else {
    historyIdx = Math.max(historyIdx - 1, -1)
  }
  input.value = historyIdx >= 0 ? history.value[historyIdx] : ''
}

/** 输入框里的 Ctrl+C 等价中断：pm2 log 这类前台进程靠这个退 */
function onInputKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    void interrupt()
    return
  }
  onArrow(e)
}

/** 中断当前前台进程（按钮 + Ctrl+C 共用） */
async function interrupt() {
  try {
    await apiTermInterrupt()
  } catch {
    // 错误已由请求层弹出
  }
}

/* ---------------- 工具栏 ---------------- */

/** 清屏：只清前端显示，后端缓冲不动（新输出会正常追来） */
function clearScreen() {
  lines.value = []
  follow.value = true
  scrollToEnd()
}

async function restart() {
  try {
    await apiTermRestart()
    lines.value = []
    cursor = 0
    message.success('终端已重启')
    await pull()
  } catch {
    // 错误已由请求层弹出
  }
}

/* ---------------- 生命周期 ---------------- */

async function loadStatus() {
  try {
    status.value = await apiTermStatus()
  } catch {
    // 状态是附加信息，取不到就算了
  }
}

onMounted(async () => {
  await loadStatus()
  await pull()
  timer = window.setInterval(() => pull(), INTERVAL)
  nextTick(() => inputEl.value?.focus())
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  timer = undefined
})
</script>

<template>
  <div class="g-page g-term">
    <div class="g-page-head">
      <h2 class="g-page-title">终端</h2>
      <p class="g-page-desc">
        网页里的 shell，命令在<b>面板进程所在环境</b>执行 —— 装依赖、改文件、重启 Bot 都干得出来，
        危险命令会先弹确认。Windows 部署时是 PowerShell，中文乱码先执行
        <code>chcp 65001</code>。
      </p>
    </div>

    <div class="g-term-head">
      <span class="g-term-shell">
        <GIcon icon="ant-design:code-outlined" :size="13" />
        {{ status?.shell ?? '…' }}
      </span>
      <a-tag :color="status?.running ? 'processing' : 'default'">
        {{ status?.running ? '执行中' : '空闲' }}
      </a-tag>
      <span class="g-term-cwd">{{ status?.cwd ?? '' }}</span>
      <span class="g-term-gap" />
      <a-button size="small" @click="interrupt" title="中断当前前台进程，等价键盘 Ctrl+C">
        <GIcon icon="ant-design:poweroff-outlined" :size="13" />
        Ctrl+C
      </a-button>
      <a-button size="small" @click="clearScreen">
        <GIcon icon="ant-design:clear-outlined" :size="13" />
        清屏
      </a-button>
      <a-button size="small" @click="restart">
        <GIcon icon="ant-design:reload-outlined" :size="13" />
        重启
      </a-button>
    </div>

    <div v-if="errMsg" class="g-term-err">{{ errMsg }}</div>

    <div ref="boxEl" class="g-term-box" @scroll.passive="onScroll">
      <div
        v-for="line in lines"
        :key="line.seq"
        class="g-term-line"
        :class="`is-${line.type}`"
      >
        <span>{{ line.text }}</span>
      </div>
      <div v-if="!lines.length" class="g-term-empty">
        还没有输出，在下面输入命令，例如 <code>pwd</code> 或 <code>ls</code>
      </div>
    </div>

    <div class="g-term-input">
      <!-- 输入框前缀跟着提示符走：cd 之后这里立刻显示新路径 -->
      <span class="g-term-prompt">{{ status?.prompt || '$ ' }}</span>
      <input
        ref="inputEl"
        v-model="input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        class="g-term-field"
        :placeholder="status?.running ? '命令执行中，可点 Ctrl+C 中断' : '输入命令，Enter 执行'"
        @keydown.enter="onEnter"
        @keydown="onInputKeydown"
      />
    </div>
  </div>
</template>

<style scoped>
/* antd 4 按钮 inline-block + 基线对齐会把 svg 图标顶起来，改成 flex 居中（同文件管理页） */
.g-term :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-term {
  display: flex;
  flex-direction: column;
  /* 正好贴底：视口 - 顶栏(56px) - 页面上下留白(40px)。输出多了在内部滚，页面本身不滚 */
  height: calc(100vh - 96px);
  min-height: 380px;
}

.g-term-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.g-term-shell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--g-brand);
  font-size: 13px;
  font-weight: 500;
}

.g-term-cwd {
  color: var(--g-text-dim);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.g-term-gap {
  flex: 1;
}

.g-term-err {
  padding: 6px 10px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: var(--g-bg-soft);
  color: var(--g-danger);
  font-size: 12px;
}

.g-term-box {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--g-bg);
  border: 1px solid var(--g-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
}

.g-term-line {
  min-height: 1.65em;
}

.g-term-line.is-cmd {
  color: var(--g-text);
  font-weight: 600;
}

.g-term-line.is-cmd .g-term-prompt {
  color: var(--g-brand);
}

.g-term-line.is-err {
  color: var(--g-danger);
}

.g-term-prompt {
  margin-right: 6px;
  color: var(--g-brand);
  user-select: none;
}

.g-term-empty {
  color: var(--g-text-dim);
}

.g-term-empty code,
.g-term-desc code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--g-bg-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.g-term-input {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--g-bg);
  border: 1px solid var(--g-border);
}

.g-term-field {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  color: var(--g-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}

.g-term-field::placeholder {
  color: var(--g-text-dim);
}
</style>
