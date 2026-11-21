import path from 'path'
import {pathToFileURL} from 'url'
import {_paths} from './paths.js'
import {_version} from './package.js'
import {formatLogDisplay, inlineLogJson, sliceLogText} from './logText.js'
import {normalizeLogImage} from './logMessage.js'

/**
 * 日志出图。
 *
 * 面板里的「发给主人」和聊天里的 `#锅巴日志` 都走这一份：同一个模板、同一套配色，
 * 两边发出来的图长得一模一样。日志正文来自 LogService 的内存缓冲（进程内接管 stdout
 * 收下来的，比磁盘上的 command.log 全），这里只负责排版和截图。
 */

/** 模板文件 */
const TPL_FILE = path.join(_paths.pluginRoot, 'resources/html/log.html')
/**
 * 模板里的资源前缀（字体）。
 *
 * 渲染后的 html 被宿主写到 temp/html 下，跟模板不在同一层，只能给绝对路径；
 * Windows 的反斜杠在 CSS url() 里是转义符，统一换成正斜杠。
 */
const RES_PATH = `${path.join(_paths.resources, 'fonts')}/`.replace(/\\/g, '/')

/** 一条日志最多显示多少行 —— 一个异常堆栈动辄上百行，整张图会被顶到几万像素 */
const MAX_ROWS_PER_ITEM = 12
/** 一条日志正文最多多少字符 */
const MAX_TEXT_LEN = 1000
// 打码由 logText.js 统一处理，面板、图片与文字兜底使用相同口径。

/** log4js 的级别名 → 徽章上显示的四字缩写，跟控制台里的 `%4.4p` 一致 */
const LEVEL_TAGS = {
  trace: 'TRAC',
  debug: 'DEBU',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERRO',
  fatal: 'FATA',
  mark: 'MARK',
}

/** 渲染器探测结果，null 表示这个宿主没有可用的渲染器；undefined 表示还没探过 */
let cachedRenderer

/**
 * 把 LogService 的行合并成出图用的条目。
 *
 * 续行（堆栈、裸 console.log 的后续行）没有自己的时间和级别，并进上一条里，
 * 一条日志就是一个条目 —— 否则堆栈会被拆成十几个只有正文的块。
 *
 * 返回的条目**新的在前**：QQ 里打开长图先看到的是顶部，最上面就该是触发前那一刻；
 * 按时间正序排的话，日志稀疏时顶部是几分钟前的旧日志，看着像不是实时的。
 *
 * @param lines LogService.query 返回的行（时间正序）
 * @param maxItems 最多保留多少条（取最新的），传 0 表示不限
 */
export function mergeLogLines(lines, maxItems = 50) {
  const items = []
  for (const line of Array.isArray(lines) ? lines.slice(-2000) : []) {
    if (!line) continue
    const text = sliceLogText(line.text, 4096)
    const last = items[items.length - 1]
    if (line.cont && last) {
      last.message += `\n${text}`
      continue
    }
    items.push({
      time: line.time || '',
      level: LEVEL_TAGS[String(line.level || '').toLowerCase()] || 'INFO',
      message: text,
    })
  }
  // 续行要按正序合并完才能翻转，否则堆栈会挂到下一条日志上
  const picked = maxItems > 0 ? items.slice(-maxItems) : items
  return picked.reverse().map(clampItem)
}

/** 把过长的一条压到出图能承受的范围 */
function clampItem(item) {
  let message = formatLogDisplay(item.message)
  const rows = message.split('\n')
  if (rows.length > MAX_ROWS_PER_ITEM) {
    const rest = rows.length - MAX_ROWS_PER_ITEM
    message = `${rows.slice(0, MAX_ROWS_PER_ITEM).join('\n')}\n…(另有 ${rest} 行未显示)`
  }
  if (message.length > MAX_TEXT_LEN) {
    message = `${sliceLogText(message, MAX_TEXT_LEN)} …(已截断)`
  }
  return {...item, message}
}

/** 兜底用的纯文本，渲染器不可用时改发文字 */
export function formatLogText(items) {
  return items
    .map((it) => (it.time ? `[${it.time}][${it.level}] ${it.message}` : it.message))
    .join('\n')
}

function defaultFooter(count) {
  const now = new Date().toLocaleString('zh-CN', {hour12: false})
  return `共 ${count} 条 · ${now} · Guoba-Plugin v${_version}`
}

/**
 * 把日志条目渲染成图。
 *
 * 只出一张完整的图：宿主的分片截图（multiPage）是把同一页按 4000px 切开，除了第一张
 * 之后的每张都没有标题、也没有外框，看着像被裁下来的碎片，跟聊天里那张对不上。
 * 想控制图的长度就少给几条，别指望分片。
 *
 * @param items mergeLogLines 的结果
 * @param options {{title?: string, footer?: string}}
 * @return {Promise<?{image: any, count: number}>} 渲染不出来返回 null，调用方自己决定怎么兜底
 */
export async function renderLogImage(items, options = {}) {
  if (!items?.length) return null
  try {
    // 探测渲染器也属于可能失败的边界，不能放在文字兜底的保护范围之外。
    const renderer = await getRenderer()
    if (!renderer) {
      logger.warn('[Guoba] 没有可用的图片渲染器，日志改发文本')
      return null
    }
    const data = {
      tplFile: TPL_FILE,
      saveId: 'guoba-log',
      logs: inlineLogJson(items),
      ResPath: RES_PATH,
      title: options.title || '锅巴日志',
      footer: options.footer ?? defaultFooter(items.length),
      // PNG 保留小字且被各协议普遍接受，不把浏览器支持 WebP 等同于发送端支持。
      imgType: 'png',
    }
    const img = normalizeLogImage(await renderer.screenshot('guoba-log', data))
    return img ? {image: img, count: items.length} : null
  } catch (err) {
    logger.error(`[Guoba] 日志出图异常：${sliceLogText(formatLogDisplay(err?.stack || err?.message || err), 1000)}`)
    return null
  }
}

/**
 * 找一个能出图的渲染器。
 *
 * 锅巴要兼容 Miao-Yunzai（V3 / V4）和 TRSS-Yunzai，各家的渲染器摆放位置不一样，
 * 而且宿主也可能压根没装渲染后端 —— 所以只做动态探测，探不到就让调用方发文本，
 * 绝不能因为 import 不到某个路径把整个插件的加载搞崩。
 */
export async function getRenderer() {
  if (cachedRenderer) return cachedRenderer
  cachedRenderer = await findRenderer()
  return cachedRenderer
}

async function findRenderer() {
  try {
    const file = path.join(_paths.root, 'lib/puppeteer/puppeteer.js')
    const renderer = (await import(pathToFileURL(file).href)).default
    if (typeof renderer?.screenshot === 'function') return renderer
  } catch {
    // 换下一种
  }
  // 部分宿主只把渲染器挂在全局
  const global_ = global.Renderer
  if (typeof global_?.screenshot === 'function') return global_
  if (typeof global_?.getRenderer === 'function') {
    try {
      const renderer = global_.getRenderer()
      if (typeof renderer?.screenshot === 'function') return renderer
    } catch {
      // 忽略，继续往下探
    }
  }
  if (typeof global.puppeteer?.screenshot === 'function') return global.puppeteer
  return null
}
