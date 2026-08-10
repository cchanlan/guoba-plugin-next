<script setup lang="ts">
import { computed } from 'vue'
import { Input } from 'ant-design-vue'

/**
 * 颜色选择器。喵喵皮肤配置里会用到（如字体颜色、描边色）。
 * 值为 CSS 颜色字符串，例如 #ffffff 或 rgba(0,0,0,.5)。
 */
const props = defineProps<{
  value?: string
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:value': [string] }>()

/** <input type="color"> 只认 #rrggbb，其他格式（rgba 等）就不回填色板 */
const swatch = computed(() => {
  const val = props.value ?? ''
  return /^#[0-9a-fA-F]{6}$/.test(val) ? val : '#000000'
})

function onSwatch(e: Event) {
  emit('update:value', (e.target as HTMLInputElement).value)
}

function onText(val: string) {
  emit('update:value', val)
}
</script>

<template>
  <div class="g-color">
    <input
      type="color"
      class="g-color-swatch"
      :value="swatch"
      :disabled="disabled"
      @input="onSwatch"
    />
    <Input
      :value="props.value"
      :placeholder="placeholder ?? '如 #ffffff 或 rgba(0,0,0,.5)'"
      :disabled="disabled"
      allowClear
      class="g-color-text"
      @update:value="onText"
    />
  </div>
</template>

<style scoped>
.g-color {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
}

.g-color-swatch {
  width: 34px;
  height: 32px;
  padding: 2px;
  background: transparent;
  border: 1px solid var(--g-border);
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
}

.g-color-text {
  flex: 1;
}
</style>
