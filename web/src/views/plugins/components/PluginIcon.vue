<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GIcon from '@/components/GIcon.vue'
import { API_BASE } from '@/utils/env'
import type { PluginItem } from '@/types'

/**
 * 插件图标。
 * 优先用插件自带的图片（iconPath 存在时走 /plugin/s/:name/icon，该接口无需 token），
 * 其次用 iconify 图标名，最后回落到默认插件图标。
 */
const props = withDefaults(
  defineProps<{
    plugin: Pick<PluginItem, 'name' | 'icon' | 'iconColor' | 'iconPath'>
    size?: number
  }>(),
  { size: 36 },
)

const imgFailed = ref(false)

const imgUrl = computed(() => {
  if (!props.plugin?.iconPath) return ''
  return `${API_BASE}/plugin/s/${encodeURIComponent(props.plugin.name)}/icon`
})

const iconName = computed(() => props.plugin?.icon || 'ant-design:api-outlined')

// 换插件时重置失败标记，否则会误判
watch(() => props.plugin?.name, () => (imgFailed.value = false))
</script>

<template>
  <span
    class="g-plugin-icon"
    :style="{ width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size / 4)}px` }"
  >
    <img
      v-if="imgUrl && !imgFailed"
      :src="imgUrl"
      alt=""
      class="g-plugin-icon-img"
      @error="imgFailed = true"
    />
    <GIcon
      v-else
      :icon="iconName"
      :size="Math.round(size * 0.56)"
      :style="{ color: plugin?.iconColor || 'var(--g-brand)' }"
    />
  </span>
</template>

<style scoped>
.g-plugin-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--g-bg-soft);
}

.g-plugin-icon-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
