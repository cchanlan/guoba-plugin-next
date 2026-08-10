<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Layout, LayoutContent, LayoutSider } from 'ant-design-vue'
import SideMenu from './components/SideMenu.vue'
import LayoutHeader from './components/LayoutHeader.vue'
import { useAppStore } from '@/stores/app'
import { GUOBA_VERSION, ICP_NO } from '@/utils/env'

const appStore = useAppStore()
const route = useRoute()

const isMobile = computed(() => appStore.isMobile)
// 窄屏抽屉里始终展示完整菜单，收窄态只在宽屏生效
const collapsed = computed(() => !isMobile.value && appStore.sidebarCollapsed)
const siderWidth = computed(() => (isMobile.value ? 232 : 220))

onMounted(() => appStore.setupResponsive())

// 窄屏点菜单跳转后顺手收起抽屉
watch(() => route.fullPath, () => {
  if (isMobile.value) appStore.closeDrawer()
})
</script>

<template>
  <Layout class="g-layout" :class="{ 'is-mobile': isMobile }">
    <div
      v-if="isMobile && appStore.drawerOpen"
      class="g-mask"
      @click="appStore.closeDrawer()"
    />

    <LayoutSider
      :collapsed="collapsed"
      :collapsedWidth="64"
      :width="siderWidth"
      :trigger="null"
      collapsible
      class="g-sider"
      :class="{ 'is-drawer': isMobile, 'is-open': isMobile && appStore.drawerOpen }"
    >
      <div class="g-logo" :class="{ 'is-collapsed': collapsed }">
        <img src="/logo.png" alt="Guoba" class="g-logo-img" />
        <span v-if="!collapsed" class="g-logo-text">
          锅巴面板
          <em>v{{ GUOBA_VERSION }}</em>
        </span>
      </div>

      <div class="g-sider-scroll">
        <SideMenu :collapsed="collapsed" />
      </div>
    </LayoutSider>

    <Layout class="g-main">
      <LayoutHeader />

      <LayoutContent class="g-content">
        <RouterView v-slot="{ Component }">
          <Transition name="g-fade" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </Transition>
        </RouterView>

        <footer v-if="ICP_NO" class="g-footer">{{ ICP_NO }}</footer>
      </LayoutContent>
    </Layout>
  </Layout>
</template>

<style scoped>
.g-layout {
  height: 100vh;
  /* 移动端浏览器地址栏会吃掉高度，有 dvh 就用 dvh */
  height: 100dvh;
  overflow: hidden;
}

.g-sider {
  border-inline-end: 1px solid var(--g-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---- 窄屏：侧边栏改为覆盖式抽屉，不占内容宽度 ---- */
.g-sider.is-drawer {
  position: fixed;
  inset-block: 0;
  inset-inline-start: 0;
  z-index: 100;
  transform: translateX(-100%);
  transition: transform 0.24s ease;
  box-shadow: none;
}

.g-sider.is-drawer.is-open {
  transform: translateX(0);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.35);
}

.g-mask {
  position: fixed;
  inset: 0;
  z-index: 99;
  background: rgba(0, 0, 0, 0.45);
}

.g-sider :deep(.ant-layout-sider-children) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.g-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--g-border);
  overflow: hidden;
}

.g-logo.is-collapsed {
  justify-content: center;
  padding: 0;
}

.g-logo-img {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.g-logo-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--g-text);
  white-space: nowrap;
}

.g-logo-text em {
  display: block;
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  color: var(--g-text-dim);
  line-height: 1.2;
}

.g-sider-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.g-main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.g-content {
  flex: 1;
  overflow-y: auto;
  position: relative;
}

.g-footer {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--g-text-dim);
}

/* 抽屉是 fixed 的，主区域要能压到 0 宽以下再撑开，否则窄屏横向溢出 */
.g-layout.is-mobile .g-main {
  min-width: 0;
  width: 100%;
}
</style>
