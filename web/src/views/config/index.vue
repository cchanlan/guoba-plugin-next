<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Alert, Empty, Skeleton, Tabs, TabPane } from 'ant-design-vue'
import NormalCard from './components/NormalCard.vue'
import KeyFormCard from './components/KeyFormCard.vue'
import ArrayFormCard from './components/ArrayFormCard.vue'
import { apiGetConfigTabs } from '@/api'
import { IS_V2 } from '@/utils/env'
import type { ConfigCard, ConfigTab } from '@/types'

const loading = ref(true)
const tabs = ref<ConfigTab[]>([])
const activeTab = ref('')
const loadError = ref('')

const currentTab = computed(() => tabs.value.find((t) => t.key === activeTab.value))

/** 按 card.type 选渲染组件，未知类型按普通卡处理 */
function cardComponent(card: ConfigCard) {
  switch (card.type) {
    case 'keyFormCard':
      return KeyFormCard
    case 'arrayFormCard':
      return ArrayFormCard
    default:
      return NormalCard
  }
}

onMounted(async () => {
  try {
    const res = await apiGetConfigTabs()
    tabs.value = Array.isArray(res) ? res : []
    activeTab.value = tabs.value[0]?.key ?? ''
  } catch (e: any) {
    loadError.value = e?.message || '配置项加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">配置管理</h2>
      <p class="g-page-desc">修改 Yunzai 的各项配置，改完记得点对应卡片的保存。</p>
    </div>

    <Alert
      v-if="IS_V2"
      type="warning"
      show-icon
      class="g-page-alert"
      message="当前处于 V2 兼容模式，部分配置项可能不可用"
    />

    <Skeleton v-if="loading" active :paragraph="{ rows: 8 }" />

    <Alert v-else-if="loadError" type="error" show-icon :message="loadError" />

    <Empty v-else-if="!tabs.length" description="没有可用的配置项" />

    <Tabs v-else v-model:activeKey="activeTab" class="g-cfg-tabs">
      <TabPane v-for="tab in tabs" :key="tab.key" :tab="tab.title" />
    </Tabs>

    <template v-if="currentTab">
      <component
        v-for="card in currentTab.cards"
        :is="cardComponent(card)"
        :key="card.key"
        :card="card"
      />
      <Empty v-if="!currentTab.cards?.length" description="该分类下暂无配置" />
    </template>
  </div>
</template>

<style scoped>
.g-page-head {
  margin-bottom: 12px;
}

.g-page-alert {
  margin-bottom: 14px;
}

.g-cfg-tabs {
  margin-bottom: 4px;
}
</style>
