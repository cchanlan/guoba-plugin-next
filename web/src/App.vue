<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { ConfigProvider } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { useAppStore } from '@/stores/app'
import { useThemeConfig } from '@/theme'
import { getPopupContainer } from '@/utils/popup'
import { installHorizontalDrag } from '@/utils/horizontalDrag'

const appStore = useAppStore()

/**
 * 默认按钮跟随主题色。
 *
 * antd 的按钮背景由运行时注入的 CSS-in-JS 管着，实测同一条规则在登录页生效、
 * 在主面板却被压住。这里直接写内联 !important —— 内联优先级最高，
 * 任何选择器都盖不住。颜色取主题变量，主人换主色时按钮跟着变。
 */
function paintOne(el: HTMLElement) {
  if (el.classList.contains('ant-btn-default')) {
    el.style.setProperty('background', 'var(--g-brand)', 'important')
    el.style.setProperty('color', '#fff', 'important')
    el.style.setProperty('border-color', 'var(--g-brand)', 'important')
  } else if (el.classList.contains('ant-tag')) {
    el.style.setProperty('background', 'transparent', 'important')
  }
}

function paintGlassSurfaces(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.ant-btn-default, .ant-tag').forEach(paintOne)
}

let paintObserver: MutationObserver | null = null

onMounted(() => {
  installHorizontalDrag()
  paintGlassSurfaces()
  paintObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        // 节点自己也可能就是按钮 —— 之前只扫了它的后代，动态渲染的按钮全漏了
        paintOne(node)
        paintGlassSurfaces(node)
      }
    }
  })
  paintObserver.observe(document.body, { childList: true, subtree: true })
})

onBeforeUnmount(() => {
  paintObserver?.disconnect()
  paintObserver = null
})

// 换主题色 / 深浅色后重新刷一遍
watch(
  () => [appStore.mode, appStore.effectivePrimary],
  () => paintGlassSurfaces(),
)

const themeConfig = computed(() =>
  useThemeConfig({
    isDark: appStore.isDark,
    primaryColor: appStore.live.primaryColor,
    borderRadius: appStore.live.borderRadius,
    fontSize: appStore.live.fontSize,
    glass: appStore.live.themeId === 'glass',
  }),
)

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
  <ConfigProvider
    :locale="zhCN"
    :theme="themeConfig"
    :get-popup-container="getPopupContainer"
    :wave="{ disabled: appStore.isMobile }"
  >
    <RouterView />
  </ConfigProvider>
</template>
