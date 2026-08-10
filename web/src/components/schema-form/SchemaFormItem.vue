<script setup lang="ts">
import { computed } from 'vue'
import { Divider, FormItem, Tooltip } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { CHECKED_MODEL_COMPONENTS, NO_MODEL_COMPONENTS, resolveComponent } from './componentMap'
import { toAntdRules } from '@/utils/schema'
import { get, set } from 'lodash-es'
import type { FormSchema } from '@/types'

const props = defineProps<{
  schema: FormSchema
  model: Record<string, any>
}>()

const comp = computed(() => resolveComponent(props.schema.component))

const isDivider = computed(() => props.schema.component === 'Divider')

/** 未知组件：给出可见提示，而不是静默渲染成空白 */
const isUnknown = computed(() => !comp.value && !isDivider.value)

const rules = computed(() => toAntdRules(props.schema))

const helpMessages = computed(() => {
  const help = props.schema.helpMessage
  if (!help) return []
  return Array.isArray(help) ? help : [help]
})

/** Switch/Checkbox 用 checked，其余用 value */
const isCheckedModel = computed(() =>
  CHECKED_MODEL_COMPONENTS.has(props.schema.component ?? ''),
)

/** GButtons 这类只触发操作的组件不绑定值 */
const isNoModel = computed(() => NO_MODEL_COMPONENTS.has(props.schema.component ?? ''))

const fieldValue = computed({
  get: () => (props.schema.field ? get(props.model, props.schema.field) : undefined),
  set: (val) => {
    if (props.schema.field) set(props.model, props.schema.field, val)
  },
})

/**
 * componentProps 原样透传。
 * Switch 的 checkedValue/unCheckedValue 等由 antd 自己处理，无需特殊适配。
 */
const componentProps = computed(() => {
  const cp = { ...(props.schema.componentProps ?? {}) }
  // GSubForm 需要拿到自己的子 schema，已在 componentProps.schemas 里
  return cp
})

/** name 用数组形式，支持 a.b.c 这类嵌套路径的校验定位 */
const itemName = computed(() =>
  props.schema.field ? props.schema.field.split('.') : undefined,
)
</script>

<template>
  <Divider v-if="isDivider" orientation="left" class="g-schema-divider">
    {{ schema.label }}
  </Divider>

  <FormItem
    v-else
    :name="itemName"
    :rules="rules"
    :extra="schema.bottomHelpMessage"
    class="g-schema-item"
  >
    <template #label>
      <span class="g-schema-label">
        {{ schema.label }}
        <Tooltip v-if="helpMessages.length">
          <template #title>
            <div v-for="(msg, i) in helpMessages" :key="i">{{ msg }}</div>
          </template>
          <GIcon icon="ant-design:question-circle-outlined" :size="13" class="g-help-icon" />
        </Tooltip>
      </span>
    </template>

    <component
      v-if="comp && isNoModel"
      :is="comp"
      v-bind="componentProps"
    />
    <component
      v-else-if="comp && isCheckedModel"
      :is="comp"
      v-model:checked="fieldValue"
      v-bind="componentProps"
    />
    <component
      v-else-if="comp"
      :is="comp"
      v-model:value="fieldValue"
      v-bind="componentProps"
    />
    <div v-else-if="isUnknown" class="g-unknown">
      当前面板暂不支持组件「{{ schema.component }}」，该项已跳过
    </div>
  </FormItem>
</template>

<style scoped>
.g-schema-divider {
  margin: 20px 0 12px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-schema-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-help-icon {
  color: var(--g-text-dim);
  cursor: help;
}

.g-unknown {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--g-text-dim);
  background: var(--g-bg);
  border: 1px dashed var(--g-border);
  border-radius: 6px;
}
</style>
