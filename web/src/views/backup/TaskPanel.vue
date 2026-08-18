<script setup lang="ts">
/**
 * 任务进度 + 日志。
 *
 * 备份和还原共用一个任务槽（后端同时只跑一个），所以这里也只显示一个 —— 在「新建备份」
 * 页看到一条还原任务是正常的，标题会写清楚是哪种。
 */
import { computed, nextTick, ref, watch } from 'vue'
import GIcon from '@/components/GIcon.vue'
import { backupDownloadUrl, type BackupDepsResult, type BackupLog, type BackupTask } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { formatBytes } from '@/utils/format'
import { PHASE_TEXT } from './types'

const props = defineProps<{
  task: BackupTask | null
  logs: BackupLog[]
  percent: number
  running: boolean
}>()

const emit = defineEmits<{ cancel: [] }>()

const auth = useAuthStore()
const logBox = ref<HTMLElement | null>(null)
/** 点过取消就把按钮锁住：clone 一个大仓库要几十秒才收得住，不锁的话用户会连点十几次 */
const canceling = ref(false)

function onCancel() {
  canceling.value = true
  emit('cancel')
}

// 换了一个任务就解锁
watch(() => props.task?.id, () => {
  canceling.value = false
})

const typeText = computed(() => (props.task?.type === 'restore' ? '还原' : '备份'))

/** 打包结果 */
const packResult = computed(() => {
  const r = props.task?.result
  if (!r || props.task?.type !== 'create') return null
  return r as { file: string; size: number; files: number }
})

/** 还原结果 */
const restoreResult = computed(() => {
  const r = props.task?.result
  if (!r || props.task?.type !== 'restore') return null
  return r as {
    cloned: string[]
    copied: string[]
    skipped: Array<{ name: string; reason: string }>
    failed: Array<{ name: string; reason: string }>
    fileFailures: Array<{ name: string; reason: string }>
    pending: string[]
    restored: number
    backupDir: string
    deps: BackupDepsResult | null
    pluginDeps?: Array<{
      name: string
      ran: boolean
      ok: boolean
      reason: string
      readme: { accepted: string[]; rejected: string[] }
    }>
    restartSkipped: boolean
  }
})

/** 依赖安装结果。没勾「还原后安装依赖」时是 null，卡片里那几段就整段不显示 */
const deps = computed(() => restoreResult.value?.deps ?? null)

const statusType = computed(() => {
  const t = props.task
  if (!t) return 'info'
  if (t.phase === 'error') return 'error'
  if (t.phase === 'canceled') return 'warning'
  if (t.done) return 'success'
  return 'info'
})

watch(
  () => props.logs.length,
  async () => {
    await nextTick()
    const box = logBox.value
    if (box) box.scrollTop = box.scrollHeight
  },
)
</script>

