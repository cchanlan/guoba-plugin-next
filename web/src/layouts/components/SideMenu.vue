<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Menu } from 'ant-design-vue'
import type { ItemType } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { useAuthStore } from '@/stores/auth'
import type { MenuItem } from '@/types'

const props = defineProps<{ collapsed: boolean }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const selectedKeys = ref<string[]>([])
const openKeys = ref<string[]>([])

/** 后端菜单项转 antd Menu 需要的结构 */
function toMenuItem(item: MenuItem): ItemType | null {
  const meta = item.meta ?? {}
  if (meta.hideMenu) return null

  const plugin = item.guobaMeta?.plugin
  const icon = plugin?.icon ?? meta.icon
  const iconPath = plugin?.iconPath
  const iconColor = plugin?.iconColor

  const children = (item.children ?? [])
    .map(toMenuItem)
    .filter((v): v is ItemType => v != null)

  return {
    key: item.path,
    label: meta.title ?? item.name,
    icon: () =>
      h(GIcon, {
        icon: icon,
        src: iconPath,
        color: iconColor,
        size: 17,
      }),
    ...(children.length ? { children } : {}),
  } as ItemType
}

const menuItems = computed<ItemType[]>(() =>
  auth.menus.map(toMenuItem).filter((v): v is ItemType => v != null),
)

/** 收集所有可跳转的菜单路径，用于把当前路由映射到最匹配的菜单项 */
function collectPaths(items: MenuItem[], acc: string[] = []): string[] {
  for (const item of items) {
    acc.push(item.path)
    if (item.children?.length) collectPaths(item.children, acc)
  }
  return acc
}

/** 找出当前路由对应的父级菜单，用于展开子菜单 */
function findParents(items: MenuItem[], target: string, trail: string[] = []): string[] {
  for (const item of items) {
    if (item.path === target) return trail
    if (item.children?.length) {
      const found = findParents(item.children, target, [...trail, item.path])
      if (found.length || item.children.some((c) => c.path === target)) {
        return found.length ? found : [...trail, item.path]
      }
    }
  }
  return []
}

watch(
  () => route.path,
  (path) => {
    const all = collectPaths(auth.menus)
    // 精确匹配优先，否则取最长前缀（插件详情页等）
    let matched = all.find((p) => p === path)
    if (!matched) {
      matched = all
        .filter((p) => p !== '/' && path.startsWith(p))
        .sort((a, b) => b.length - a.length)[0]
    }
    selectedKeys.value = matched ? [matched] : [path]
    if (matched && !props.collapsed) {
      openKeys.value = findParents(auth.menus, matched)
    }
  },
  { immediate: true },
)

// 收起时不保留展开状态，避免展开后立刻被折叠造成闪烁
watch(
  () => props.collapsed,
  (val) => {
    if (val) openKeys.value = []
  },
)

function onClick({ key }: { key: string | number }) {
  const path = String(key)
  // 带占位参数的路由（如 /plugin/@/:name）不可直接跳转
  if (path.includes(':')) return
  if (path !== route.path) router.push(path)
}
</script>

<template>
  <Menu
    v-model:openKeys="openKeys"
    :selectedKeys="selectedKeys"
    mode="inline"
    theme="light"
    :inlineCollapsed="props.collapsed"
    :items="menuItems"
    class="g-side-menu"
    @click="onClick"
  />
</template>

<style scoped>
.g-side-menu {
  border-inline-end: none !important;
  background: transparent;
  padding: 8px 0 24px;
}
</style>
