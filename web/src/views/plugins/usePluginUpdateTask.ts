import { computed, onUnmounted, ref } from 'vue'
import {
  apiPluginUpdateCancel,
  apiPluginUpdateTask,
  type PluginUpdateTask,
  type PluginUpdateTaskState,
} from '@/api'

/**
 * 插件「检查更新 / 更新」任务的轮询。
 *
 * 后端同一时刻只允许一个任务（更新会动 git 工作区），所以状态放模块作用域做单例：
 * 刷新页面或换个标签进来，接着能看到正在跑的那个任务。写法与备份那边的 useBackupTask 一致。
 */

const INTERVAL = 900

const task = ref<PluginUpdateTask | null>(null)
const logs = ref<{ seq: number; level: string; text: string }[]>([])
/** 已拿到的最大日志 seq，后端只回比它新的 */
let cursor = -1
let timer: number | undefined
let pulling = false
/** 有几个组件在用，都卸载了就停轮询 */
let refs = 0
/** 任务刚跑完时通知一次，让页面重新读 git 状态 */
const finishedAt = ref(0)

async function pull() {
  if (pulling) return
  pulling = true
  try {
    const data = await apiPluginUpdateTask(cursor)
    const wasRunning = !!task.value && !task.value.done
    task.value = data.task
    if (data.logs?.length) logs.value.push(...data.logs)
    cursor = data.cursor ?? cursor
    if (!data.task || data.task.done) {
      stop()
      if (wasRunning) finishedAt.value = Date.now()
    }
  } catch {
    // 后端重启 / 断网：停掉轮询，不刷一屏错误提示
    stop()
  } finally {
    pulling = false
  }
}

function start() {
  stop()
  timer = window.setInterval(pull, INTERVAL)
}

function stop() {
  if (timer) window.clearInterval(timer)
  timer = undefined
}

export function usePluginUpdateTask() {
  refs++
  onUnmounted(() => {
    refs--
    if (refs <= 0) stop()
  })

  /** 进页面时拉一次：可能有别的标签页正在更新 */
  async function refresh() {
    cursor = -1
    logs.value = []
    await pull()
    if (task.value && !task.value.done) start()
  }

  /** check / run 接口返回的就是任务初态，直接接上 */
  function begin(res: PluginUpdateTaskState) {
    logs.value = res.logs ?? []
    cursor = res.cursor ?? -1
    task.value = res.task
    start()
  }

  async function cancel() {
    await apiPluginUpdateCancel()
    await pull()
  }

  const running = computed(() => !!task.value && !task.value.done)

  /** 进度百分比。total 还没定下来时按 0，跑完按 100 */
  const percent = computed(() => {
    const t = task.value
    if (!t) return 0
    if (t.done) return t.error ? 0 : 100
    if (!t.total) return 0
    return Math.min(99, Math.floor((t.current / t.total) * 100))
  })

  return { task, logs, running, percent, finishedAt, refresh, begin, cancel, pull }
}
