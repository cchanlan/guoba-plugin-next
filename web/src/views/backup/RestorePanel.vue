<script setup lang="ts">
/**
 * 还原。
 *
 * 顺序是后端定的：**先 clone 插件，再写文件** —— 反过来的话插件目录已经有文件了，
 * `git clone` 到非空目录会失败。装不上的插件，它的文件不会丢，暂存到
 * `data/guoba/backups/.pending-restore/`，装好插件后再还原一次即可。
 *
 * 被覆盖的原文件一律先挪进 `.restore-bak-<时间戳>/`，还原错了能捞回来。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiBackupInspect,
  apiBackupList,
  apiBackupRestore,
  type BackupFile,
  type BackupInspect,
  type BackupManifestEntry,
} from '@/api'
import { formatBytes } from '@/utils/format'
import EntryPicker from './EntryPicker.vue'
import TaskPanel from './TaskPanel.vue'
import { useBackupTask } from './useBackupTask'
import type { PickerEntry, PickerGroup } from './types'

const props = defineProps<{ file?: string }>()

const { task, logs, running, percent, refresh, begin, cancel } = useBackupTask()

const packs = ref<BackupFile[]>([])
const file = ref<string>(props.file ?? '')
const info = ref<BackupInspect | null>(null)
const loading = ref(false)
const picked = ref<string[]>([])
const pickedPlugins = ref<string[]>([])
const autoNpmInstall = ref(true)
const autoRestart = ref(false)
const starting = ref(false)

const manifest = computed(() => info.value?.manifest ?? null)

const pluginByName = computed(() => new Map((manifest.value?.plugins ?? []).map((p) => [p.name, p])))

function toPicker(e: BackupManifestEntry): PickerEntry {
  return { key: e.key, rel: e.rel, size: e.size, files: e.files }
}

const groups = computed<PickerGroup[]>(() => {
  const m = manifest.value
  if (!m) return []
  const byTarget = new Map<string, BackupManifestEntry[]>()
  for (const e of m.entries ?? []) {
    const list = byTarget.get(e.target) ?? []
    list.push(e)
    byTarget.set(e.target, list)
  }
  const out: PickerGroup[] = []
  const rootEntries = byTarget.get('root')
  if (rootEntries?.length) {
    out.push({ key: 'root', title: 'Bot 本体', entries: rootEntries.map(toPicker) })
  }
  for (const [target, list] of byTarget) {
    if (target === 'root') continue
    const name = target.startsWith('plugin:') ? target.slice('plugin:'.length) : target
    const p = pluginByName.value.get(name)
    out.push({
      key: target,
      title: name,
      subtitle: p?.branch ? `${p.branch}${p.commit ? `@${p.commit.slice(0, 7)}` : ''}` : '',
      warn: p && !p.installed ? '本地未安装' : '',
      entries: list.map(toPicker),
    })
  }
  return out
})

/** 包里有清单、本地没装的插件 —— 这些才需要 clone */
const missingPlugins = computed(() => (manifest.value?.plugins ?? []).filter((p) => !p.installed))

/** 勾了条目、插件却既没装也没勾安装的：文件会被暂存起来，提前说清楚 */
const willPending = computed(() => {
  const keys = new Set(picked.value)
  const clone = new Set(pickedPlugins.value)
  const out: string[] = []
  for (const g of groups.value) {
    if (!g.key.startsWith('plugin:')) continue
    const name = g.key.slice('plugin:'.length)
    const p = pluginByName.value.get(name)
    if (p?.installed || clone.has(name)) continue
    if (g.entries.some((e) => keys.has(e.key))) out.push(name)
  }
  return out
})

async function loadPacks() {
  try {
    packs.value = await apiBackupList()
    if (!file.value && packs.value.length) file.value = packs.value[0].name
  } catch {
    // 错误已由请求层弹出
  }
}

/** 本地没装、地址也过得了白名单的 —— 只有这些勾了才有意义 */
function installableNames(list = manifest.value?.plugins ?? []) {
  return list
    .filter((p) => !p.installed && p.allowed !== false && (p.remote || p.noGit))
    .map((p) => p.name)
}

async function loadInfo() {
  if (!file.value) {
    info.value = null
    return
  }
  loading.value = true
  try {
    const data = await apiBackupInspect(file.value)
    info.value = data
    // 默认全选条目：都选这个包了，多半是想整包还原
    picked.value = (data.manifest.entries ?? []).map((e) => e.key)
    pickedPlugins.value = installableNames(data.manifest.plugins ?? [])
  } catch {
    info.value = null
  } finally {
    loading.value = false
  }
}

