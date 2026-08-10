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
import { apiGetPlugins, apiInstallPlugin, apiUninstallPlugin } from '@/api'
import type { PluginItem } from '@/types'

const router = useRouter()

const loading = ref(true)
const refreshing = ref(false)
const plugins = ref<PluginItem[]>([])
const keyword = ref('')
const filter = ref<'all' | 'installed' | 'uninstalled' | 'configurable'>('all')

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
]

const counts = computed(() => ({
  all: plugins.value.length,
  installed: plugins.value.filter((p) => p.installed).length,
  configurable: plugins.value.filter((p) => p.hasConfig).length,
}))

const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return plugins.value.filter((p) => {
    if (filter.value === 'installed' && !p.installed) return false
    if (filter.value === 'uninstalled' && p.installed) return false
    if (filter.value === 'configurable' && !p.hasConfig) return false
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
      await apiUninstallPlugin({ name: p.name, autoRestart: true })
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

onMounted(() => load(false))
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">插件管理</h2>
      <p class="g-page-desc">
        共 {{ counts.all }} 个插件，已安装 {{ counts.installed }} 个，其中 {{ counts.configurable }} 个支持锅巴配置。
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

    <Empty v-else-if="!list.length" description="没有匹配的插件" />

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
          </div>

          <div class="g-plugin-actions">
            <Space :size="6">
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
                v-if="p.installed && p.name !== 'miao-plugin'"
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
  </div>
</template>

<style scoped>
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
