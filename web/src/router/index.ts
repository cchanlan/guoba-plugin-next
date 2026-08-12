import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import BasicLayout from '@/layouts/BasicLayout.vue'
import { useAuthStore } from '@/stores/auth'

/**
 * 路由采用「静态路由 + 动态侧边栏」：
 * 后端 /getMenuList 返回的 component 字段是固定的几个路径（见 server/service/both/system/model/menus/），
 * 所以这里把页面静态声明好，菜单接口只用于生成侧边栏与插件入口，避免运行时拼装组件带来的不确定性。
 *
 * 使用 hash 模式，因为 #锅巴登录 下发的地址形如 http://host:port/#/ml/{code}，
 * 且后端未对前端路由做 history fallback。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/login/index.vue'),
    meta: { title: '登录', public: true },
  },
  {
    // #锅巴登录 下发的免密登录地址
    path: '/ml/:code',
    name: 'MagicLogin',
    component: () => import('@/views/login/MagicLogin.vue'),
    meta: { title: '正在登录', public: true },
  },
  {
    path: '/',
    component: BasicLayout,
    redirect: '/home',
    children: [
      {
        path: 'home',
        name: 'Home',
        component: () => import('@/views/home/index.vue'),
        meta: { title: '首页', icon: 'ant-design:home-outlined' },
      },
      {
        path: 'config',
        name: 'Config',
        component: () => import('@/views/config/index.vue'),
        meta: { title: '配置管理', icon: 'ant-design:setting-outlined' },
      },
      {
        path: 'chat',
        name: 'Chat',
        component: () => import('@/views/chat/index.vue'),
        meta: { title: '消息记录', icon: 'ant-design:message-outlined' },
      },
      {
        path: 'log',
        name: 'Log',
        component: () => import('@/views/log/index.vue'),
        meta: { title: '运行日志', icon: 'ant-design:file-search-outlined' },
      },
      {
        path: 'sandbox',
        name: 'Sandbox',
        component: () => import('@/views/sandbox/index.vue'),
        meta: { title: '沙盒', icon: 'ant-design:experiment-outlined' },
      },
      {
        path: 'data',
        name: 'Data',
        component: () => import('@/views/data/index.vue'),
        meta: { title: '数据浏览', icon: 'ant-design:database-outlined' },
      },
      {
        path: 'files',
        name: 'FileManager',
        component: () => import('@/views/files/index.vue'),
        meta: { title: '文件管理', icon: 'ant-design:folder-outlined' },
      },
      {
        path: 'plugins',
        name: 'PluginsStore',
        component: () => import('@/views/plugins/index.vue'),
        meta: { title: '插件管理', icon: 'ant-design:api-outlined' },
      },
      {
        // 后端菜单里有 /plugins/index 这个路径（pluginMenus.js），保持可达
        path: 'plugins/index',
        name: 'PluginsIndex',
        redirect: '/plugins',
      },
      {
        // 插件配置父级菜单，本身不渲染内容
        path: 'plugin/@',
        name: 'PluginDetailParent',
        redirect: '/plugins',
      },
      {
        // 插件配置详情，name 为插件唯一标识
        path: 'plugin/@/:name',
        name: 'PluginDetail',
        component: () => import('@/views/plugins/PluginDetail.vue'),
        meta: { title: '插件配置' },
      },
      {
        path: 'plugin/extra/miao-plugin',
        name: 'MiaoPlugin',
        component: () => import('@/views/miao/index.vue'),
        meta: { title: '喵喵帮助', icon: 'ant-design:heart-outlined' },
      },
      {
        // 扩展页面父级菜单，本身不渲染内容
        path: 'custom',
        name: 'CustomPageParent',
        redirect: '/custom/manage',
      },
      {
        // 页面管理，得排在 custom/:id 前面才不会被当成一个页面 id
        path: 'custom/manage',
        name: 'CustomPageManage',
        component: () => import('@/views/custom/manage.vue'),
        meta: { title: '页面管理' },
      },
      {
        // 自定义页面，id 为页面唯一标识
        path: 'custom/:id',
        name: 'CustomPage',
        component: () => import('@/views/custom/index.vue'),
        meta: { title: '扩展页面' },
      },
      {
        path: 'account',
        name: 'Account',
        component: () => import('@/views/account/index.vue'),
        meta: { title: '账号管理', icon: 'ant-design:user-outlined' },
      },
      {
        path: 'about',
        name: 'About',
        component: () => import('@/views/about/index.vue'),
        meta: { title: '关于', icon: 'ant-design:info-circle-outlined' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/error/NotFound.vue'),
    meta: { title: '页面不存在', public: true },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (to.meta?.public) {
    return true
  }

  if (!auth.isLogin) {
    return { path: '/login', query: to.fullPath === '/home' ? {} : { redirect: to.fullPath } }
  }

  // 已登录但还没拉过用户信息（例如刷新页面），先补齐
  if (!auth.menuLoaded) {
    try {
      await auth.loadUserInfo()
    } catch {
      // 拉取失败通常意味着 token 失效，交给登录页
      auth.reset()
      return { path: '/login' }
    }
  }

  return true
})

router.afterEach((to) => {
  const title = (to.meta?.title as string) || ''
  document.title = title ? `${title} · 锅巴面板` : '锅巴面板'
})

export default router
