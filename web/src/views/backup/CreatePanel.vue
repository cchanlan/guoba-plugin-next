<script setup lang="ts">
/**
 * 新建备份。
 *
 * 勾什么由 git 说话 —— 后端只列被 .gitignore 忽略、未跟踪、或改过的文件（详见
 * server/utils/backupDiscover.js），仓库自带的素材和 `.git` 都不打包，插件靠清单
 * 在还原时重新 clone。所以「推荐项」通常只有几百 MB，而不是几个 G。
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
      warn: p.dirty ? '有未提交改动' : p.git && !p.remote ? '没有远程地址' : '',
      // 配置和数据不在插件目录里的插件（比如数据存在 Yunzai 根 data/ 下的）一个条目都没有，
      // 说清楚「不是不能备份，是不用备份」，否则看着勾不动会以为漏了
      emptyHint: p.git
        ? `没有需要备份的文件 —— 它的配置和数据不在插件目录里（多半在 Bot 本体的 data/ 下）。还原时按 ${p.branch || '默认分支'}${at} 自动 clone 回来，跟现在一模一样。`
        : '没有需要备份的文件。',
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
        备份内容由 git 判定：只收<b>被忽略、未跟踪、以及你改过</b>的文件 ——
        也就是配置、数据、自备素材。插件的 <code>.git</code> 和仓库自带资源都不打包，
        改为记下仓库地址，还原时自动 <code>git clone</code> 回来。
      </p>
      <p>
        <b>所有已装插件都会写进包里的清单</b>（仓库地址 + 分支 + 提交号），还原时一键拉回来。
        下面的勾选框只决定它的<b>文件</b>要不要一起带走 —— 标着「仅清单」勾不动的插件，
        是因为它的配置数据压根不在插件目录里，clone 就能完全恢复。
      </p>
      <p>
        大目录已按子目录拆开，缓存类（<code>temp</code>、<code>puppeteer</code> 之类）默认不勾。
        备份包存在服务器 <code>data/guoba/backups/</code>，可在「备份管理」里下载。
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
