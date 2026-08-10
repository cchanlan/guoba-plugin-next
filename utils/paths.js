import fs from 'fs'
import path from 'path'
import {pluginName} from './package.js'

const _path = process.cwd()
export const _paths = initPaths()

function initPaths() {
  // BotData目录
  const data = path.join(_path, 'data')
  // Bot资源目录
  const resources = path.join(_path, 'resources')
  // Guoba插件根目录
  const pluginRoot = path.join(_path, 'plugins', pluginName)
  // Guoba静态资源路径
  // 新版前端（web/ 目录构建产物）输出到 server/static-next，
  // 存在则优先使用；删掉该目录即可回退到旧版 server/static。
  const staticPath = resolveStaticPath(pluginRoot)
  // 插件资源目录
  const pluginResources = path.join(pluginRoot, 'resources')

  return {
    // Bot根目录
    root: _path,
    data,
    resources,
    pluginRoot,
    staticPath,
    pluginResources,

    server: {
      // 真实挂载路径前缀
      realMountPrefix: "/guoba-plugin-mock-root"
    },
  }
}

/**
 * 选择前端静态目录。
 * 只有当 static-next 里确实有 index.html 时才启用，避免半成品目录导致白屏。
 */
function resolveStaticPath(pluginRoot) {
  const next = path.join(pluginRoot, 'server/static-next')
  if (fs.existsSync(path.join(next, 'index.html'))) {
    return next
  }
  return path.join(pluginRoot, 'server/static')
}
