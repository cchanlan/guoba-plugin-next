import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { THEME_STORAGE_KEY } from '@/utils/env'

export type ThemeMode = 'dark' | 'light'

const SIDEBAR_KEY = 'guoba:sidebar-collapsed'

/** 窄屏断点：侧边栏改为覆盖式抽屉，不再挤占内容宽度 */
const MOBILE_QUERY = '(max-width: 768px)'

export const useAppStore = defineStore('app', () => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null
  // 默认深色，这套配色以深色为主基调
  const theme = ref<ThemeMode>(stored === 'light' ? 'light' : 'dark')
  const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_KEY) === '1')

  const isMobile = ref(window.matchMedia(MOBILE_QUERY).matches)
  /** 仅窄屏使用：抽屉是否展开 */
  const drawerOpen = ref(false)

  const isDark = computed(() => theme.value === 'dark')

  function applyTheme() {
    const root = document.documentElement
    root.setAttribute('data-theme', theme.value)
    root.style.colorScheme = theme.value
  }

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  /** 窄屏切抽屉，宽屏切收窄 —— 同一个按钮两种语义 */
  function toggleSidebar() {
    if (isMobile.value) {
      drawerOpen.value = !drawerOpen.value
    } else {
      sidebarCollapsed.value = !sidebarCollapsed.value
    }
  }

  function closeDrawer() {
    drawerOpen.value = false
  }

  /** 监听断点变化：进窄屏关抽屉，回宽屏恢复本地保存的收窄状态 */
  function setupResponsive() {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryList | MediaQueryListEvent) => {
      isMobile.value = e.matches
      drawerOpen.value = false
    }
    mql.addEventListener('change', onChange)
    onChange(mql)
  }

  watch(
    theme,
    (val) => {
      localStorage.setItem(THEME_STORAGE_KEY, val)
      applyTheme()
    },
    { immediate: true },
  )

  watch(sidebarCollapsed, (val) => {
    localStorage.setItem(SIDEBAR_KEY, val ? '1' : '0')
  })

  return {
    theme,
    isDark,
    sidebarCollapsed,
    isMobile,
    drawerOpen,
    toggleTheme,
    toggleSidebar,
    closeDrawer,
    setupResponsive,
    applyTheme,
  }
})
