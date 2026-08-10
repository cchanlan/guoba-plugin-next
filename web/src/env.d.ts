/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/** 后端 ConfigPreload 注入的全局配置 */
interface YunzaiBotConf {
  VERSION?: string
  GUOBA_VERSION?: string
  API_PREFIX?: string
  TOKEN_KEY?: string
}

interface GuobaConf {
  VERSION?: string
  ICP_NO?: string
}

interface Window {
  __YUNZAI_BOT_CONF__?: YunzaiBotConf
  __GUOBA_CONF__?: GuobaConf
}
