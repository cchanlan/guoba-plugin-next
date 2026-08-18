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
/** 插件名 → 手动指定的 clone URL；空串 / 不存在表示按清单自动尝试 */
const cloneRemotes = ref<Record<string, string>>({})
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

/** 装得上的：本地没装、地址也过得了白名单。「全选可装」按钮用这个 */
function installableNames(list = manifest.value?.plugins ?? []) {
  return list
    .filter((p) => !p.installed && p.allowed !== false && (remotesOf(p).length || p.noGit))
    .map((p) => p.name)
}

/**
 * 进页面时默认勾哪些。
 *
 * 只勾「备份时确实带了它文件」的（manifest 里 keys 非空）—— 备份时压根没选的插件默认全勾上，
 * 等于每次还原都得手动取消一遍。想把清单里的插件全装回来，点「全选可装」。
 */
function defaultPluginNames(list = manifest.value?.plugins ?? []) {
  const installable = new Set(installableNames(list))
  return list.filter((p) => installable.has(p.name) && p.keys?.length).map((p) => p.name)
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
    // 手选 URL 只属于当前包，重新读取 / 切包都回到安全的自动模式
    cloneRemotes.value = {}
    // 默认全选条目：都选这个包了，多半是想整包还原
    picked.value = (data.manifest.entries ?? []).map((e) => e.key)
    pickedPlugins.value = defaultPluginNames(data.manifest.plugins ?? [])
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

/** 新包有 remotes，旧包只有 remote；展示层统一成数组 */
function remotesOf(p: NonNullable<typeof manifest.value>['plugins'][number]) {
  if (p.remotes?.length) return p.remotes
  return p.remote ? [{ name: 'origin', url: p.remote, allowed: p.allowed }] : []
}

function remoteHost(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function remoteOptions(p: NonNullable<typeof manifest.value>['plugins'][number]) {
  const list = remotesOf(p)
  const names = list.map((r) => r.name || remoteHost(r.url)).join(' → ')
  return [
    {label: `自动尝试${names ? `（${names}）` : ''}`, value: ''},
    ...list.map((r) => ({
      label: `${r.name || 'remote'} · ${remoteHost(r.url)}${r.allowed === false ? '（不在白名单）' : ''}`,
      value: r.url,
      disabled: r.allowed === false,
      title: r.url,
    })),
  ]
}

/** 未安装插件直接显示来源选择器；未勾选安装时禁用，避免用户不知道选项藏在哪儿 */
function canPickRemote(p: NonNullable<typeof manifest.value>['plugins'][number]) {
  return !p.installed && remotesOf(p).length > 0
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
      Object.values(cloneRemotes.value).filter(Boolean).length
        ? `其中 ${Object.values(cloneRemotes.value).filter(Boolean).length} 个插件手动指定了仓库来源，失败后不会自动换源。`
        : '',
      autoNpmInstall.value ? '之后会逐插件安全安装依赖，最后在 Yunzai 根执行 pnpm install，可能需要几分钟。' : '',
      autoRestart.value ? '完成后会重启 Bot，机器人会短暂离线。' : '部分配置需要手动重启 Bot 才生效。',
    ].filter(Boolean).join(' '),
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
      cloneRemotes: Object.fromEntries(
        Object.entries(cloneRemotes.value).filter(([name, url]) => pickedPlugins.value.includes(name) && url),
      ),
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
        插件代码默认不进包；备份时会从插件 <code>.git</code> 读取并脱敏全部可克隆地址，
        还原时按顺序尝试。<code>.git</code> 本身不会写进包，避免把 Git 历史和凭据带走。
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
      <p>
        备份包里带的是 <code>package.json</code> 而不是 <code>node_modules</code>，所以还原完
        <b>一定要装依赖</b>（默认已勾上）—— 少了这一步，重启后插件会满屏报
        <code>Cannot find package 'xxx'</code>。
      </p>
      <p>
        插件代码默认不进包；备份时会从插件 <code>.git</code> 读取并脱敏全部可克隆地址，
        还原时按顺序尝试。<code>.git</code> 本身不会写进包，避免把 Git 历史和凭据带走。
      </p>
      <p>
        <b>备份包内容是完整的</b>（Redis 配置、各账号 ck、黑白名单全都在），但还原时有几项
        会<b>保持本机原样</b> —— 主人绑定（<code>masterQQ</code>）、
        <code>chromium_path</code>、对外访问地址、pm2 配置、以及锅巴自己的账号密码。
        换了机器或换了 bot 号，这些盖过去只会让 bot 不认主人、渲染崩掉、把你踢回登录页。
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
            <a-button
              size="small"
              :disabled="running"
              title="只勾备份时带了文件的那些"
              @click="pickedPlugins = defaultPluginNames()"
            >
              只选备份过的
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
              :disabled="running || p.installed || p.allowed === false || (!remotesOf(p).length && !p.noGit)"
              @change="togglePlugin(p.name, ($event.target as HTMLInputElement).checked)"
            >
              <span class="g-bk-pname">{{ p.name }}</span>
            </a-checkbox>
            <a-tag v-if="p.installed" color="green">已安装</a-tag>
            <a-tag v-else-if="p.allowed === false" color="red">不在白名单</a-tag>
            <a-tag v-else-if="!remotesOf(p).length && !p.noGit" color="orange">没有仓库地址</a-tag>
            <a-tag v-else color="blue">待安装</a-tag>
            <!-- 备份时勾了它的文件才默认勾上，否则每次还原都要手动取消一遍 -->
            <a-tag v-if="p.keys?.length" color="cyan">包里有文件</a-tag>
            <a-tag v-else>仅清单</a-tag>
            <span v-if="p.branch" class="g-bk-pbranch">{{ p.branch }}</span>
            <span
              class="g-bk-premote"
              :title="remotesOf(p).map((r) => `${r.name || 'remote'}: ${r.url}`).join('\\n')"
            >
              {{ remotesOf(p).map((r) => r.url).join(' · ') || '（无可克隆地址）' }}
            </span>
            <div v-if="canPickRemote(p)" class="g-bk-remote-picker">
              <span class="g-bk-remote-label">克隆来源</span>
              <span class="g-bk-remote-count">{{ remotesOf(p).length }} 个地址</span>
              <a-select
                v-model:value="cloneRemotes[p.name]"
                size="small"
                class="g-bk-remote-select"
                :disabled="running || !pickedPlugins.includes(p.name)"
                :options="remoteOptions(p)"
                option-label-prop="label"
              />
              <span v-if="cloneRemotes[p.name]" class="g-bk-remote-tip">
                手动指定，失败后不自动换源
              </span>
            </div>
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
            还原后安装依赖（在 Yunzai 根执行 pnpm install）
          </a-checkbox>
          <a-checkbox v-model:checked="autoRestart" :disabled="running">
            完成后重启 Bot（会短暂离线）
          </a-checkbox>
        </div>
        <div class="g-bk-opts-tip">
          每个插件落地后会先按 package.json 安装，并安全识别 README 里的依赖命令；脚本、管道、
          全局安装等不安全命令只记录不执行。全部插件完成后还会在 Yunzai 根执行一次 pnpm install
          收敛 workspace，视网络可能要几分钟。依赖没装齐时不会自动重启。
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

.g-bk-remote-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 100%;
  min-width: 0;
  padding-left: 24px;
}

.g-bk-remote-label,
.g-bk-remote-count,
.g-bk-remote-tip {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-remote-select {
  min-width: 220px;
  max-width: 360px;
}

.g-bk-remote-tip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.g-bk-opts-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--g-text-dim);
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
    overflow-wrap: anywhere;
  }

  .g-bk-remote-picker {
    padding-left: 24px;
    flex-wrap: wrap;
  }

  .g-bk-remote-select {
    flex: 1 1 100%;
    min-width: 0;
    max-width: none;
  }

  /* bordered 的 descriptions 在窄屏标签列会挤成一列字 */
  .g-bk-desc :deep(.ant-descriptions-item-label) {
    width: 84px;
    word-break: keep-all;
  }
}
</style>
