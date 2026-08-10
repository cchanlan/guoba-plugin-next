<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { Form, Tabs, TabPane } from 'ant-design-vue'
import SchemaFormItem from './SchemaFormItem.vue'
import { FORM_MODEL_KEY } from './context'
import {
  buildFormModel,
  hasGroups,
  pruneMaterialized,
  splitGroups,
  structuredCloneSafe,
} from '@/utils/schema'
import type { FormSchema } from '@/types'

/**
 * Schema 驱动的表单。
 *
 * schema 来自后端（配置管理）或插件的 guoba.support.js（插件配置）。
 * 若 schema 中含 SOFT_GROUP_BEGIN 标记，则按分组渲染为若干 Tab。
 */
const props = withDefaults(
  defineProps<{
    schemas: FormSchema[]
    /** 初始数据 */
    data?: Record<string, any>
    layout?: 'horizontal' | 'vertical'
    labelWidth?: number
    disabled?: boolean
  }>(),
  { layout: 'horizontal', labelWidth: 160 },
)

const formRef = ref<any>(null)
const model = ref<Record<string, any>>({})

// GButtons 等组件需要读取整张表单的值
provide(FORM_MODEL_KEY, model)

watch(
  () => [props.schemas, props.data] as const,
  () => {
    model.value = buildFormModel(props.schemas, props.data)
  },
  { immediate: true, deep: false },
)

const grouped = computed(() => hasGroups(props.schemas))
const groups = computed(() => splitGroups(props.schemas))

const activeGroup = ref('0')

const labelCol = computed(() =>
  props.layout === 'horizontal' ? { style: { width: `${props.labelWidth}px` } } : undefined,
)

/** 取值时去掉「仅为渲染补出来的空父级」，见 utils/schema.ts */
function collect(): Record<string, any> {
  const values = structuredCloneSafe(model.value)
  return pruneMaterialized(values, model.value, props.data)
}

/** 校验并返回当前表单数据；校验失败时抛出 */
async function validate(): Promise<Record<string, any>> {
  await formRef.value?.validate?.()
  return collect()
}

/** 不校验直接取值 */
function getValues(): Record<string, any> {
  return collect()
}

function resetFields() {
  model.value = buildFormModel(props.schemas, props.data)
  formRef.value?.clearValidate?.()
}

defineExpose({ validate, getValues, resetFields, model })
</script>

<template>
  <Form
    ref="formRef"
    :model="model"
    :layout="layout"
    :labelCol="labelCol"
    :labelWrap="true"
    :disabled="disabled"
    class="g-schema-form"
  >
    <!-- 有分组：渲染为 Tab -->
    <Tabs v-if="grouped" v-model:activeKey="activeGroup" class="g-schema-tabs">
      <TabPane
        v-for="(group, gIdx) in groups"
        :key="String(gIdx)"
        :tab="group.title || `分组 ${gIdx + 1}`"
        forceRender
      >
        <SchemaFormItem
          v-for="(item, idx) in group.schemas"
          :key="item.field ?? `g${gIdx}-${idx}`"
          :schema="item"
          :model="model"
        />
      </TabPane>
    </Tabs>

    <!-- 无分组：平铺 -->
    <template v-else>
      <SchemaFormItem
        v-for="(item, idx) in schemas"
        :key="item.field ?? `f-${idx}`"
        :schema="item"
        :model="model"
      />
    </template>
  </Form>
</template>

<style scoped>
.g-schema-form {
  max-width: 900px;
}

.g-schema-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 20px;
}
</style>