<template>
  <div v-if="task" class="g-bk-task">
    <div class="g-bk-task-head">
      <span class="g-bk-task-title">
        <GIcon
          :icon="running ? 'ant-design:sync-outlined' : 'ant-design:save-outlined'"
          :size="14"
          :class="{ 'is-spin': running }"
        />
        {{ typeText }}任务
        <a-tag v-if="task.auto" color="blue">定时</a-tag>
      </span>
      <span class="g-bk-task-phase">{{ PHASE_TEXT[task.phase] ?? task.phase }}</span>
      <span v-if="task.file" class="g-bk-task-file">{{ task.file }}</span>
      <a-button v-if="running" size="small" danger :loading="canceling" @click="onCancel">
        {{ canceling ? '正在停止' : '取消' }}
      </a-button>
    </div>

    <a-progress
      :percent="percent"
      :status="task.phase === 'error' ? 'exception' : running ? 'active' : 'normal'"
      :show-info="false"
      size="small"
    />
    <div class="g-bk-task-meta">
      {{ task.current }} / {{ task.total || '?' }} 个文件
      <template v-if="task.totalBytes">
        · {{ formatBytes(task.bytes) }} / {{ formatBytes(task.totalBytes) }}
      </template>
    </div>

    <a-alert v-if="task.error" type="error" show-icon :message="task.error" class="g-bk-task-alert" />

    <!-- 打包完成：直接给下载入口，省得再去备份管理里找 -->
    <a-alert v-else-if="packResult" :type="statusType" show-icon class="g-bk-task-alert">
      <template #message>
        备份完成：{{ packResult.file }}（{{ formatBytes(packResult.size) }}，{{ packResult.files }} 个文件）
      </template>
      <template #action>
        <a-button size="small" type="link" :href="backupDownloadUrl(packResult.file, auth.token)">
          <GIcon icon="ant-design:cloud-download-outlined" :size="13" />
          下载
        </a-button>
      </template>
    </a-alert>

    <a-alert v-else-if="restoreResult" :type="statusType" show-icon class="g-bk-task-alert">
      <template #message>还原完成：写入 {{ restoreResult.restored }} 个文件</template>
      <template #description>
        <div v-if="restoreResult.copied?.length">
          按文件直接还原（备份时明确勾选了插件全部条目，没走 clone）：{{ restoreResult.copied.join('、') }}
        </div>
        <div v-if="restoreResult.cloned.length">
          clone 装上的：{{ restoreResult.cloned.join('、') }}
        </div>
        <div v-if="restoreResult.skipped.length">
          已存在跳过：{{ restoreResult.skipped.map((s) => s.name).join('、') }}
        </div>
        <div v-if="restoreResult.failed.length" class="is-warn">
          安装失败：{{ restoreResult.failed.map((s) => `${s.name}（${s.reason}）`).join('；') }}
        </div>
        <div v-if="restoreResult.fileFailures?.length" class="is-warn">
          文件还原失败（旧文件已尽力自动恢复）：{{
            restoreResult.fileFailures.map((s) => `${s.name}（${s.reason}）`).join('；')
          }}
        </div>
        <div v-if="restoreResult.pending.length" class="is-warn">
          {{ restoreResult.pending.join('、') }} 的文件暂存在
          <code>data/guoba/backups/.pending-restore/</code>，装好插件后再还原一次即可
        </div>
        <div v-if="restoreResult.backupDir">
          被覆盖的原文件已存进 <code>{{ restoreResult.backupDir }}</code>
        </div>

        <div v-for="p in restoreResult.pluginDeps ?? []" :key="`deps:${p.name}`" :class="{ 'is-warn': !p.ok }">
          {{ p.name }}：{{ p.ok ? (p.ran ? '插件依赖安装完成' : '没有需要安装的依赖') : `依赖安装失败（${p.reason}）` }}
          <template v-if="p.readme.rejected.length">；忽略 {{ p.readme.rejected.length }} 条不安全的 README 命令</template>
        </div>

        <!-- 依赖：还原写回的是 package.json，装不上重启就会满屏「缺少依赖」，得说清楚 -->
        <div v-if="deps && !deps.ran" class="is-warn">
          {{ deps.reason }}，依赖没装上。Yunzai 用了 pnpm 专有的依赖写法，请先装 pnpm
          （<code>npm i -g pnpm</code>），再到 Yunzai 根目录执行 <code>pnpm install</code>。
        </div>
        <div v-else-if="deps && !deps.ok" class="is-warn">
          依赖安装失败：{{ deps.reason }}。请到 Yunzai 根目录手动执行
          <code>pnpm install</code>，成功后再重启 Bot。
        </div>
        <div v-else-if="deps && !deps.missing?.length">依赖已安装（在 Yunzai 根执行了 pnpm install）。</div>
        <div v-if="deps?.missing?.length" class="is-warn">
          还有 {{ deps.missing.length }} 个声明过的依赖找不到：{{
            deps.missing.map((m) => `${m.name}（${m.from}）`).join('、')
          }}。到 Yunzai 根目录执行 <code>{{ deps.addCmd }}</code>
        </div>
        <div v-if="restoreResult.restartSkipped" class="is-warn">
          依赖没装上，已跳过自动重启 —— 现在重启插件会大面积报缺依赖。
        </div>
        <div v-else>部分插件的配置需要重启 Bot 才会生效。</div>
      </template>
    </a-alert>

    <div v-if="logs.length" ref="logBox" class="g-bk-logs">
      <div v-for="l in logs" :key="l.seq" class="g-bk-log" :class="`is-${l.level}`">{{ l.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.g-bk-task {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--g-border);
  border-radius: 8px;
  background: var(--g-bg-soft);
}

.g-bk-task-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.g-bk-task-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.is-spin {
  animation: g-bk-spin 1.4s linear infinite;
}

@keyframes g-bk-spin {
  to {
    transform: rotate(360deg);
  }
}

.g-bk-task-phase {
  font-size: 12px;
  color: var(--g-brand);
}

.g-bk-task-file {
  margin-left: auto;
  font-size: 12px;
  color: var(--g-text-dim);
  word-break: break-all;
}

.g-bk-task-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-bk-task-alert {
  margin-top: 10px;
}

.g-bk-task-alert :deep(.is-warn) {
  color: var(--g-danger);
}

.g-bk-task-alert :deep(code) {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-elevated);
  font-size: 12px;
}

.g-bk-logs {
  margin-top: 10px;
  max-height: 220px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}

.g-bk-log {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--g-text-sub);
}

.g-bk-log.is-warn {
  color: var(--g-ansi-yellow);
}

.g-bk-log.is-error {
  color: var(--g-danger);
}

.g-bk-log.is-cmd {
  color: var(--g-text-dim);
}

@media (max-width: 768px) {
  /* 文件名挤在标题右边会被压成一列竖排的字，手机上让它独占一行 */
  .g-bk-task-file {
    width: 100%;
    margin-left: 0;
  }

  .g-bk-logs {
    max-height: 180px;
  }
}
</style>
