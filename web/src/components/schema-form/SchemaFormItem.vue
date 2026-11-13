<script setup lang="ts">
import { computed } from 'vue'
import { FormItem, Tooltip } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  BLOCK_COMPONENTS,
  CHECKED_MODEL_COMPONENTS,
  NO_MODEL_COMPONENTS,
  resolveComponent,
} from './componentMap'
import { toAntdRules } from '@/utils/schema'
import { get, set } from 'lodash-es'
import type { FormSchema } from '@/types'

const props = defineProps<{
  schema: FormSchema
  model: Record<string, any>
}>()

const comp = computed(() => resolveComponent(props.schema.component))

const isDivider = computed(() => props.schema.component === 'Divider')

/** 分割线文案：短的当小标题（左色条），长的当说明区块（软底纹），空的只画一条线 */
const dividerLabel = computed(() => (props.schema.label ?? '').trim())
const dividerIsNote = computed(() => dividerLabel.value.length > 24)

/**
 * 整行大组件（子表单、标签、多选群/好友等）：label 塞进固定 160px 的横向列里会被挤成
 * 好几行，很难看。这类组件让 FormItem 走整行竖排，label 独占一行放上方。
 *
 * schema 里写 `block: false` 可以把这个默认行为**单独关掉** —— 有的 label 很短
 * （比如「不收开黑播报的群」），走常规的「标签左、控件右」反而和上下其它字段对得齐。
 */
const isBlock = computed(() => {
  if (props.schema.block === false) return false
  return BLOCK_COMPONENTS.has(props.schema.component ?? '')
})
const fullSpan = { span: 24 }

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

/**
 * 老锅巴的自定义组件只发 change、不发 update:value（比如插件替换掉的 InputTextArea），
 * 这类组件用 change 把值写回；组件自己声明了 update:value 的按 v-model 处理。
 */
const legacyChange = computed(() => {
  const c: any = comp.value
  const emits = c?.emits
  if (!emits) return true
  const names = Array.isArray(emits) ? emits : Object.keys(emits)
  return !names.includes('update:value')
})

/** antd 原生组件的 change 载荷是 Event / 文件对象这类，只有原始值才当成新值 */
function onLegacyChange(payload: any) {
  const type = typeof payload
  if (type !== 'string' && type !== 'number' && type !== 'boolean') return
  fieldValue.value = payload
}
</script>

<template>
  <!-- 分割线：空→细线；短标题→左色条小标题；长文案→柔和说明块 -->
  <template v-if="isDivider">
    <div v-if="!dividerLabel" class="g-schema-hr" />
    <div v-else-if="dividerIsNote" class="g-schema-note">{{ dividerLabel }}</div>
    <div v-else class="g-schema-section">{{ dividerLabel }}</div>
  </template>

  <FormItem
    v-else
    :name="itemName"
    :rules="rules"
    :extra="schema.bottomHelpMessage"
    class="g-schema-item"
    :class="{ 'is-block': isBlock }"
    :label-col="isBlock ? fullSpan : undefined"
    :wrapper-col="isBlock ? fullSpan : undefined"
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
      v-on="legacyChange ? { change: onLegacyChange } : {}"
    />
    <div v-else-if="isUnknown" class="g-unknown">
      当前面板暂不支持组件「{{ schema.component }}」，该项已跳过
    </div>
  </FormItem>
</template>

<style scoped>
/* 短标题：左侧品牌色条 + 整行底线，文字自然折行不被横线穿过 */
.g-schema-section {
  margin: 22px 0 14px;
  padding: 0 0 8px 10px;
  border-left: 3px solid var(--g-brand);
  border-bottom: 1px solid var(--g-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text);
  line-height: 1.6;
  word-break: break-word;
}

/* 长文案（命令入口这类）：柔和底纹说明块，读着像提示而不是标题，不再横线穿字 */
.g-schema-note {
  margin: 18px 0 14px;
  padding: 10px 12px;
  border-left: 3px solid var(--g-brand);
  border-radius: 0 8px 8px 0;
  background: var(--g-bg-soft);
  font-size: 12px;
  line-height: 1.7;
  color: var(--g-text-sub);
  word-break: break-word;
}

/* 无文字：纯分隔线 */
.g-schema-hr {
  margin: 20px 0;
  border-top: 1px solid var(--g-border);
}

/* 整行大组件：label 上方独占一行（横向表单里也强制竖排这一项） */
.g-schema-item.is-block :deep(.ant-form-item-label) {
  text-align: left;
  padding-bottom: 4px;
}
.g-schema-item.is-block :deep(.ant-form-item-label > label) {
  height: auto;
  white-space: normal;
  word-break: break-word;
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