function togglePlugin(name: string, checked: boolean) {
  const next = new Set(pickedPlugins.value)
  if (checked) next.add(name)
  else next.delete(name)
  pickedPlugins.value = [...next]
}

function confirmStart() {
  if (!file.value) {
    message.warning('先选一个备份包')
    return
  }
  if (!picked.value.length && !pickedPlugins.value.length) {
    message.warning('先勾选要还原的内容')
    return
  }
  Modal.confirm({
    title: '确认还原？',
    width: 520,
    content: () => [
      `将写入 ${picked.value.length} 个条目`
      + (pickedPlugins.value.length ? `，并安装 ${pickedPlugins.value.length} 个插件。` : '。'),
      '同名文件会被覆盖，覆盖前原文件会挪到 data/guoba/backups/.restore-bak-<时间戳>/。',
      autoRestart.value ? '完成后会重启 Bot，机器人会短暂离线。' : '部分配置需要手动重启 Bot 才生效。',
    ].join(' '),
    okText: '开始还原',
    okType: 'danger',
    cancelText: '取消',
    onOk: start,
  })
}

async function start() {
  starting.value = true
  try {
    const res = await apiBackupRestore({
      file: file.value,
      keys: picked.value,
      plugins: pickedPlugins.value,
      autoNpmInstall: autoNpmInstall.value,
      autoRestart: autoRestart.value,
    })
    begin(res)
  } catch {
    // 错误已由请求层弹出
  } finally {
    starting.value = false
  }
}

watch(() => props.file, (val) => {
  if (val && val !== file.value) {
    file.value = val
  }
})

watch(file, loadInfo)

onMounted(async () => {
  await refresh()
  await loadPacks()
  await loadInfo()
})
</script>

