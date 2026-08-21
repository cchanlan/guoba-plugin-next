<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Modal,
  Row,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import PluginIcon from './components/PluginIcon.vue'
import UpdatePanel from './components/UpdatePanel.vue'
import GitLogModal from './components/GitLogModal.vue'
import {
  apiGetPlugins,
  apiInstallPlugin,
  apiPluginGitList,
  apiUninstallPlugin,
  type PluginGitInfo,
} from '@/api'
import { sinceText } from './gitText'
import type { PluginItem } from '@/types'

const router = useRouter()

const loading = ref(true)
const refreshing = ref(false)
const plugins = ref<PluginItem[]>([])
const keyword = ref('')
const filter = ref<'all' | 'installed' | 'uninstalled' | 'configurable' | 'updatable'>('all')

const installOpen = ref(false)
const installLink = ref('')
const installing = ref(false)
const autoRestart = ref(true)
const autoNpmInstall = ref(true)

const filterOptions = [
  { label: '全部', value: 'all' },
  { label: '已安装', value: 'installed' },
  { label: '未安装', value: 'uninstalled' },
  { label: '可配置', value: 'configurable' },
  { label: '可更新', value: 'updatable' },
]

const counts = computed(() => ({
  all: plugins.value.length,
  installed: plugins.value.filter((p) => p.installed).length,
  configurable: plugins.value.filter((p) => p.hasConfig).length,
}))

/* ---------------- 更新 ---------------- */

const updatePanel = ref<InstanceType<typeof UpdatePanel> | null>(null)
const gitLog = ref<InstanceType<typeof GitLogModal> | null>(null)
/**
 * 插件目录的 git 状态，key 是小写目录名。
 * 卡片那边的 `name` 未必是目录名（插件可以在 guoba.support.js 里把自己叫「R插件」），
 * 所以要用后端单独给的 `dir` 去对，不然这些插件卡片上就没有分支、更新和日志入口。
 */
const gitMap = ref<Record<string, PluginGitInfo>>({})

/** 有更新的插件（按上次检查的结果算） */
const updatable = computed(() => Object.values(gitMap.value).filter((it) => it.behind > 0))

/**
 * 列表空的时候说点有用的。「可更新」筛不出东西通常不是真没更新，
 * 而是还没检查过（落后数是上次 fetch 的结果）。
 */
const emptyText = computed(() => {
  if (filter.value !== 'updatable') return '没有匹配的插件'
  const checked = Object.values(gitMap.value).some((it) => it.lastFetchAt > 0)
  return checked ? '没有待更新的插件' : '还没检查过，点右上角「检查更新」'
})

function gitOf(p: PluginItem): PluginGitInfo | undefined {
  // 未安装的条目不许蹭同名目录的状态：插件市场里同名 fork 是有的（xianxin-plugin 就占了两条），
  // 不挡住的话「未安装」的卡片上会冒出「本地有改动」和日志入口
  if (!p.installed) return undefined
  return gitMap.value[String(p.dir || p.name).toLowerCase()]
}

async function loadGit() {
  try {
    const items = await apiPluginGitList()
    gitMap.value = Object.fromEntries(items.map((it) => [it.name.toLowerCase(), it]))
  } catch {
    // 读不到就当没有，卡片上不显示 git 信息
    gitMap.value = {}
  }
}

/** 打开更新日志：既是「更新了什么」的入口，也是选版本回滚的入口 */
function openGitLog(p: PluginItem) {
  const info = gitOf(p)
  if (info) gitLog.value?.openLog(info.name)
}

const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return plugins.value.filter((p) => {
    if (filter.value === 'installed' && !p.installed) return false
    if (filter.value === 'uninstalled' && p.installed) return false
    if (filter.value === 'configurable' && !p.hasConfig) return false
    // 「可更新」按上次检查的结果筛，没检查过就是空的（空状态里会提示去检查）
    if (filter.value === 'updatable' && !gitOf(p)?.behind) return false
    if (!kw) return true
    return [p.name, p.title, p.description, authorText(p)]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(kw))
  })
})

function authorText(p: PluginItem) {
  return Array.isArray(p.author) ? p.author.join('、') : (p.author ?? '')
}

