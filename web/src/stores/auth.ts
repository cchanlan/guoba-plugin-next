import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  apiCheckLoginCode,
  apiGetLoginUser,
  apiLogin,
  apiGetLoginStatus,
  apiGetMenuList,
  apiGetPermCode,
  apiLogout,
} from '@/api'
import { setTokenGetter, setUnauthorizedHandler } from '@/api/request'
import { TOKEN_STORAGE_KEY } from '@/utils/env'
import { saveDeviceCredential } from '@/utils/device'
import type { LoginUser, MenuItem } from '@/types'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')
  /** 弱令牌，用于请求图片等静态资源 */
  const liteToken = ref<string>('')
  const user = ref<LoginUser | null>(null)
  const menus = ref<MenuItem[]>([])
  /** 菜单是否已拉取，用于路由守卫决定要不要动态注册路由 */
  const menuLoaded = ref(false)
  /** 是否已设置账号密码；未设置时路由守卫会强制跳到登录安全页 */
  const configured = ref(true)

  const isLogin = computed(() => !!token.value)

  function setToken(value: string) {
    token.value = value
    if (value) {
      localStorage.setItem(TOKEN_STORAGE_KEY, value)
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  }

  /**
   * 清空所有登录态（不发请求）。
   *
   * 设备凭证故意留着：那是「这台机器是我的」，跟「这次会话」是两回事，
   * 退出后重新登录不该再问一次验证码。要作废就去登录安全里撤销设备。
   */
  function reset() {
    setToken('')
    liteToken.value = ''
    user.value = null
    menus.value = []
    menuLoaded.value = false
  }

  async function loginByPassword(username: string, password: string, captcha?: string) {
    const data = await apiLogin({ username, password, captcha })
    setToken(data.token)
    // 后端每次登录都会换一份新的设备凭证，存下来，下次换了IP也不用验证码
    saveDeviceCredential(data.device)
    return data.token
  }

  /** 控制台验证码登录（仅未设置账号密码时可用） */
  async function loginByConsoleCode(code: string) {
    const data = await apiCheckLoginCode(code)
    setToken(data.token)
    return data.token
  }

  async function logout() {
    const current = token.value
    try {
      if (current) {
        // 保留请求头中的 token，等后端销毁成功或失败后再清空本地状态。
        await apiLogout(current).catch(() => undefined)
      }
    } finally {
      reset()
    }
  }

  /** 拉取用户信息、权限、菜单 */
  async function loadUserInfo() {
    const [userInfo, perm, menuList, status] = await Promise.all([
      apiGetLoginUser(),
      apiGetPermCode(),
      apiGetMenuList(),
      apiGetLoginStatus().catch(() => null),
    ])
    user.value = userInfo
    liteToken.value = perm?.liteToken ?? ''
    menus.value = Array.isArray(menuList) ? menuList : []
    menuLoaded.value = true
    if (status) configured.value = status.configured
    return menus.value
  }

  return {
    token,
    liteToken,
    user,
    menus,
    menuLoaded,
    configured,
    isLogin,
    setToken,
    reset,
    loginByPassword,
    loginByConsoleCode,
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
