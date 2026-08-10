/**
 * 运行时环境信息。
 *
 * 这些值由后端注入：
 * - `window.__YUNZAI_BOT_CONF__` 来自 server/preload/ConfigPreload.js
 * - `window.__GUOBA_CONF__` 同上
 *
 * 开发模式下后端不会注入，这里提供与后端一致的兜底值。
 */

/** 后端真实挂载前缀，见 utils/paths.js 的 realMountPrefix */
export const REAL_MOUNT_PREFIX = '/guoba-plugin-mock-root'

const botConf = (window as any).__YUNZAI_BOT_CONF__ ?? {}
const guobaConf = (window as any).__GUOBA_CONF__ ?? {}

/** 请求头中携带 token 的字段名，与 server/constant/Constant.js 保持一致 */
export const TOKEN_KEY: string = botConf.TOKEN_KEY ?? 'guoba-access-token'

/**
 * 自定义页面静态资源用的弱令牌 Cookie 名，与 server/constant/Constant.js 保持一致。
 * iframe 里相对引用的 css/js 带不上请求头，只能靠它过鉴权。
 */
export const LITE_TOKEN_COOKIE = 'guoba-lite-token'

/** 接口根地址 */
export const API_BASE = `${REAL_MOUNT_PREFIX}/api`

/** Yunzai 版本 */
export const YUNZAI_VERSION: string = botConf.VERSION ?? '-'

/** 锅巴版本 */
export const GUOBA_VERSION: string = guobaConf.VERSION ?? botConf.GUOBA_VERSION ?? '-'

/** 适配的接口前缀标记（/v3 或 /v2），仅用于展示与能力判断 */
export const API_PREFIX: string = botConf.API_PREFIX ?? '/v3'

/** 是否 V2 环境（V2 下大量功能不可用） */
export const IS_V2 = API_PREFIX === '/v2'

/** ICP 备案号，配置了才展示 */
export const ICP_NO: string = guobaConf.ICP_NO ?? ''

/** localStorage 中保存 token 的键 */
export const TOKEN_STORAGE_KEY = 'guoba:token'

/** localStorage 中保存主题的键 */
export const THEME_STORAGE_KEY = 'guoba:theme'

/** 拼接后端资源地址（图标、图片等） */
export function withMountPrefix(path: string): string {
  if (!path) return path
  if (/^(https?:)?\/\//.test(path)) return path
  if (path.startsWith(REAL_MOUNT_PREFIX)) return path
  return `${REAL_MOUNT_PREFIX}${path.startsWith('/') ? '' : '/'}${path}`
}
