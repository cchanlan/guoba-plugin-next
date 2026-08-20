import fs from 'fs'

export const yunzaiPackage = JSON.parse(fs.readFileSync('./package.json', 'utf8'))

// 检查yunzai版本
export const {
  isV2,
  isV3,
  isV4,
  isTRSS,
  hostName,
  noSupport,
  yunzaiVersion,

  hasGenshin,
} = checkVersion()

// 是否开发模式
export const isDev = (process.argv || []).includes('dev')

/**
 * TRSS 系宿主的判定。
 *
 * `isTRSS` 表示的是**能力**而不是某个具体项目：宿主自带 HTTP 服务（能共享端口）、主人配置
 * 是「Bot账号:主人」映射、配置在 `config/config/*.yaml`。TRSS-Yunzai 的 fork 越来越多
 * （Orangezai 等），它们只是改了 package.json 的 name，能力完全一样 —— 早先写死
 * `name === 'trss-yunzai'` 的话，这些宿主上锅巴会另开一个端口、拿不到主人列表，
 * 米游社那套还会因为没有 genshin 直接加载失败。
 *
 * 判定顺序：认识的名字 → 运行时有没有 express 服务 → 配置结构特征。
 * Miao-Yunzai 不会命中：它没有内建 HTTP 服务，`other.yaml` 里也只有 masterQQ。
 */
function detectTRSSLike(name) {
  if (name === 'trss-yunzai') return true
  // 插件是在 Bot 建好服务之后加载的，这个信号最直接
  if (typeof globalThis.Bot?.express === 'function') return true
  // 兜底：万一某个 fork 把插件加载放在建服务之前，就看配置长什么样
  try {
    const other = readIfExists('./config/default_config/other.yaml')
    // 「Bot账号:主人帐号」映射是 TRSS 系独有的，Miao-Yunzai 只有 masterQQ
    if (!/^master:/m.test(other)) return false
    const bot = readIfExists('./config/default_config/bot.yaml')
    const server = readIfExists('./config/default_config/server.yaml')
    // 内建 HTTP 服务的端口，TRSS 放 server.yaml，早期版本和 Orangezai 放 bot.yaml
    return /^port:/m.test(server) || /^port:/m.test(bot)
  } catch {
    return false
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function checkVersion() {
  let isV2 = false, isV3 = false, isV4 = false, noSupport = false

  let {name, version} = yunzaiPackage ?? {}

  if (version) {
    if (version.startsWith('2')) {
      isV2 = true
    } else if (version.startsWith('3')) {
      isV3 = true
    } else if (version.startsWith('4')) {
      isV4 = true
    } else {
      noSupport = true
    }
  }

  const isTRSS = detectTRSSLike(name)

  // v4 need check genshin
  const hasGenshin = fs.existsSync('./plugins/genshin')

  return {
    isV2,
    isV3,
    isV4,
    noSupport,
    isTRSS,
    hostName: name || '',
    yunzaiVersion: version,

    hasGenshin,
  }
}
