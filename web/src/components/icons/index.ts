import { addCollection } from '@iconify/vue'
import { ANT_DESIGN_COLLECTION } from './offline'

/**
 * 注册离线图标集。
 *
 * 面板自身用到的图标（前缀 ant-design）全部内置，运行时不会联网。
 * 插件在 guoba.support.js 里声明的图标名可能是任意 iconify 名称，
 * 这类图标仍由 @iconify/vue 按需拉取；离线环境下拉不到就退化为占位，
 * 不影响功能（见 GIcon.vue）。
 */
let registered = false

export function setupOfflineIcons() {
  if (registered) return
  addCollection(ANT_DESIGN_COLLECTION)
  registered = true
}
