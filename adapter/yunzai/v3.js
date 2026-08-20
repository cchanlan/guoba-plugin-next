import {hasGenshin} from './version.js'

let Restart
try {
  Restart = (await import('../../../other/restart.js')).Restart
} catch {
  Restart = (await import('./mock/system/apps.js')).Restart
}

let MysInfo, MysUser

/**
 * 米游社那套只在装了 genshin 插件时才有。
 *
 * 判据只看 `plugins/genshin` 在不在，不看宿主是哪一家 —— TRSS 系（含 Orangezai 这类
 * fork）默认不带 genshin，写死「非 TRSS 就 import」会让锅巴在这些宿主上直接加载失败。
 */
if (hasGenshin) {
  MysInfo = (await import('../../../genshin/model/mys/mysInfo.js')).default
  MysUser = (await import('../../../genshin/model/mys/MysUser.js')).default
} else {
  const mys = await import('./mock/genshin/mys.js')
  MysInfo = mys.MysInfo
  MysUser = mys.MysUser
}

export {
  Restart,
  MysInfo,
  MysUser,
}
