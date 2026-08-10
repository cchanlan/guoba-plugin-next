import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Antd from 'ant-design-vue'
import App from './App.vue'
import router from './router'
import { bindAuthToRequest } from './stores/auth'
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

app.use(router)
app.use(Antd)

app.mount('#app')

// 移除首屏 loading
const boot = document.getElementById('boot')
if (boot) {
  boot.style.opacity = '0'
  setTimeout(() => boot.remove(), 300)
}
