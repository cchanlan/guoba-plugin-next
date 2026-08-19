<script setup lang="ts">
/**
 * 新建备份。
 *
 * 「只选推荐」按搬家策略选择 Bot 根的 data/config/resources，以及每个插件的 config。
 * 仓库自带的代码默认不打包；插件的 clone 地址从 `.git` 读取并脱敏后写进清单，还原时按候选
 * 地址重新 clone。`.git` 自己是一条独立条目（默认不勾）—— 想离线整份搬走就得勾上它，
 * 否则还原出来的插件目录不是仓库，更新功能对它失效。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiBackupCreate, apiBackupScan, type BackupScan } from '@/api'
import { formatBytes } from '@/utils/format'
import EntryPicker from './EntryPicker.vue'
import TaskPanel from './TaskPanel.vue'
import { useBackupTask } from './useBackupTask'
import type { PickerGroup } from './types'

const emit = defineEmits<{ created: [] }>()

const { task, logs, running, percent, refresh, begin, cancel } = useBackupTask()

const scan = ref<BackupScan | null>(null)
const loading = ref(false)
const picked = ref<string[]>([])
const note = ref('')
const starting = ref(false)

const groups = computed<PickerGroup[]>(() => {
  const data = scan.value
  if (!data) return []
  const out: PickerGroup[] = [
    {
      key: 'root',
      title: 'Bot 本体',
      subtitle: data.root.isRepo ? '' : '不是 git 仓库，只能列出手工识别的内容',
      entries: data.root.entries,
    },
  ]
  for (const p of data.plugins) {
    const at = p.commit ? `@${p.commit.slice(0, 7)}` : ''
    out.push({
      key: `plugin:${p.name}`,
      title: p.name,
      subtitle: p.git
        ? `${p.branch || '?'}${at}`
        : '非 git 插件，整目录备份',
      warn: p.dirty ? '有未提交改动' : p.git && !p.remote ? '没有可克隆地址' : '',
      remotes: p.remotes,
      // 配置和数据不在插件目录里的插件（比如数据存在 Yunzai 根 data/ 下的）没有推荐项，
      // 但仓库自带的文件仍然列得出来 —— 想整个带走随时能勾
      emptyHint: p.git
        ? `这个目录是空的。还原时按 ${p.branch || '默认分支'}${at} 自动 clone 回来。`
        : '这个目录是空的。',
      entries: p.entries,
    })
  }
  return out
})

const total = computed(() => {
  const all = groups.value.flatMap((g) => g.entries)
  const set = new Set(picked.value)
  let size = 0
  for (const e of all) if (set.has(e.key)) size += e.size
  return size
})

async function load(force = false) {
  loading.value = true
  try {
    const data = await apiBackupScan(force)
    scan.value = data
    // 首次进来按推荐项预勾，用户改过之后刷新就不再覆盖他的选择
    if (!picked.value.length) {
      picked.value = [
        ...data.root.entries.filter((e) => e.recommended).map((e) => e.key),
        ...data.plugins.flatMap((p) => p.entries.filter((e) => e.recommended).map((e) => e.key)),
      ]
    }
  } catch {
    // 错误已由请求层弹出
  } finally {
    loading.value = false
  }
}

async function start() {
  if (!picked.value.length) {
    message.warning('先勾选要备份的内容')
    return
  }
  starting.value = true
  try {
    const res = await apiBackupCreate({ keys: picked.value, note: note.value })
    begin(res)
    emit('created')
  } catch {
    // 错误已由请求层弹出
  } finally {
    starting.value = false
  }
}

onMounted(async () => {
  await refresh()
  await load()
})
</script>

<template>
  <div class="g-bk-create">
    <div class="g-bk-tip">
      <p>
        <b>只选推荐</b>是一套搬家默认值：Bot 本体完整选择 <code>data/</code>、
        <code>config/</code>、<code>resources/</code>；插件只选择 <code>config/</code>。
        根配置里的主人、渲染路径、服务地址和锅巴登录字段还原时会保持新机器原样。
      </p>
      <p>
        插件代码默认不进包：扫描会从每个 <code>.git</code> 读取并脱敏全部 HTTP(S) remote，
        还原时逐个尝试 clone，再盖上配置。
      </p>
      <p>
        想离线搬家就把插件整组勾满，其中 <b><code>.git</code> 这一条必须勾上</b>：少了它，
        还原出来的目录只有代码不是仓库，插件再也没法更新。它的体积不小（大插件的
        <code>.git</code> 能有几百 MB），所以默认不勾，勾之前先看一眼列表里的数字。
        <code>.git/config</code> 里的账号密码会在打包时自动摘掉，还原后 push 需要重新填凭证。
      </p>
      <p>
        <code>node_modules</code>、<code>logs</code>、<code>temp</code>
        一律不进包；其它文件都保留在列表中，可按需手动选择。备份包存在服务器
        <code>data/guoba/backups/</code>。
      </p>
    </div>

    <div class="g-bk-bar">
      <a-button size="small" :loading="loading" @click="load(true)">
        <GIcon icon="ant-design:reload-outlined" :size="13" />
        重新扫描
      </a-button>
      <span v-if="scan" class="g-bk-scan-at">
        共 {{ groups.length - 1 }} 个插件 ·
        {{ groups.reduce((n, g) => n + g.entries.length, 0) }} 个条目
      </span>
    </div>

    <a-spin :spinning="loading && !scan">
      <EntryPicker v-model="picked" :groups="groups" has-recommend :disabled="running" />
    </a-spin>

    <div class="g-bk-foot">
      <a-input
        v-model:value="note"
        placeholder="备注（可选，会写进备份包，方便日后辨认）"
        :maxlength="100"
        class="g-bk-note"
      />
      <a-button type="primary" :loading="starting" :disabled="running || !picked.length" @click="start">
        <GIcon icon="ant-design:save-outlined" :size="13" />
        开始备份{{ total ? `（${formatBytes(total)}）` : '' }}
      </a-button>
    </div>

    <TaskPanel
      :task="task"
      :logs="logs"
      :percent="percent"
      :running="running"
      @cancel="cancel"
    />
  </div>
</template>

<style scoped>
.g-bk-tip {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-bk-tip p {
  margin: 0 0 4px;
}

.g-bk-tip code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  font-size: 12px;
}

.g-bk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.g-bk-bar :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-bk-scan-at {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.g-bk-foot :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-bk-note {
  max-width: 420px;
}

@media (max-width: 768px) {
  .g-bk-bar {
    flex-wrap: wrap;
  }

  .g-bk-foot {
    flex-direction: column;
    align-items: stretch;
  }

  .g-bk-note {
    max-width: none;
  }
}
</style>
