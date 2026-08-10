<script setup lang="ts">
/**
 * 数据浏览。
 *
 * 两个 Tab：Redis 与 SQLite。二者的取数逻辑差别较大，
 * 各自拆成独立组件，这里只负责切换。
 */
import { ref } from 'vue'
import { Tabs, TabPane } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import RedisPanel from './RedisPanel.vue'
import SqlitePanel from './SqlitePanel.vue'

const activeTab = ref('redis')
</script>

<template>
  <div class="g-page g-data">
    <Tabs v-model:activeKey="activeTab" class="g-data-tabs">
      <TabPane key="redis">
        <template #tab>
          <span class="g-tab-label">
            <GIcon icon="ant-design:thunderbolt-outlined" :size="14" />
            Redis
          </span>
        </template>
        <!-- 切走时销毁，免得后台还挂着轮询/大结果集 -->
        <RedisPanel v-if="activeTab === 'redis'" />
      </TabPane>

      <TabPane key="sqlite">
        <template #tab>
          <span class="g-tab-label">
            <GIcon icon="ant-design:database-outlined" :size="14" />
            SQLite
          </span>
        </template>
        <SqlitePanel v-if="activeTab === 'sqlite'" />
      </TabPane>
    </Tabs>
  </div>
</template>

<style scoped>
.g-data {
  min-height: 100%;
  /* 数据表列多，宽屏要能用满，不套 g-page 默认的 1400px 限宽 */
  max-width: none;
}

/* ant 的 Tabs 内容区不带上边距，卡片会顶着标签栏的下边线 */
.g-data-tabs :deep(.ant-tabs-content-holder) {
  padding-top: 4px;
}

.g-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
