<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Space,
  Table,
  Tag,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiAddMiaoBackup,
  apiDeleteMiaoBackup,
  apiGetMiaoBackupList,
  apiRestoreMiaoBackup,
} from '@/api'
import type { MiaoBackupItem } from '@/types'

/**
 * 备份管理。备份的是 config/help.js 与 resources/help/icon.png 两个文件。
 * version !== 2 的是旧版备份，还原时后端会先转换格式（可能会顺带生成一个新皮肤）。
 */
const emit = defineEmits<{ restored: [] }>()

const loading = ref(true)
const list = ref<MiaoBackupItem[]>([])

const addOpen = ref(false)
const remark = ref('')
const adding = ref(false)
const restoringId = ref('')

const columns = [
  { title: '备注', key: 'remark', width: '40%' },
  { title: '时间', key: 'time', width: '30%' },
  { title: '操作', key: 'action', width: '30%', align: 'right' as const },
]

async function load() {
  loading.value = true
  try {
    const data = await apiGetMiaoBackupList()
    list.value = Array.isArray(data) ? [...data].reverse() : []
  } catch {
    list.value = []
  } finally {
    loading.value = false
  }
}

async function doAdd() {
  const text = remark.value.trim()
  if (!text) {
    message.warning('请填写备注，方便之后辨认')
    return
  }
  adding.value = true
  try {
    await apiAddMiaoBackup(text)
    addOpen.value = false
    remark.value = ''
    await load()
  } finally {
    adding.value = false
  }
}

async function doRestore(item: MiaoBackupItem | Record<string, any>) {
  restoringId.value = item.id
  try {
    await apiRestoreMiaoBackup(item.id)
    emit('restored')
  } finally {
    restoringId.value = ''
  }
}

async function doDelete(item: MiaoBackupItem | Record<string, any>) {
  await apiDeleteMiaoBackup(item.id)
  await load()
}

onMounted(load)
</script>

<template>
  <Card :bordered="false" class="g-miao-card">
    <template #title><span class="g-miao-title">备份与还原</span></template>
    <template #extra>
      <Space>
        <Button size="small" @click="addOpen = true">
          <GIcon icon="ant-design:save-outlined" :size="12" />
          <span class="g-btn-text">新建备份</span>
        </Button>
        <Button size="small" :disabled="loading" @click="load">
          <GIcon icon="ant-design:reload-outlined" :size="13" />
        </Button>
      </Space>
    </template>

    <Skeleton v-if="loading" active :paragraph="{ rows: 4 }" />

    <Empty v-else-if="!list.length" description="还没有备份，保存过一次配置后即可备份" />

    <Table
      v-else
      :columns="columns"
      :data-source="list"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'remark'">
          <Space :size="6">
            <span>{{ record.remark || '未命名备份' }}</span>
            <Tag v-if="record.version !== 2" color="orange">旧版</Tag>
            <Tag v-if="record.isInit" color="blue">初始</Tag>
          </Space>
        </template>

        <template v-else-if="column.key === 'time'">
          <span class="g-backup-time">{{ record.time || '-' }}</span>
        </template>

        <template v-else-if="column.key === 'action'">
          <Space :size="4">
            <Popconfirm
              :title="
                record.version !== 2
                  ? '旧版备份会先转换格式再还原，可能生成新皮肤，确定还原？'
                  : '将覆盖当前的喵喵帮助配置，确定还原？'
              "
              ok-text="还原"
              cancel-text="取消"
              @confirm="doRestore(record)"
            >
              <Button type="link" size="small" :loading="restoringId === record.id">还原</Button>
            </Popconfirm>
            <Popconfirm
              title="删除该备份？"
              ok-text="删除"
              cancel-text="取消"
              @confirm="doDelete(record)"
            >
              <Button type="link" danger size="small">删除</Button>
            </Popconfirm>
          </Space>
        </template>
      </template>
    </Table>

    <Modal
      v-model:open="addOpen"
      title="新建备份"
      ok-text="备份"
      cancel-text="取消"
      :confirm-loading="adding"
      @ok="doAdd"
    >
      <Input v-model:value="remark" placeholder="给这次备份写个备注" allowClear @press-enter="doAdd" />
      <p class="g-backup-tip">备份内容：config/help.js 与 resources/help/icon.png</p>
    </Modal>
  </Card>
</template>

<style scoped>
.g-miao-card {
  margin-bottom: 16px;
}

.g-miao-title {
  font-size: 15px;
  font-weight: 600;
}

.g-backup-time {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-backup-tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-btn-text {
  margin-left: 5px;
}
</style>
