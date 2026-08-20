<script setup lang="ts">
/**
 * 插件更新面板。
 *
 * 检查更新和更新共用后端的同一个任务槽（更新会动 git 工作区，不能并发），所以也共用这个
 * 弹窗：检查直接看进度，更新前先选「遇到本地改动怎么办」——默认跳过，用户自己改过的代码
 * 不该被一次点击冲掉。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Alert, Button, Checkbox, CheckboxGroup, Modal, Progress, Radio, RadioGroup, Tag, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiPluginUpdateCheck, apiPluginUpdateRun, type PluginGitInfo } from '@/api'
import { usePluginUpdateTask } from '../usePluginUpdateTask'

const props = defineProps<{ items: PluginGitInfo[] }>()
const emit = defineEmits<{ refresh: [] }>()

const { task, logs, running, percent, finishedAt, begin, cancel, refresh: refreshTask } = usePluginUpdateTask()

const open = ref(false)
/** form = 还在选；task = 已经起了任务，看进度和结果 */
const stage = ref<'form' | 'task'>('form')
const selected = ref<string[]>([])
const mode = ref<'safe' | 'stash' | 'force'>('safe')
const npmInstall = ref(true)
const restart = ref(false)
const starting = ref(false)
const canceling = ref(false)
const logBox = ref<HTMLElement | null>(null)

const MODE_OPTIONS = [
  { value: 'safe', label: '跳过有改动的插件', desc: '最稳，自己改过的插件原样不动' },
  { value: 'stash', label: '暂存改动后更新', desc: 'git stash 收走再更新，更新完放回；冲突时改动留在 stash 里' },
  { value: 'force', label: '丢弃改动强制更新', desc: 'git reset --hard，本地改动和未推送的提交都会没了' },
] as const

/** 有更新的插件 */
const candidates = computed(() => props.items.filter((it) => it.behind > 0))

/** 勾中的这些里有几个带本地改动 —— 决定要不要提醒换模式 */
const dirtyPicked = computed(() =>
  candidates.value.filter((it) => selected.value.includes(it.name) && it.dirty))

const title = computed(() => {
  if (stage.value === 'form') return '更新插件'
  return task.value?.type === 'check' ? '检查更新' : '更新插件'
})

const result = computed(() => task.value?.result ?? null)

/** 更新结果里各状态的条目 */
const resultItems = computed(() => (task.value?.type === 'update' ? result.value?.items ?? [] : []))

/** 检查结果：只列出有更新的 */
const checkedBehind = computed(() =>
  task.value?.type === 'check' ? (result.value?.items ?? []).filter((it: any) => it.behind > 0) : [])

/** 日志跟着往下滚，跑长任务时不用自己拖 */
watch(() => logs.value.length, async () => {
  await nextTick()
  const box = logBox.value
  if (box) box.scrollTop = box.scrollHeight
})

watch(() => task.value?.id, () => {
  canceling.value = false
})

// 任务跑完让外面重新读一次 git 状态（落后数、能不能回滚都变了）
watch(finishedAt, (v) => {
  if (v) emit('refresh')
})

/** 打开更新表单。names 为空就默认全勾上有更新的 */
function openUpdate(names?: string[]) {
  if (running.value) {
    stage.value = 'task'
    open.value = true
    return
  }
  const pick = names?.length ? names : candidates.value.map((it) => it.name)
  if (!pick.length) {
    message.info('没有待更新的插件，先点「检查更新」')
    return
  }
  selected.value = pick
  stage.value = 'form'
  open.value = true
}

/** 起检查更新任务，直接进进度视图 */
async function startCheck(names?: string[]) {
  if (running.value) {
    stage.value = 'task'
    open.value = true
    return
  }
  starting.value = true
  try {
    const res = await apiPluginUpdateCheck(names)
    begin(res)
    stage.value = 'task'
    open.value = true
  } finally {
    starting.value = false
  }
}

async function doRun() {
  if (!selected.value.length) {
    message.warning('先勾上要更新的插件')
    return
  }
  starting.value = true
  try {
    const res = await apiPluginUpdateRun({
      names: selected.value,
      mode: mode.value,
      npmInstall: npmInstall.value,
      restart: restart.value,
    })
    begin(res)
    stage.value = 'task'
  } finally {
    starting.value = false
  }
}

function onCancel() {
  canceling.value = true
  cancel()
}

