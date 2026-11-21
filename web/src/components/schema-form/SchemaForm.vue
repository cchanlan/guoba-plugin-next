<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { Form, Tabs, TabPane } from 'ant-design-vue'
import SchemaFormItem from './SchemaFormItem.vue'
import { FORM_MODEL_KEY } from './context'
import { useAppStore } from '@/stores/app'
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

const appStore = useAppStore()

const formRef = ref<any>(null)
const model = ref<Record<string, any>>({})

/**
 * 窄屏强制竖排：横向表单的 label 固定占 160px，在 385px 手机上会把输入框挤成一条缝
 * （插件配置、云崽配置都走这里）。手机上一律竖排，label 独占一行，输入框拿满宽度。
 */
const effectiveLayout = computed(() =>
  appStore.isMobile ? 'vertical' : props.layout,
)

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

// 自定义换行导航保留键盘切换，并沿用 Tabs 的面板、激活状态和表单生命周期。
function navigateGroup(event: KeyboardEvent) {
  const current = event.currentTarget as HTMLButtonElement
  const tabs = Array.from(current.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
  const index = tabs.indexOf(current)
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = tabs.length - 1
  else return
  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}

const labelCol = computed(() =>
  effectiveLayout.value === 'horizontal'
    ? { style: { width: `${props.labelWidth}px` } }
    : undefined,
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
    :layout="effectiveLayout"
    :labelCol="labelCol"
    :labelWrap="true"
    labelAlign="left"
    :disabled="disabled"
    class="g-schema-form"
  >
    <!-- 有分组：渲染为 Tab -->
    <Tabs v-if="grouped" v-model:activeKey="activeGroup" class="g-schema-tabs">
      <template #renderTabBar="{ id, activeKey, onTabClick }">
        <div class="g-schema-group-nav" role="tablist" aria-label="配置目录">
          <button
            v-for="(group, gIdx) in groups"
            :id="id ? `${id}-tab-${gIdx}` : undefined"
            :key="String(gIdx)"
            type="button"
            role="tab"
            class="g-schema-group-tab"
            :aria-selected="activeKey === String(gIdx)"
            :aria-controls="id ? `${id}-panel-${gIdx}` : undefined"
            :tabindex="activeKey === String(gIdx) ? 0 : -1"
            @click="onTabClick(String(gIdx), $event)"
            @keydown="navigateGroup"
          >
            {{ group.title || `分组 ${gIdx + 1}` }}
          </button>
        </div>
      </template>
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
/* 表单本身铺满卡片，只把「控件 + 说明文字」限在 900px：
   宽屏下输入框跟着拉满整屏会难读，限宽后各行等宽、左侧对齐。 */
.g-schema-form :deep(.ant-form-item-control-input-content),
.g-schema-form :deep(.ant-form-item-extra) {
  max-width: 900px;
}

.g-schema-group-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 24px;
}

.g-schema-group-tab {
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  max-width: 100%;
  font: inherit;
  line-height: 1.5;
  color: var(--g-text-sub);
  background: transparent;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.g-schema-group-tab:hover {
  color: var(--g-brand);
  background: var(--g-brand-soft);
}

.g-schema-group-tab[aria-selected='true'] {
  color: var(--g-brand-fg);
  background: var(--g-brand);
}

.g-schema-group-tab:focus-visible {
  outline: 2px solid var(--g-brand);
  outline-offset: 2px;
}

/* 窄屏：数字框/普通输入框默认不铺满，竖排下留一小截很难点，统一拉满行宽 */
@media (max-width: 768px) {
  .g-schema-form :deep(.ant-input-number),
  .g-schema-form :deep(.ant-picker),
  .g-schema-form :deep(.ant-select) {
    width: 100%;
  }
}
</style>
