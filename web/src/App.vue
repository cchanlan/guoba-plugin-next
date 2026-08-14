<script setup lang="ts">
import { computed, watch } from 'vue'
import { ConfigProvider } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { useAppStore } from '@/stores/app'
import { useThemeConfig } from '@/theme'

const appStore = useAppStore()
const themeConfig = computed(() => useThemeConfig(appStore.isDark))

// Modal.confirm 这类静态方法不在组件树内，拿不到下面这个 ConfigProvider 的上下文
// （见 ant-design-vue 的 modal/confirm.js，它只读 globalConfigForApi），
// 不同步一次主题的话，深色面板上弹出的确认框会是白底白字。
// config() 的 theme 类型标注还是 v1 的旧 Theme，运行时透传给 ConfigProvider，实际要的是 ThemeConfig
watch(
  themeConfig,
  (theme) => ConfigProvider.config({ theme: theme as any }),
  { immediate: true },
)
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <RouterView />
  </ConfigProvider>
</template>
