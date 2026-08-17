<script setup lang="ts">
/**
 * 备份与还原。
 *
 * 四个 Tab 各自成组件，这里只管切换和它们之间的两处联动：
 * 「备份管理」点还原 → 跳到还原 Tab 并带上包名；「新建备份」建完 → 刷新包列表。
 *
 * Tab 一旦访问过就不再销毁 —— 备份/还原任务靠前端轮询取进度，切走就销毁的话
 * 轮询会中断（任务本身在后端继续跑，但页面上看不到实时进度了）。
 */
import { ref, watch } from 'vue'
import { Tabs, TabPane } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import CreatePanel from './CreatePanel.vue'
import PacksPanel from './PacksPanel.vue'
import RestorePanel from './RestorePanel.vue'
import SchedulePanel from './SchedulePanel.vue'

const activeTab = ref('create')
const seen = ref<string[]>(['create'])
const restoreFile = ref('')
const packsRef = ref<InstanceType<typeof PacksPanel> | null>(null)

watch(activeTab, (key) => {
  if (!seen.value.includes(key)) seen.value.push(key)
})

function onRestore(name: string) {
  restoreFile.value = name
  activeTab.value = 'restore'
  if (!seen.value.includes('restore')) seen.value.push('restore')
}

/** 建完备份要让「备份管理」看到新包；那个 Tab 还没访问过就不用管，它挂载时自己会拉 */
function onCreated() {
  void packsRef.value?.load()
}
</script>

<template>
  <div class="g-page g-backup">
    <h2 class="g-page-title">备份还原</h2>
    <p class="g-page-desc">
      备份 Bot 与各插件的配置、数据、自备素材，插件只记仓库地址、还原时自动拉取 ——
      搬家时下载一个包，在新机器上传后一键还原。
    </p>

    <Tabs v-model:activeKey="activeTab" class="g-backup-tabs">
      <TabPane key="create">
        <template #tab>
          <span class="g-tab-label">
            <GIcon icon="ant-design:save-outlined" :size="14" />
            新建备份
          </span>
        </template>
        <CreatePanel v-if="seen.includes('create')" @created="onCreated" />
      </TabPane>

      <TabPane key="packs">
        <template #tab>
          <span class="g-tab-label">
            <GIcon icon="ant-design:folder-outlined" :size="14" />
            备份管理
          </span>
        </template>
        <PacksPanel v-if="seen.includes('packs')" ref="packsRef" @restore="onRestore" />
      </TabPane>

      <TabPane key="restore">
        <template #tab>
          <span class="g-tab-label">
            <GIcon icon="ant-design:rollback-outlined" :size="14" />
            还原
          </span>
        </template>
        <RestorePanel v-if="seen.includes('restore')" :file="restoreFile" />
      </TabPane>

      <TabPane key="schedule">
        <template #tab>
          <span class="g-tab-label">
            <GIcon icon="ant-design:clock-circle-outlined" :size="14" />
            定时备份
          </span>
        </template>
        <SchedulePanel v-if="seen.includes('schedule')" />
      </TabPane>
    </Tabs>
  </div>
</template>

<style scoped>
.g-backup {
  min-height: 100%;
}

/* ant 的 Tabs 内容区不带上边距，内容会顶着标签栏的下边线 */
.g-backup-tabs :deep(.ant-tabs-content-holder) {
  padding-top: 4px;
}

.g-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
