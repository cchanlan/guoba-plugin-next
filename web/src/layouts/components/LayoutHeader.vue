<script setup lang="ts">
import { computed, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Avatar,
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Dropdown,
  LayoutHeader as AHeader,
  Menu,
  MenuDivider,
  MenuItem,
  Modal,
  Tooltip,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { apiRestartBot, apiRestartGuoba } from '@/api'
import type { MenuItem as GMenuItem } from '@/types'

const appStore = useAppStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

/** 用后端菜单树推导面包屑；找不到时退化为当前路由 meta.title */
const breadcrumbs = computed<string[]>(() => {
  const path = route.path

  function walk(items: GMenuItem[], trail: string[]): string[] | null {
    for (const item of items) {
      const title = item.meta?.title ?? item.name
      const nextTrail = [...trail, title]
      if (item.path === path) return nextTrail
      if (item.children?.length) {
        const found = walk(item.children, nextTrail)
        if (found) return found
      }
    }
    return null
  }

  const found = walk(auth.menus, [])
  if (found) return found

  const title = route.meta?.title as string | undefined
  return title ? [title] : []
})

const userName = computed(
  () => auth.user?.realName || String(auth.user?.username ?? '') || '未登录',
)

const avatarText = computed(() => {
  // 昵称可能以颜文字或标点开头（如 `(o° ▽° )o☆`），直接取首字符会渲染出一个括号，
  // 这里跳过符号，取第一个字母/数字/汉字
  const matched = userName.value.match(/[\p{L}\p{N}]/u)
  return matched ? matched[0].toUpperCase() : 'G'
})

/**
 * 机器人头像。地址由后端按适配器算好（server/service/both/model/avatar.js）——
 * 官方机器人、stdin 这类账号没有公开地址，那时是空串，Avatar 自己退回上面的首字；
 * 图片加载失败（断网、腾讯挂了）也会退回去，不用额外处理。
 */
const avatarUrl = computed(() => auth.user?.avatar || '')

function confirmRestartBot() {
  Modal.confirm({
    title: '重启 Bot',
    content: '将重启整个 Yunzai 进程，期间机器人会短暂离线。确定继续？',
    okText: '确定重启',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await apiRestartBot()
    },
  })
}

function confirmRestartGuoba() {
  Modal.confirm({
    title: '重启锅巴服务',
    content: '仅重启锅巴的服务端，不影响机器人本体。确定继续？',
    okText: '确定重启',
    cancelText: '取消',
    onOk: async () => {
      await apiRestartGuoba()
      message.info('锅巴服务已重启，如页面异常请刷新')
    },
  })
}

function confirmLogout() {
  Modal.confirm({
    title: '退出登录',
    content: '退出后需要重新输入用户名和密码登录，本机的可信设备记录会保留。',
    okText: '退出',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await auth.logout()
      router.replace('/login')
    },
  })
}

const userMenu = () =>
  h(Menu, null, {
    default: () => [
      h(
        MenuItem,
        { key: 'account', onClick: () => router.push('/account') },
        { default: () => '账号管理' },
      ),
      h(
        MenuItem,
        { key: 'about', onClick: () => router.push('/about') },
        { default: () => '关于锅巴' },
      ),
      h(MenuDivider),
      h(
        MenuItem,
        { key: 'restart-guoba', onClick: confirmRestartGuoba },
        { default: () => '重启锅巴服务' },
      ),
      h(
        MenuItem,
        { key: 'restart-bot', danger: true, onClick: confirmRestartBot },
        { default: () => '重启 Bot' },
      ),
      h(MenuDivider),
      h(
        MenuItem,
        { key: 'logout', danger: true, onClick: confirmLogout },
        { default: () => '退出登录' },
      ),
    ],
  })
</script>

<template>
  <AHeader class="g-header">
    <div class="g-header-left">
      <Button type="text" class="g-icon-btn" @click="appStore.toggleSidebar()">
        <GIcon
          :icon="appStore.sidebarCollapsed ? 'ant-design:menu-unfold-outlined' : 'ant-design:menu-fold-outlined'"
          :size="17"
        />
      </Button>

      <Breadcrumb v-if="breadcrumbs.length" class="g-breadcrumb">
        <BreadcrumbItem v-for="(item, idx) in breadcrumbs" :key="idx">
          {{ item }}
        </BreadcrumbItem>
      </Breadcrumb>
    </div>

    <div class="g-header-right">
      <Tooltip :title="appStore.isDark ? '切换到浅色' : '切换到深色'">
        <Button type="text" class="g-icon-btn" @click="appStore.toggleTheme()">
          <GIcon
            :icon="appStore.isDark ? 'ant-design:sun-outlined' : 'ant-design:moon-outlined'"
            :size="17"
          />
        </Button>
      </Tooltip>

      <Dropdown :trigger="['click']">
        <div class="g-user">
          <Avatar :size="28" class="g-avatar" :src="avatarUrl">{{ avatarText }}</Avatar>
          <span class="g-user-name">{{ userName }}</span>
          <GIcon icon="ant-design:down-outlined" :size="11" />
        </div>
        <template #overlay>
          <component :is="userMenu" />
        </template>
      </Dropdown>
    </div>
  </AHeader>
</template>

<style scoped>
.g-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 16px 0 8px;
  line-height: 56px;
  border-bottom: 1px solid var(--g-border);
  flex-shrink: 0;
}

.g-header-left,
.g-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/**
 * antd 的 .ant-btn 自带 padding: 4px 15px，这里又把宽度锁成 34px，
 * 图标作为 flex item 会被横向压扁成一个小点，所以必须清掉 padding，
 * 并禁止图标收缩。
 */
.g-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--g-text-sub);
}

.g-breadcrumb {
  margin-left: 4px;
  font-size: 13px;
}

.g-user {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  cursor: pointer;
  color: var(--g-text-sub);
}

.g-avatar {
  background: var(--g-brand);
  color: #1a1408;
  font-weight: 600;
}

.g-user-name {
  font-size: 13px;
  color: var(--g-text);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .g-header {
    padding: 0 8px 0 4px;
  }

  /* 窄屏优先保证内容区，面包屑与用户名让位 */
  .g-breadcrumb {
    font-size: 12px;
    max-width: 42vw;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .g-user-name {
    display: none;
  }

  .g-user {
    padding: 4px;
  }
}
</style>
