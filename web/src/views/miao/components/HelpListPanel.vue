<script setup lang="ts">
import { ref } from 'vue'
import {
  Button,
  Card,
  Collapse,
  CollapsePanel,
  Empty,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Table,
  Tooltip,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import type { MiaoHelpGroup, MiaoHelpItem } from '@/types'

/**
 * 帮助列表编辑器。
 * 结构是「分组 → 命令项」两层，命令项含 icon 序号、标题、描述。
 */
const props = defineProps<{
  list: MiaoHelpGroup[]
  saving?: boolean
}>()

const emit = defineEmits<{
  save: []
  'update:list': [list: MiaoHelpGroup[]]
}>()

const activeKeys = ref<string[]>(['0'])

const columns = [
  { title: '图标序号', key: 'icon', width: 110 },
  { title: '命令', key: 'title' },
  { title: '说明', key: 'desc' },
  { title: '', key: 'op', width: 80 },
]

function update(next: MiaoHelpGroup[]) {
  emit('update:list', next)
}

function addGroup() {
  const next = [...props.list, { group: '新分组', list: [] }]
  update(next)
  activeKeys.value = [...activeKeys.value, String(next.length - 1)]
}

function removeGroup(index: number) {
  const next = props.list.filter((_, i) => i !== index)
  update(next)
  activeKeys.value = []
}

function moveGroup(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= props.list.length) return
  const next = [...props.list]
  ;[next[index], next[target]] = [next[target], next[index]]
  update(next)
}

function addItem(group: MiaoHelpGroup) {
  if (!Array.isArray(group.list)) group.list = []
  group.list.push({ icon: 1, title: '#命令', desc: '说明' })
}

function removeItem(group: MiaoHelpGroup, index: number) {
  group.list?.splice(index, 1)
}

function moveItem(group: MiaoHelpGroup, index: number, delta: number) {
  const list = group.list
  if (!list) return
  const target = index + delta
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
}

function itemCount(group: MiaoHelpGroup) {
  return Array.isArray(group.list) ? group.list.length : 0
}
</script>

<template>
  <Card :bordered="false" class="g-miao-card">
    <template #title><span class="g-miao-title">帮助列表</span></template>
    <template #extra>
      <Space>
        <Button size="small" @click="addGroup">
          <GIcon icon="ant-design:plus-outlined" :size="12" />
          <span class="g-btn-text">新增分组</span>
        </Button>
        <Button type="primary" size="small" :loading="saving" @click="emit('save')">保存</Button>
      </Space>
    </template>

    <Empty v-if="!list.length" description="还没有任何分组" />

    <Collapse v-else v-model:activeKey="activeKeys">
      <CollapsePanel v-for="(group, gIdx) in list" :key="String(gIdx)">
        <template #header>
          <span class="g-group-title">{{ group.group || '未命名分组' }}</span>
          <span class="g-group-count">{{ itemCount(group) }} 项</span>
        </template>

        <template #extra>
          <Space :size="2" @click.stop>
            <Tooltip title="上移">
              <Button type="text" size="small" :disabled="gIdx === 0" @click="moveGroup(gIdx, -1)">
                <GIcon icon="ant-design:arrow-up-outlined" :size="12" />
              </Button>
            </Tooltip>
            <Tooltip title="下移">
              <Button
                type="text"
                size="small"
                :disabled="gIdx === list.length - 1"
                @click="moveGroup(gIdx, 1)"
              >
                <GIcon icon="ant-design:arrow-down-outlined" :size="12" />
              </Button>
            </Tooltip>
            <Popconfirm title="删除该分组及其下所有命令？" ok-text="删除" cancel-text="取消" @confirm="removeGroup(gIdx)">
              <Button type="text" danger size="small">
                <GIcon icon="ant-design:delete-outlined" :size="12" />
              </Button>
            </Popconfirm>
          </Space>
        </template>

        <div class="g-group-name">
          <span class="g-group-label">分组名</span>
          <Input v-model:value="group.group" placeholder="分组名称" class="g-group-input" />
        </div>

        <Table
          :columns="columns"
          :data-source="group.list ?? []"
          :pagination="false"
          :row-key="(_r: any, i?: number) => i ?? 0"
          size="small"
        >
          <template #bodyCell="{ column, record, index }">
            <template v-if="column.key === 'icon'">
              <InputNumber v-model:value="record.icon" :min="0" size="small" class="g-full" />
            </template>
            <template v-else-if="column.key === 'title'">
              <Input v-model:value="record.title" size="small" placeholder="#命令" />
            </template>
            <template v-else-if="column.key === 'desc'">
              <Input v-model:value="record.desc" size="small" placeholder="命令说明" />
            </template>
            <template v-else-if="column.key === 'op'">
              <Space :size="0">
                <Button type="text" size="small" :disabled="index === 0" @click="moveItem(group, index, -1)">
                  <GIcon icon="ant-design:arrow-up-outlined" :size="11" />
                </Button>
                <Button type="text" danger size="small" @click="removeItem(group, index)">
                  <GIcon icon="ant-design:close-outlined" :size="11" />
                </Button>
              </Space>
            </template>
          </template>
        </Table>

        <Button type="dashed" block class="g-add-item" @click="addItem(group)">
          <GIcon icon="ant-design:plus-outlined" :size="12" />
          <span class="g-btn-text">添加一条命令</span>
        </Button>
      </CollapsePanel>
    </Collapse>
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

.g-group-title {
  font-size: 13px;
  font-weight: 500;
}

.g-group-count {
  margin-left: 8px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-group-name {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.g-group-label {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-group-input {
  max-width: 260px;
}

.g-full {
  width: 100%;
}

.g-add-item {
  margin-top: 10px;
}

.g-btn-text {
  margin-left: 4px;
}
</style>
