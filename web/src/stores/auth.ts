import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  apiCheckLoginCode,
  apiGetLoginUser,
  apiGetMenuList,
  apiGetPermCode,
  apiLogout,
  apiQuickLogin,
} from '@/api'
import { setTokenGetter, setUnauthorizedHandler } from '@/api/request'
import { TOKEN_STORAGE_KEY } from '@/utils/env'
import type { LoginUser, MenuItem } from '@/types'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')
  /** 弱令牌，用于请求图片等静态资源 */
  const liteToken = ref<string>('')
  const user = ref<LoginUser | null>(null)
  const menus = ref<MenuItem[]>([])
  /** 菜单是否已拉取，用于路由守卫决定要不要动态注册路由 */
  const menuLoaded = ref(false)

  const isLogin = computed(() => !!token.value)

  function setToken(value: string) {
    token.value = value
    if (value) {
      localStorage.setItem(TOKEN_STORAGE_KEY, value)
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  }

  /** 清空所有登录态（不发请求） */
  function reset() {
    setToken('')
    liteToken.value = ''
    user.value = null
    menus.value = []
    menuLoaded.value = false
  }

  /** 主人快速登录：#锅巴登录 给出的链接里带的 code */
  async function loginByCode(code: string) {
    const data = await apiQuickLogin(code)
    setToken(data.token)
    return data.token
  }

  /** 控制台验证码登录 */
  async function loginByConsoleCode(code: string) {
    const data = await apiCheckLoginCode(code)
    setToken(data.token)
    return data.token
  }

  /** 聊天确认登录：主人发「#锅巴确认登录」后拿到的 token */
  function loginByConfirmToken(value: string) {
    setToken(value)
    return value
  }

  async function logout() {
    const current = token.value
    reset()
    if (current) {
      // 通知后端销毁 token，失败也无所谓，本地已清空
      await apiLogout(current).catch(() => undefined)
    }
  }

  /** 拉取用户信息、权限、菜单 */
  async function loadUserInfo() {
    const [userInfo, perm, menuList] = await Promise.all([
      apiGetLoginUser(),
      apiGetPermCode(),
      apiGetMenuList(),
    ])
    user.value = userInfo
    liteToken.value = perm?.liteToken ?? ''
    menus.value = Array.isArray(menuList) ? menuList : []
    menuLoaded.value = true
    return menus.value
  }

  return {
    token,
    liteToken,
    user,
    menus,
    menuLoaded,
    isLogin,
    setToken,
    reset,
    loginByCode,
    loginByConsoleCode,
    loginByConfirmToken,
    logout,
    loadUserInfo,
  }
})

/**
 * 把 token 与 401 处理注入到 axios 层。
 * 在 main.ts 里 pinia 安装完成后调用一次。
 */
export function bindAuthToRequest(onUnauthorized: () => void) {
  const store = useAuthStore()
  setTokenGetter(() => store.token || undefined)
  setUnauthorizedHandler(() => {
    store.reset()
    onUnauthorized()
  })
}
