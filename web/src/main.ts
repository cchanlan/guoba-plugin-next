import * as Vue from 'vue'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Antd from 'ant-design-vue'
import App from './App.vue'
import router from './router'
import { bindAuthToRequest } from './stores/auth'
import { useGateStore } from './stores/gate'
import { setGateBlockedHandler, setGateTokenGetter, setFrozenHandler } from './api/request'
import { defHttp } from './api/compat'
import { componentMap } from './components/schema-form/componentMap'
import { createCompatMap } from './compat/componentMapCompat'
import { setupOfflineIcons } from './components/icons'
import './styles/index.css'

// 先注册内置图标，避免首屏去 iconify 公共 API 拉图标
setupOfflineIcons()

const app = createApp(App)

app.use(createPinia())
// pinia 就绪后再把 token / 401 处理注入请求层
bindAuthToRequest(() => {
  const current = router.currentRoute.value
  if (current.meta?.public) return
  router.replace({ path: '/login', query: { redirect: current.fullPath } })
})

// 二级密码：请求头带上解锁凭证；被拦时把状态同步到 store 并切到锁屏页
setGateTokenGetter(() => useGateStore().gateToken || undefined)
setGateBlockedHandler((code, data) => {
  const gate = useGateStore()
  gate.applyBlocked(code, data)
  const current = router.currentRoute.value
  if (current.path === '/gate' || current.meta?.public || !current.path) return
  router.replace({ path: '/gate', query: { redirect: current.fullPath } })
})

// 面板冻结：直接切到冻结页
setFrozenHandler(() => {
  const current = router.currentRoute.value
  if (current.path === '/frozen') return
  router.replace('/frozen')
})

app.use(router)
app.use(Antd)

/**
 * 老锅巴（1.x）插件的自定义组件通过 assets/index.js 那份桥接拿运行环境，
 * 这里把 Vue、请求工具和带 Map 语义的 componentMap 挂到全局。
 * 桥接模块在 import 本文件之后才读这些值，顺序是安全的。
 */
;(window as any).__GUOBA_VUE__ = Vue
;(window as any).__GUOBA_DEF_HTTP__ = defHttp
;(window as any).__GUOBA_COMPONENT_MAP__ = createCompatMap(componentMap)

app.mount('#app')

// 移除首屏 loading
const boot = document.getElementById('boot')
if (boot) {
  boot.style.opacity = '0'
  setTimeout(() => boot.remove(), 300)
}