/** 进来先看一眼有没有正在跑的任务（别的标签页起的） */
refreshTask().then(() => {
  if (running.value) {
    stage.value = 'task'
    open.value = true
  }
})

const STATUS_TEXT: Record<string, { text: string; color: string }> = {
  updated: { text: '已更新', color: 'green' },
  'up-to-date': { text: '已是最新', color: 'default' },
  skipped: { text: '跳过', color: 'orange' },
  failed: { text: '失败', color: 'red' },
}

defineExpose({ openUpdate, startCheck })
</script>

<template>
  <Modal v-model:open="open" :title="title" :width="600" :mask-closable="false">
    <!-- 选插件和模式 -->
    <template v-if="stage === 'form'">
      <div class="g-pu-label">要更新的插件（{{ selected.length }} / {{ candidates.length }}）</div>
      <CheckboxGroup v-model:value="selected" class="g-pu-list">
        <label v-for="it in candidates" :key="it.name" class="g-pu-row">
          <Checkbox :value="it.name" />
          <span class="g-pu-name">{{ it.name }}</span>
          <Tag color="orange">落后 {{ it.behind }} 个提交</Tag>
          <Tag v-if="it.dirty" color="red">本地有改动</Tag>
          <Tag v-if="it.ahead > 0">本地有 {{ it.ahead }} 个未推送提交</Tag>
          <span class="g-pu-subject">{{ it.commits?.[0]?.subject ?? '' }}</span>
        </label>
      </CheckboxGroup>

      <div class="g-pu-label">遇到本地改动</div>
      <RadioGroup v-model:value="mode" class="g-pu-modes">
        <Radio v-for="opt in MODE_OPTIONS" :key="opt.value" :value="opt.value" class="g-pu-mode">
          <span>{{ opt.label }}</span>
          <span class="g-pu-desc">{{ opt.desc }}</span>
        </Radio>
      </RadioGroup>

      <Alert
        v-if="dirtyPicked.length && mode === 'safe'"
        type="info"
        show-icon
        class="g-pu-alert"
        :message="`勾中的 ${dirtyPicked.length} 个插件有本地改动，当前模式下会被跳过`"
      />
      <Alert
        v-if="mode === 'force'"
        type="warning"
        show-icon
        class="g-pu-alert"
        message="强制更新会丢掉这些插件里的本地改动和未推送的提交，且找不回来"
      />

      <div class="g-pu-opts">
        <Checkbox v-model:checked="npmInstall">package.json 变了就装依赖</Checkbox>
        <Checkbox v-model:checked="restart">全部完成后重启 Bot</Checkbox>
      </div>
      <p class="g-pu-tip">不重启的话，更新过的插件代码要等下次重启才生效。</p>
    </template>

    <!-- 进度 + 日志 + 结果 -->
    <template v-else>
      <div class="g-pu-head">
        <GIcon
          :icon="running ? 'ant-design:loading-3-quarters-outlined' : (task?.error ? 'ant-design:close-circle-outlined' : 'ant-design:check-circle-outlined')"
          :size="15"
          :class="{ 'is-spin': running }"
        />
        <span v-if="task?.total">{{ task.current }} / {{ task.total }}</span>
        <span v-if="task?.mode" class="g-pu-desc">{{ task.mode === 'safe' ? '跳过有改动' : task.mode === 'stash' ? '暂存改动' : '强制更新' }}</span>
      </div>
      <Progress :percent="percent" :status="task?.error ? 'exception' : (running ? 'active' : 'success')" />

      <div ref="logBox" class="g-pu-logs">
        <div v-for="l in logs" :key="l.seq" class="g-pu-log" :class="`is-${l.level}`">{{ l.text }}</div>
        <div v-if="!logs.length" class="g-pu-log">等待输出…</div>
      </div>

      <Alert v-if="task?.error" type="error" show-icon class="g-pu-alert" :message="task.error" />

      <!-- 检查完：列出有更新的 -->
      <template v-if="task?.done && task.type === 'check'">
        <Alert
          v-if="!checkedBehind.length"
          type="success"
          show-icon
          class="g-pu-alert"
          message="所有插件都是最新的"
        />
        <div v-else class="g-pu-result">
          <div v-for="it in checkedBehind" :key="it.name" class="g-pu-res-row">
            <span class="g-pu-name">{{ it.name }}</span>
            <Tag color="orange">{{ it.behind }} 个提交</Tag>
            <span class="g-pu-subject">{{ it.commits?.[0]?.subject ?? '' }}</span>
          </div>
        </div>
      </template>

      <!-- 更新完：逐个说明结果 -->
      <div v-if="task?.done && task.type === 'update' && resultItems.length" class="g-pu-result">
        <div v-for="it in resultItems" :key="it.name" class="g-pu-res-item">
          <div class="g-pu-res-row">
            <span class="g-pu-name">{{ it.name }}</span>
            <Tag :color="STATUS_TEXT[it.status]?.color">{{ STATUS_TEXT[it.status]?.text ?? it.status }}</Tag>
            <span v-if="it.from" class="g-pu-desc">{{ it.from }} → {{ it.to }}</span>
            <Tag v-if="it.deps" :color="it.deps.ok ? 'blue' : 'red'">
              {{ it.deps.ok ? '依赖已装' : '依赖失败' }}
            </Tag>
            <Tag v-if="it.stash === 'kept'" color="red">暂存未放回</Tag>
          </div>
          <div v-if="it.reason" class="g-pu-res-reason">{{ it.reason }}</div>
          <div v-if="it.deps && !it.deps.ok" class="g-pu-res-reason">依赖：{{ it.deps.reason }}</div>
          <ul v-if="it.commits?.length" class="g-pu-commits">
            <li v-for="c in it.commits.slice(0, 5)" :key="c.hash">
              <code>{{ c.hash }}</code> {{ c.subject }}
            </li>
            <li v-if="it.commits.length > 5" class="g-pu-desc">…还有 {{ it.commits.length - 5 }} 个提交</li>
          </ul>
        </div>
      </div>

      <Alert
        v-if="result?.restartSkipped"
        type="warning"
        show-icon
        class="g-pu-alert"
        message="已跳过自动重启，详情看上面的日志"
      />
      <Alert
        v-else-if="result?.restarted"
        type="info"
        show-icon
        class="g-pu-alert"
        message="Bot 正在重启，稍后刷新页面"
      />
    </template>

    <template #footer>
      <template v-if="stage === 'form'">
        <Button @click="open = false">取消</Button>
        <Button type="primary" :loading="starting" :danger="mode === 'force'" @click="doRun">
          开始更新
        </Button>
      </template>
      <template v-else>
        <Button v-if="running" danger :loading="canceling" @click="onCancel">取消任务</Button>
        <Button v-else type="primary" @click="open = false">关闭</Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.g-pu-label {
  margin: 12px 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.g-pu-label:first-child {
  margin-top: 0;
}

.g-pu-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  padding: 6px 8px;
  border: 1px solid var(--g-border);
  border-radius: 6px;
}

