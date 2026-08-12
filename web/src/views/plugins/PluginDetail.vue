<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Alert,
  Button,
  Card,
  Empty,
  Result,
  Skeleton,
  Space,
  Tag,
  message,
} from 'ant-design-vue'
import SchemaForm from '@/components/schema-form/SchemaForm.vue'
import { PLUGIN_NAME_KEY } from '@/components/schema-form/context'
import GIcon from '@/components/GIcon.vue'
import PluginIcon from './components/PluginIcon.vue'
import PluginReadme from './components/PluginReadme.vue'
import { apiGetPluginConfig, apiGetPlugins, apiSetPluginConfig } from '@/api'
import { structuredCloneSafe } from '@/utils/schema'
import type { PluginItem } from '@/types'

const route = useRoute()
const router = useRouter()

const pluginName = computed(() => String(route.params.name ?? ''))
// 供 GButtons 调用 action 用
provide(PLUGIN_NAME_KEY, pluginName)

const formRef = ref<InstanceType<typeof SchemaForm> | null>(null)
const loading = ref(true)
const saving = ref(false)
const plugin = ref<PluginItem | null>(null)
const data = ref<Record<string, any>>({})
const loadError = ref('')
const showReadme = ref(false)

const authorText = computed(() => {
  const a = plugin.value?.author
  return Array.isArray(a) ? a.join('、') : (a ?? '')
})

const schemas = computed(() => plugin.value?.schemas ?? [])

async function load() {
  loading.value = true
  loadError.value = ''
  plugin.value = null
  try {
    // 插件元信息（含 schemas）在列表接口里，配置数据在插件自己的接口里
    const [list, cfg] = await Promise.all([
      apiGetPlugins(false),
      apiGetPluginConfig(pluginName.value).catch((e) => {
        loadError.value = e?.message || '配置数据读取失败'
        return {}
      }),
    ])
    const found = (Array.isArray(list) ? list : []).find((p) => p.name === pluginName.value)
    if (!found) {
      loadError.value = `未找到插件「${pluginName.value}」`
      return
    }
    plugin.value = found
    data.value = cfg && typeof cfg === 'object' ? cfg : {}
  } catch (e: any) {
    loadError.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function save() {
  const form = formRef.value
  if (!form) return
  try {
    await form.validate()
  } catch {
    message.warning('请先修正表单中的错误')
    return
  }
  saving.value = true
  try {
    await apiSetPluginConfig(pluginName.value, structuredCloneSafe(form.getValues()))
  } finally {
    saving.value = false
  }
}

function openRepo() {
  if (plugin.value?.link) window.open(plugin.value.link, '_blank', 'noopener')
}

watch(pluginName, load, { immediate: true })
</script>

<template>
  <div class="g-page">
    <Skeleton v-if="loading" active :paragraph="{ rows: 6 }" />

    <Result
      v-else-if="!plugin"
      status="404"
      title="插件不存在"
      :sub-title="loadError"
    >
      <template #extra>
        <Button type="primary" @click="router.push('/plugins')">返回插件列表</Button>
      </template>
    </Result>

    <template v-else>
      <Card :bordered="false" class="g-detail-head">
        <div class="g-detail-top">
          <PluginIcon :plugin="plugin" :size="52" />

          <div class="g-detail-meta">
            <div class="g-detail-title-row">
              <h2 class="g-detail-title">{{ plugin.title || plugin.name }}</h2>
              <Tag v-if="plugin.installed" color="green">已安装</Tag>
              <Tag v-if="plugin.hasConfig" color="gold">可配置</Tag>
            </div>
            <p class="g-detail-desc">{{ plugin.description || '暂无简介' }}</p>
            <div class="g-detail-sub">
              <span>{{ authorText || '未知作者' }}</span>
              <span class="g-detail-dot">·</span>
              <span>{{ plugin.name }}</span>
            </div>
          </div>

          <Space class="g-detail-actions">
            <Button v-if="plugin.link" @click="openRepo">
              <GIcon icon="ant-design:github-outlined" :size="14" />
              <span class="g-btn-text">仓库</span>
            </Button>
            <Button v-if="plugin.link" @click="showReadme = !showReadme">
              <GIcon icon="ant-design:file-text-outlined" :size="14" />
              <span class="g-btn-text">{{ showReadme ? '收起说明' : '查看说明' }}</span>
            </Button>
          </Space>
        </div>
      </Card>

      <PluginReadme v-if="showReadme && plugin.link" :link="plugin.link" />

      <Alert
        v-if="loadError"
        type="warning"
        show-icon
        class="g-detail-alert"
        :message="loadError"
      />

      <Card :bordered="false">
        <template #title>
          <span class="g-cfg-title">插件配置</span>
        </template>
        <template #extra>
          <Space>
            <Button size="small" :disabled="saving" @click="load">
              <GIcon icon="ant-design:reload-outlined" :size="13" />
            </Button>
            <Button
              type="primary"
              size="small"
              :loading="saving"
              :disabled="!schemas.length"
              @click="save"
            >
              保存
            </Button>
          </Space>
        </template>

        <Empty v-if="!schemas.length" description="该插件没有提供可视化配置项" />
        <SchemaForm v-else ref="formRef" :schemas="schemas" :data="data" />
      </Card>
    </template>
  </div>
</template>

<style scoped>
.g-detail-head {
  margin-bottom: 16px;
}

.g-detail-top {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.g-detail-meta {
  flex: 1;
  min-width: 0;
}

.g-detail-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.g-detail-title {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  color: var(--g-text);
}

.g-detail-desc {
  margin: 6px 0 4px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-detail-sub {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-detail-dot {
  margin: 0 6px;
}

.g-detail-actions {
  flex-shrink: 0;
}

.g-detail-alert {
  margin-bottom: 16px;
}

.g-cfg-title {
  font-size: 15px;
  font-weight: 600;
}

.g-btn-text {
  margin-left: 5px;
}

@media (max-width: 720px) {
  .g-detail-top {
    flex-wrap: wrap;
    gap: 12px;
  }

  /* 文字区占满图标旁剩余宽度，避免被按钮挤成一列一个字 */
  .g-detail-meta {
    flex: 1 1 calc(100% - 64px);
  }

  .g-detail-title {
    font-size: 17px;
  }

  /* 按钮换到单独一行 */
  .g-detail-actions {
    width: 100%;
  }

  .g-detail-actions :deep(.ant-btn) {
    flex: 1;
  }

  .g-detail-actions :deep(.ant-space-item) {
    flex: 1;
  }
}
</style>
