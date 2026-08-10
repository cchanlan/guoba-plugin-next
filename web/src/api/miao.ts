import { del, get, post } from './request'
import { API_BASE } from '@/utils/env'
import type { MiaoBackupItem, MiaoHelpCfg, MiaoThemeItem } from '@/types'

/**
 * 喵喵插件相关接口，见 server/controller/plugin/MiaoPluginController.js。
 * 注意：这些路由只有在装了 miao-plugin 时才会注册，未安装时会 404。
 *
 * 参数名沿用后端约定（themeName 而非 name），见 MiaoPluginService。
 */

/** 未安装喵喵插件时该路由未注册，会拿到 404，所以不自动弹错误，交给页面判断 */
export const apiGetMiaoHelpCfg = () =>
  get<MiaoHelpCfg>('/plugin/miao/help', undefined, { showError: false })

/**
 * 保存喵喵帮助配置。
 *
 * 后端 saveHelpSetting 会做：
 *   helpCfg = JSON.parse(helpCfg)        → 必须是 JSON 字符串
 *   `export const helpList = ${helpList}` → 必须是合法的 JS 字面量源码
 * 并从 req.files 里取第一个文件当 icon，所以必须用 FormData。
 */
export const apiSaveMiaoHelpCfg = (formData: FormData) =>
  post('/plugin/miao/help', formData, { showSuccess: true })

export const apiGetMiaoThemeList = () => get<MiaoThemeItem[]>('/plugin/miao/help/theme/list')

export const apiGetMiaoThemeConfig = (themeName: string) =>
  get<any>('/plugin/miao/help/theme/config', { themeName })

export const apiSaveMiaoThemeConfig = (themeName: string, config: any) =>
  post('/plugin/miao/help/theme/config', { themeName, config }, { showSuccess: true })

/** 新增皮肤，FormData 需含 themeName 与 main.png 文件 */
export const apiAddMiaoTheme = (formData: FormData) =>
  post('/plugin/miao/help/theme/action', formData, { showSuccess: true })

/** 修改皮肤底图，FormData 需含 themeName 与 main.png 文件 */
export const apiPutMiaoTheme = (formData: FormData) =>
  post('/plugin/miao/help/theme/action_put', formData, { showSuccess: true })

export const apiDeleteMiaoTheme = (themeName: string) =>
  del('/plugin/miao/help/theme/action', { themeName }, { showSuccess: true })

export const apiGetMiaoBackupList = () => get<MiaoBackupItem[]>('/plugin/miao/help/backup/list')

export const apiAddMiaoBackup = (remark: string) =>
  post('/plugin/miao/help/backup', { remark }, { showSuccess: true })

export const apiRestoreMiaoBackup = (id: string) =>
  post('/plugin/miao/help/backup/restore', { id }, { showSuccess: true })

export const apiDeleteMiaoBackup = (id: string) =>
  del('/plugin/miao/help/backup/delete', { id }, { showSuccess: true })

/**
 * 皮肤底图/主图地址。
 * 这两个接口直接返回图片文件，所以拼成 URL 交给 <img> 用。
 * 后端 TokenInterceptor 对 /api/plugin/miao/help/theme/* 允许弱令牌（liteToken），
 * 通过 query 传 token 即可。
 */
export function miaoThemeMainUrl(themeName: string, token: string, ts?: number) {
  const q = new URLSearchParams({ themeName, token })
  if (ts) q.set('_t', String(ts))
  return `${API_BASE}/plugin/miao/help/theme/main?${q.toString()}`
}

/** 底图（bg.jpg）固定取默认皮肤，后端忽略 themeName */
export function miaoThemeBgUrl(token: string, ts?: number) {
  const q = new URLSearchParams({ token })
  if (ts) q.set('_t', String(ts))
  return `${API_BASE}/plugin/miao/help/theme/bg?${q.toString()}`
}

/** 帮助图标，注意此路径不在 liteToken 白名单内，需用正式 token */
export function miaoHelpIconUrl(token: string, ts?: number) {
  const q = new URLSearchParams({ token })
  if (ts) q.set('_t', String(ts))
  return `${API_BASE}/plugin/miao/help/icon?${q.toString()}`
}