/* 一行一个插件：名字 + 标签 + 最新提交标题，手机上标题会被挤掉，靠 ellipsis 收住 */
.g-pu-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 0;
  cursor: pointer;
}

.g-pu-name {
  font-size: 13px;
  font-weight: 500;
  word-break: break-all;
}

.g-pu-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-pu-modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.g-pu-mode {
  display: flex;
  align-items: baseline;
}

.g-pu-desc {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-pu-mode .g-pu-desc {
  margin-left: 8px;
}

.g-pu-alert {
  margin-top: 10px;
}

.g-pu-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 12px;
}

.g-pu-tip {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-pu-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}

.is-spin {
  animation: g-pu-spin 1.4s linear infinite;
}

@keyframes g-pu-spin {
  to {
    transform: rotate(360deg);
  }
}

.g-pu-logs {
  margin-top: 10px;
  max-height: 200px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--g-bg-soft);
  border: 1px solid var(--g-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}

.g-pu-log {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--g-text-sub);
}

.g-pu-log.is-warn {
  color: var(--g-ansi-yellow);
}

.g-pu-log.is-error {
  color: var(--g-danger);
}

.g-pu-log.is-cmd {
  color: var(--g-text-dim);
}

.g-pu-result {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.g-pu-res-item {
  padding: 8px 10px;
  border: 1px solid var(--g-border);
  border-radius: 6px;
}

.g-pu-res-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.g-pu-res-reason {
  margin-top: 4px;
  font-size: 12px;
  color: var(--g-text-sub);
  word-break: break-all;
}

.g-pu-commits {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-pu-commits code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
}
</style>
