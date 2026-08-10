import type { Component } from 'vue'
import {
  AutoComplete,
  Cascader,
  Checkbox,
  CheckboxGroup,
  DatePicker,
  Input,
  InputNumber,
  InputPassword,
  RadioGroup,
  Rate,
  Select,
  Slider,
  Switch,
  Textarea,
  TimePicker,
  TreeSelect,
} from 'ant-design-vue'
import GTags from './components/GTags.vue'
import GSubForm from './components/GSubForm.vue'
import GSelectGroup from './components/GSelectGroup.vue'
import GSelectFriend from './components/GSelectFriend.vue'
import GColorPicker from './components/GColorPicker.vue'
import GUpload from './components/GUpload.vue'
import EasyCron from './components/EasyCron.vue'
import GButtons from './components/GButtons.vue'

/**
 * schema 里的 component 名 → 实际组件。
 *
 * 命名沿用锅巴既有约定（大部分与 Ant Design Vue 同名，G* 为锅巴自定义），
 * 插件的 guoba.support.js 依赖这套名字，不能随意更改。
 */
export const componentMap: Record<string, Component> = {
  // Ant Design Vue 原生
  Input,
  InputNumber,
  InputPassword,
  InputTextArea: Textarea,
  Textarea,
  Switch,
  Select,
  RadioGroup,
  Checkbox,
  CheckboxGroup,
  Slider,
  Rate,
  DatePicker,
  TimePicker,
  AutoComplete,
  Cascader,
  TreeSelect,

  // 锅巴自定义
  GTags,
  GSubForm,
  GSelectGroup,
  GSelectFriend,
  GColorPicker,
  Upload: GUpload,
  GUpload,
  EasyCron,
  GButtons,
}

/** 这些组件用 v-model:checked 而不是 v-model:value */
export const CHECKED_MODEL_COMPONENTS = new Set(['Switch', 'Checkbox'])

/** 这些组件只触发操作、不绑定数据，不需要 v-model */
export const NO_MODEL_COMPONENTS = new Set(['GButtons'])

/** 这些组件天然占满整行，标签放在上方更好看 */
export const BLOCK_COMPONENTS = new Set([
  'GSubForm',
  'InputTextArea',
  'Textarea',
  'GTags',
  'GSelectGroup',
  'GSelectFriend',
])

export function resolveComponent(name?: string): Component | undefined {
  if (!name) return undefined
  return componentMap[name]
}
