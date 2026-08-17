import { computed, onUnmounted, ref } from 'vue'
import { apiBackupCancel, apiBackupTask, type BackupLog, type BackupTask } from '@/api'

/**
 * 备份 / 还原任务的轮询。
 *
 * 后端同一时刻只允许一个任务，所以状态放在模块作用域里做单例 —— 新建 Tab 和还原 Tab
 * 看到的是同一份进度，刷新页面也能接着看（进来先 refresh 一次）。
 */

const INTERVAL = 1000

const task = ref<BackupTask | null>(null)
const logs = ref<BackupLog[]>([])
/** 已拿到的最大日志 seq，后端只回比它新的 */
let cursor = -1
let timer: number | undefined
let pulling = false
/** 有几个组件在用，都卸载了就停轮询 */
let refs = 0

async function pull() {
  if (pulling) return
  pulling = true
  try {
    const data = await apiBackupTask(cursor)
    task.value = data.task
    if (data.logs?.length) logs.value.push(...data.logs)
    cursor = data.cursor ?? cursor
    if (!data.task || data.task.done) stop()
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

export function useBackupTask() {
  refs++
  onUnmounted(() => {
    refs--
    if (refs <= 0) stop()
  })

  /** 进页面时拉一次：可能有别的浏览器标签或定时任务正在跑 */
  async function refresh() {
    cursor = -1
    logs.value = []
    await pull()
    if (task.value && !task.value.done) start()
  }

  /** create / restore 接口返回的就是任务初态，直接接上 */
  function begin(res: { task: BackupTask | null; logs: BackupLog[]; cursor: number }) {
    logs.value = res.logs ?? []
    cursor = res.cursor ?? -1
    task.value = res.task
    start()
  }

  async function cancel() {
    await apiBackupCancel()
    await pull()
  }

  const running = computed(() => !!task.value && !task.value.done)

  /** 进度百分比，total 还没算出来时按 0 */
  const percent = computed(() => {
    const t = task.value
    if (!t) return 0
    if (t.done) return t.phase === 'done' ? 100 : 0
    if (!t.total) return 0
    return Math.min(99, Math.floor((t.current / t.total) * 100))
  })

  return { task, logs, running, percent, refresh, begin, cancel, pull }
}