async function load(force = false) {
  if (force) refreshing.value = true
  else loading.value = true
  try {
    const res = await apiGetPlugins(force)
    plugins.value = Array.isArray(res) ? res : []
  } catch {
    plugins.value = []
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function openDetail(p: PluginItem) {
  if (!p.hasConfig) return
  router.push(`/plugin/@/${encodeURIComponent(p.name)}`)
}

async function doInstall() {
  const link = installLink.value.trim()
  if (!link) {
    message.warning('请填写仓库地址')
    return
  }
  installing.value = true
  try {
    await apiInstallPlugin({
      link,
      autoRestart: autoRestart.value,
      autoNpmInstall: autoNpmInstall.value,
    })
    installOpen.value = false
    installLink.value = ''
    // 装完通常会重启，这里刷新一次列表尽力保持同步
    load(true)
  } finally {
    installing.value = false
  }
}

function confirmUninstall(p: PluginItem) {
  Modal.confirm({
    title: `卸载 ${p.title || p.name}？`,
    content: '插件目录会被删除，未提交的本地修改会一并丢失。',
    okText: '卸载',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      // 删的是目录，得传目录名：name 可能是插件自己起的展示名，那样后端只会说「插件不存在」
      await apiUninstallPlugin({ name: p.dir || p.name, autoRestart: true })
      load(true)
    },
  })
}

function openLink(link?: string) {
  if (link) window.open(link, '_blank', 'noopener')
}

function installFromCard(p: PluginItem) {
  if (!p.link) {
    message.warning('该插件没有提供仓库地址')
    return
  }
  installLink.value = p.link
  installOpen.value = true
}

onMounted(() => {
  load(false)
  loadGit()
})
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">插件管理</h2>
      <p class="g-page-desc">
        共 {{ counts.all }} 个插件，已安装 {{ counts.installed }} 个，其中 {{ counts.configurable }} 个支持锅巴配置<template v-if="updatable.length">，{{ updatable.length }} 个有更新</template>。
      </p>
    </div>

    <div class="g-toolbar">
      <Input
        v-model:value="keyword"
        placeholder="搜索插件名称、作者或简介"
        allowClear
        class="g-toolbar-search"
      >
        <template #prefix>
          <GIcon icon="ant-design:search-outlined" :size="14" />
        </template>
      </Input>

      <Segmented v-model:value="filter" :options="filterOptions" />

      <Space class="g-toolbar-actions">
        <Tooltip title="强制刷新远程插件列表">
          <Button :loading="refreshing" @click="load(true)">
            <GIcon icon="ant-design:reload-outlined" :size="13" />
          </Button>
        </Tooltip>
        <Tooltip title="逐个 git fetch，看每个插件落后几个提交">
          <Button @click="updatePanel?.startCheck()">
            <GIcon icon="ant-design:sync-outlined" :size="13" />
            <span class="g-btn-text">检查更新</span>
          </Button>
        </Tooltip>
        <Button v-if="updatable.length" type="primary" @click="updatePanel?.openUpdate()">
          <GIcon icon="ant-design:cloud-sync-outlined" :size="14" />
          <span class="g-btn-text">更新 {{ updatable.length }} 个插件</span>
        </Button>
        <Button type="primary" @click="installOpen = true">
          <GIcon icon="ant-design:cloud-download-outlined" :size="14" />
          <span class="g-btn-text">安装插件</span>
        </Button>
      </Space>
    </div>

    <Row v-if="loading" :gutter="[16, 16]">
      <Col v-for="i in 8" :key="i" :xs="24" :sm="12" :lg="8" :xxl="6">
        <Card :bordered="false"><Skeleton active :paragraph="{ rows: 2 }" /></Card>
      </Col>
    </Row>

    <Empty v-else-if="!list.length" :description="emptyText" />

    <Row v-else :gutter="[16, 16]">
      <Col v-for="p in list" :key="p.name" :xs="24" :sm="12" :lg="8" :xxl="6">
        <Card :bordered="false" class="g-plugin-card">
          <div class="g-plugin-top">
            <PluginIcon :plugin="p" :size="38" />
            <div class="g-plugin-meta">
              <div class="g-plugin-name">
                <span class="g-plugin-title">{{ p.title || p.name }}</span>
                <Badge v-if="p.installed" status="success" />
              </div>
              <div class="g-plugin-author">{{ authorText(p) || '未知作者' }}</div>
            </div>
          </div>

          <p class="g-plugin-desc">{{ p.description || '暂无简介' }}</p>

          <div class="g-plugin-tags">
            <Tag v-if="p.installed" color="green">已安装</Tag>
            <Tag v-else>未安装</Tag>
            <Tag v-if="p.hasConfig" color="gold">可配置</Tag>
            <Tag v-if="p.isDeleted" color="red">已废弃</Tag>
            <Tag v-if="gitOf(p)?.behind" color="orange">可更新 {{ gitOf(p)!.behind }}</Tag>
            <Tooltip v-if="gitOf(p)?.dirty" :title="gitOf(p)!.changed.map((c) => c.file).join('、')">
              <Tag color="red">本地有改动</Tag>
            </Tooltip>
          </div>

          <!-- git 信息：分支 / 当前提交 / 上次检查时间，非 git 仓库说明原因 -->
          <div v-if="p.installed && gitOf(p)" class="g-plugin-git">
            <template v-if="gitOf(p)!.updatable">
              <GIcon icon="ant-design:branches-outlined" :size="12" />
              <span>{{ gitOf(p)!.branch }}</span>
              <code>{{ gitOf(p)!.shortCommit }}</code>
              <span class="g-plugin-git-dim">{{ sinceText(gitOf(p)!.lastFetchAt) }}</span>
            </template>
            <Tooltip v-else :title="gitOf(p)!.reason">
              <span class="g-plugin-git-dim">
                <GIcon icon="ant-design:info-circle-outlined" :size="12" />
                不能自动更新
              </span>
            </Tooltip>
          </div>

          <!-- 当前装的是哪一版：提交标题一行截断，下面跟作者和时间 -->
          <div v-if="p.installed && gitOf(p)?.lastCommit" class="g-plugin-commit">
            <div class="g-plugin-commit-subject" :title="gitOf(p)!.lastCommit!.subject">
              {{ gitOf(p)!.lastCommit!.subject }}
            </div>
            <div class="g-plugin-commit-meta">
              {{ gitOf(p)!.lastCommit!.author }} · {{ gitOf(p)!.lastCommit!.date }}
            </div>
          </div>

          <div class="g-plugin-actions">
            <!-- 按钮最多能凑到 5 个（配置 / 更新 / 日志 / 卸载 / 仓库），手机上要能换行 -->
            <Space :size="6" wrap>
              <Button
                v-if="p.hasConfig"
                type="primary"
                size="small"
                @click="openDetail(p)"
              >
                配置
              </Button>
              <Button
                v-if="!p.installed"
                size="small"
                :disabled="!p.link"
                @click="installFromCard(p)"
              >
                安装
              </Button>
              <Button
                v-if="gitOf(p)?.behind"
                size="small"
                type="primary"
                ghost
                @click="updatePanel?.openUpdate([gitOf(p)!.name])"
              >
                更新
              </Button>
              <Button
                v-if="p.installed && gitOf(p)?.isRepo"
                size="small"
                @click="openGitLog(p)"
              >
                日志
              </Button>
              <Button
                v-if="p.installed && (p.dir || p.name) !== 'miao-plugin'"
                size="small"
                danger
                @click="confirmUninstall(p)"
              >
                卸载
              </Button>
              <Button v-if="p.link" size="small" type="text" @click="openLink(p.link)">
                <GIcon icon="ant-design:github-outlined" :size="14" />
              </Button>
            </Space>
          </div>
        </Card>
      </Col>
    </Row>

    <Modal
      v-model:open="installOpen"
      title="从 Git 仓库安装插件"
      ok-text="开始安装"
      cancel-text="取消"
      :confirm-loading="installing"
      @ok="doInstall"
    >
      <Alert
        type="info"
        show-icon
        class="g-install-alert"
        message="只允许安装白名单域名下的仓库"
        description="默认白名单为 github.com、gitee.com、gitlab.com、gitcode.com，可在基础配置里调整。"
      />
      <Input
        v-model:value="installLink"
        placeholder="https://github.com/xxx/xxx-plugin"
        allowClear
      />
      <div class="g-install-opts">
        <Checkbox v-model:checked="autoNpmInstall">自动安装依赖</Checkbox>
        <Checkbox v-model:checked="autoRestart">安装完成后重启 Bot</Checkbox>
      </div>
    </Modal>

    <!-- 检查更新 / 更新的弹窗，进度和结果都在里面 -->
    <UpdatePanel ref="updatePanel" :items="Object.values(gitMap)" @refresh="loadGit" />

    <!-- 更新日志 + 选版本回滚。要检查更新就把这个关掉，交给上面的更新面板 -->
    <GitLogModal
      ref="gitLog"
      @refresh="loadGit"
      @check="(name) => updatePanel?.startCheck([name])"
    />
  </div>
</template>

<style scoped>
/* git 信息条：分支 + 短 hash + 上次检查时间，字号压小，不跟标签抢注意力 */
.g-plugin-git {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-plugin-git code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
}

.g-plugin-git-dim {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--g-text-dim);
}

/* 当前版本那条提交：标题裁成一行，保证卡片高度还是齐的 */
.g-plugin-commit {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--g-bg-soft);
}

.g-plugin-commit-subject {
  font-size: 12px;
  line-height: 1.5;
  color: var(--g-text-sub);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-plugin-commit-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--g-text-dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.g-page-head {
  margin-bottom: 14px;
}

.g-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.g-toolbar-search {
  width: 260px;
}

.g-toolbar-actions {
  margin-left: auto;
}

.g-btn-text {
  margin-left: 5px;
}

.g-plugin-card {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.g-plugin-card :deep(.ant-card-body) {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.g-plugin-top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.g-plugin-meta {
  min-width: 0;
}

.g-plugin-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.g-plugin-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--g-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-plugin-author {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-plugin-desc {
  margin: 12px 0 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--g-text-sub);
  /* 简介长短不一，统一裁到两行以保持卡片高度一致 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.g-plugin-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}

.g-plugin-actions {
  margin-top: auto;
}

.g-install-alert {
  margin-bottom: 12px;
}

.g-install-opts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
</style>
