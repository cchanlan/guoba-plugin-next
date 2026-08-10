<script setup lang="ts">
/**
 * 朴素的代码输入框。
 *
 * 面板里编辑自定义页面的 HTML / CSS / JS 用它，只做等宽字体、关闭拼写检查、
 * Tab 键插入缩进这几件事 —— 引一整个代码编辑器进来不值当。
 */
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    rows?: number
    /** Tab 键插入的空格数 */
    tabSize?: number
  }>(),
  { modelValue: '', rows: 16, tabSize: 2 },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const el = ref<HTMLTextAreaElement | null>(null)

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
}

/** Tab 默认会跳走焦点，这里改成插入缩进 */
function onTab(e: KeyboardEvent) {
  e.preventDefault()
  const ta = el.value
  if (!ta) return
  const pad = ' '.repeat(props.tabSize)
  const { selectionStart: start, selectionEnd: end, value } = ta
  const next = value.slice(0, start) + pad + value.slice(end)
  emit('update:modelValue', next)
  // DOM 的值由 v-bind 回填，光标要等这一帧结束后再摆到缩进之后
  requestAnimationFrame(() => {
    ta.selectionStart = ta.selectionEnd = start + pad.length
  })
}
</script>

<template>
  <textarea
    ref="el"
    class="g-code"
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
    :rows="props.rows"
    :placeholder="props.placeholder"
    :value="props.modelValue"
    @input="onInput"
    @keydown.tab="onTab"
  />
</template>

<style scoped>
.g-code {
  display: block;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--g-border);
  border-radius: 8px;
  background: var(--g-bg-soft);
  color: var(--g-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  tab-size: 2;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
}

.g-code:focus {
  border-color: var(--g-brand);
}

.g-code::placeholder {
  color: var(--g-text-dim);
}
</style>