<template>
  <div class="g-bk-restore">
    <div class="g-bk-tip">
      <p>
        还原会<b>覆盖同名文件</b>，被覆盖的原文件先挪到
        <code>data/guoba/backups/.restore-bak-&lt;时间戳&gt;/</code>，出问题能捞回来。
      </p>
      <p>
        本地没装的插件按包里的清单 <code>git clone</code>（地址要在 Git 安装白名单内）。
        如果备份时是<b>整个插件</b>一起打包的，包里已经有完整文件了，clone 失败也会直接
        按文件还原 —— Windows 上 clone GitHub 老是 SSL 报错时，这条路更稳。
      </p>
      <p>
        既没装上、包里也只有配置数据的插件，它的文件会暂存到 <code>.pending-restore/</code>，
        等插件装好后再还原一次即可，不会丢。
      </p>
    </div>

    <div class="g-bk-bar">
      <a-select
        v-model:value="file"
        class="g-bk-select"
        placeholder="选择备份包"
        :options="packs.map((p) => ({
          value: p.name,
          label: `${p.name}${p.summary?.note ? ` — ${p.summary.note}` : ''}`,
        }))"
        show-search
        :disabled="running"
      />
      <a-button size="small" :loading="loading" @click="loadInfo">
        <GIcon icon="ant-design:reload-outlined" :size="13" />
        重新读取
      </a-button>
    </div>

    <a-spin :spinning="loading">
      <template v-if="manifest">
        <a-descriptions size="small" bordered :column="{ xs: 1, sm: 2, md: 3 }" class="g-bk-desc">
          <a-descriptions-item label="创建时间">
            {{ manifest.createdAt ? new Date(manifest.createdAt).toLocaleString() : '—' }}
          </a-descriptions-item>
          <a-descriptions-item label="内容">
            {{ manifest.entries?.length ?? 0 }} 个条目 · {{ manifest.totalFiles }} 个文件 ·
            {{ formatBytes(manifest.totalSize) }}
          </a-descriptions-item>
          <a-descriptions-item label="来源">
            {{ manifest.bot?.name || '?' }} {{ manifest.bot?.version }}
            <span v-if="manifest.bot?.guobaVersion">/ 锅巴 {{ manifest.bot.guobaVersion }}</span>
          </a-descriptions-item>
          <a-descriptions-item v-if="manifest.note" label="备注" :span="3">
            {{ manifest.note }}
          </a-descriptions-item>
        </a-descriptions>

        <h4 class="g-bk-h4">要还原的内容</h4>
        <EntryPicker v-model="picked" :groups="groups" :disabled="running" />

        <h4 class="g-bk-h4">
          要安装的插件
          <span class="g-bk-h4-sub">
            共 {{ manifest.plugins?.length ?? 0 }} 个，其中 {{ missingPlugins.length }} 个本地没装
          </span>
          <span class="g-bk-h4-acts">
            <a-button
              size="small"
              :disabled="running"
              title="勾上所有本地没装、地址又在白名单里的插件"
              @click="pickedPlugins = installableNames()"
            >
              全选可装
            </a-button>
            <a-button size="small" :disabled="running" @click="pickedPlugins = []">清空</a-button>
            <span class="g-bk-h4-sub">已选 {{ pickedPlugins.length }} 个</span>
          </span>
        </h4>
        <div v-if="!manifest.plugins?.length" class="g-bk-empty">这个包里没有插件清单</div>
        <div v-else class="g-bk-plugins">
          <div v-for="p in manifest.plugins" :key="p.name" class="g-bk-plugin">
            <a-checkbox
              :checked="pickedPlugins.includes(p.name)"
              :disabled="running || p.installed || p.allowed === false || (!p.remote && !p.noGit)"
              @change="togglePlugin(p.name, ($event.target as HTMLInputElement).checked)"
            >
              <span class="g-bk-pname">{{ p.name }}</span>
            </a-checkbox>
            <a-tag v-if="p.installed" color="green">已安装</a-tag>
            <a-tag v-else-if="p.allowed === false" color="red">不在白名单</a-tag>
            <a-tag v-else-if="!p.remote && !p.noGit" color="orange">没有仓库地址</a-tag>
            <a-tag v-else color="blue">待安装</a-tag>
            <span v-if="p.branch" class="g-bk-pbranch">{{ p.branch }}</span>
            <span class="g-bk-premote" :title="p.remote">{{ p.remote || '（无远程地址）' }}</span>
          </div>
        </div>

        <a-alert
          v-if="willPending.length"
          type="warning"
          show-icon
          class="g-bk-alert"
          :message="`${willPending.join('、')} 没装也没勾选安装，它们的文件会暂存到 .pending-restore/ 而不会写进插件目录`"
        />

        <div class="g-bk-opts">
          <a-checkbox v-model:checked="autoNpmInstall" :disabled="running">
            新装插件后执行 pnpm install
          </a-checkbox>
          <a-checkbox v-model:checked="autoRestart" :disabled="running">
            完成后重启 Bot（会短暂离线）
          </a-checkbox>
        </div>

        <div class="g-bk-foot">
          <a-button type="primary" danger :loading="starting" :disabled="running" @click="confirmStart">
            <GIcon icon="ant-design:rollback-outlined" :size="13" />
            开始还原
          </a-button>
        </div>
      </template>
      <a-empty v-else-if="!loading" :image="false" description="选一个备份包，或先去「备份管理」上传一个" />
    </a-spin>

    <TaskPanel :task="task" :logs="logs" :percent="percent" :running="running" @cancel="cancel" />
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

.g-bk-tip code,
.g-bk-restore :deep(code) {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  font-size: 12px;
}

.g-bk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.g-bk-restore :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-bk-select {
  width: 420px;
  max-width: 100%;
}

.g-bk-desc {
  margin-bottom: 14px;
}

.g-bk-h4 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.g-bk-h4-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--g-text-dim);
}

.g-bk-h4-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.g-bk-plugins {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 2px 16px;
}

.g-bk-plugin {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  min-width: 0;
}

.g-bk-pname {
  font-weight: 500;
}

.g-bk-pbranch {
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-bk-premote {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--g-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.g-bk-empty {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-alert {
  margin-top: 12px;
}

.g-bk-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
}

.g-bk-foot {
  margin-top: 14px;
}

@media (max-width: 768px) {
  .g-bk-select {
    width: 100%;
  }

  /* 标题和按钮挤一行放不下，按钮整行换到下面 */
  .g-bk-h4 {
    flex-wrap: wrap;
  }

  .g-bk-h4-acts {
    margin-left: 0;
    width: 100%;
  }

  .g-bk-plugins {
    grid-template-columns: 1fr;
  }

  /* 一行放不下「勾选 + 状态 + 分支 + 地址」，让地址换到第二行去 */
  .g-bk-plugin {
    flex-wrap: wrap;
  }

  .g-bk-premote {
    flex: 0 0 100%;
    padding-left: 24px;
  }

  /* bordered 的 descriptions 在窄屏标签列会挤成一列字 */
  .g-bk-desc :deep(.ant-descriptions-item-label) {
    width: 84px;
    word-break: keep-all;
  }
}
</style>
