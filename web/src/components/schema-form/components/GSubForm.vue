<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import {
  Button,
  Empty,
  Form,
  Modal,
  Popconfirm,
  Table,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { buildFormModel, structuredCloneSafe } from '@/utils/schema'
import type { FormSchema } from '@/types'

/**
 * 子表单。
 *
 * 对应 schema 中的 `GSubForm`，componentProps 形如：
 *   { multiple: true, modalProps: { title }, schemas: [...] }
 *
 * - multiple 为 true 时，值是对象数组，用表格展示、弹窗增改；
 * - 否则值是单个对象，直接内联渲染子字段。
 *
 * 这里用异步组件引入 SchemaFormItem，避免与 componentMap 形成静态循环依赖。
 */
const SchemaFormItem = defineAsyncComponent(() => import('../SchemaFormItem.vue'))

const props = withDefaults(
  defineProps<{
    value?: any
    multiple?: boolean
    schemas?: FormSchema[]
    modalProps?: Record<string, any>
    /** 最多可添加条数 */
    lengthMax?: number
    /** 至少保留条数 */
    lengthMin?: number
  }>(),
  { multiple: false },
)

const emit = defineEmits<{ 'update:value': [any] }>()

const subSchemas = computed(() => props.schemas ?? [])

/* ---------------- 单条模式 ---------------- */

const singleModel = ref<Record<string, any>>({})

/* ---------------- 多条模式 ---------------- */

const rows = ref<any[]>([])

watch(
  () => props.value,
  (val) => {
    if (props.multiple) {
      rows.value = Array.isArray(val) ? structuredCloneSafe(val) : []
    } else {
      singleModel.value = buildFormModel(subSchemas.value, val ?? {})
    }
  },
  { immediate: true, deep: false },
)

// 单条模式下，子字段改动直接向上同步
watch(
  singleModel,
  (val) => {
    if (!props.multiple) emit('update:value', val)
  },
  { deep: true },
)

/** 表格列：取子 schema 里前若干个字段做展示 */
const columns = computed(() => {
  const fields = subSchemas.value.filter(
    (s) => s.field && s.component !== 'Divider' && s.component !== 'SOFT_GROUP_BEGIN',
  )
  const cols = fields.slice(0, 4).map((s) => ({
    title: s.label ?? s.field,
    dataIndex: s.field,
    key: s.field,
    ellipsis: true,
    customRender: ({ record }: any) => formatCell(record?.[s.field!], s),
  }))
  cols.push({
    title: '操作',
    dataIndex: '__action__',
    key: '__action__',
    width: 120,
  } as any)
  return cols
})

/** 表格单元格展示：把布尔、对象等转成可读文本 */
function formatCell(val: any, schema: FormSchema): string {
  if (val === undefined || val === null || val === '') return '-'
  if (typeof val === 'boolean') return val ? '是' : '否'
  if (Array.isArray(val)) return val.length ? val.join('、') : '-'
  if (typeof val === 'object') return JSON.stringify(val)
  // 有候选项的字段，展示 label 而不是原始值
  const options = schema.componentProps?.options
  if (Array.isArray(options)) {
    const hit = options.find((o: any) => String(o.value) === String(val))
    if (hit) return hit.label ?? String(val)
  }
  if (schema.component === 'InputPassword') return '••••••'
  return String(val)
}

const modalOpen = ref(false)
const editingIndex = ref(-1)
const editingModel = ref<Record<string, any>>({})
const formRef = ref<any>(null)

const modalTitle = computed(() => {
  const base = props.modalProps?.title ?? '子表单'
  return editingIndex.value < 0 ? `新增${base}` : `编辑${base}`
})

function openAdd() {
  if (props.lengthMax != null && rows.value.length >= props.lengthMax) {
    message.warn(`最多只能添加 ${props.lengthMax} 条`)
    return
  }
  editingIndex.value = -1
  editingModel.value = buildFormModel(subSchemas.value, {})
  modalOpen.value = true
}

function openEdit(index: number) {
  editingIndex.value = index
  editingModel.value = buildFormModel(subSchemas.value, rows.value[index] ?? {})
  modalOpen.value = true
}

async function onModalOk() {
  try {
    await formRef.value?.validate?.()
  } catch {
    // 校验未过，antd 已在字段下方给出提示
    return
  }
  const record = structuredCloneSafe(editingModel.value)
  if (editingIndex.value < 0) {
    rows.value.push(record)
  } else {
    rows.value[editingIndex.value] = record
  }
  emit('update:value', structuredCloneSafe(rows.value))
  modalOpen.value = false
}

function onRemove(index: number) {
  if (props.lengthMin != null && rows.value.length <= props.lengthMin) {
    message.warn(`至少要保留 ${props.lengthMin} 条`)
    return
  }
  rows.value.splice(index, 1)
  emit('update:value', structuredCloneSafe(rows.value))
}
</script>

<template>
  <!-- 单条：直接内联渲染子字段 -->
  <div v-if="!multiple" class="g-subform-single">
    <SchemaFormItem
      v-for="(item, idx) in subSchemas"
      :key="item.field ?? `s-${idx}`"
      :schema="item"
      :model="singleModel"
    />
  </div>

  <!-- 多条：表格 + 弹窗 -->
  <div v-else class="g-subform">
    <Table
      v-if="rows.length"
      :columns="columns"
      :dataSource="rows"
      :pagination="false"
      size="small"
      :rowKey="(_record: any, index?: number) => index ?? 0"
      class="g-subform-table"
    >
      <template #bodyCell="{ column, index }">
        <template v-if="column.key === '__action__'">
          <div class="g-subform-ops">
            <Button type="link" size="small" @click="openEdit(index)">编辑</Button>
            <Popconfirm title="确定要删除这一条吗？" @confirm="onRemove(index)">
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
          </div>
        </template>
      </template>
    </Table>

    <Empty v-else :image="Empty.PRESENTED_IMAGE_SIMPLE" description="暂无数据" />

    <Button type="dashed" block class="g-subform-add" @click="openAdd">
      <GIcon icon="ant-design:plus-outlined" :size="13" />
      <span>新增</span>
    </Button>

    <Modal
      v-model:open="modalOpen"
      :title="modalTitle"
      :width="modalProps?.width ?? 620"
      destroyOnClose
      okText="确定"
      cancelText="取消"
      @ok="onModalOk"
    >
      <Form
        ref="formRef"
        :model="editingModel"
        layout="vertical"
        class="g-subform-modal-form"
      >
        <SchemaFormItem
          v-for="(item, idx) in subSchemas"
          :key="item.field ?? `m-${idx}`"
          :schema="item"
          :model="editingModel"
        />
      </Form>
    </Modal>
  </div>
</template>

<style scoped>
.g-subform-single {
  padding: 12px 14px;
  background: var(--g-bg);
  border: 1px solid var(--g-border);
  border-radius: 8px;
}

.g-subform-single :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}

.g-subform-table {
  margin-bottom: 8px;
}

.g-subform-ops {
  display: flex;
  gap: 2px;
}

.g-subform-add {
  margin-top: 4px;
}

.g-subform-modal-form {
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 4px;
}
</style>
