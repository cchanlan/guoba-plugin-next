import crypto from 'node:crypto'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import {lookup as dnsLookup} from 'node:dns/promises'
import {autowired, GuobaError, Service} from '#guoba.framework'
import {_paths} from '../../../utils/paths.js'
import {isPrivateIp} from './ChatService.js'
import {MAX_ASSET_SIZE} from './model/msgSegment.js'

/**
 * 消息记录页的表情。
 *
 * 三类来源：
 * - QQ 自带的表情是静态资源（`web/public/faces/`，随前端一起构建），这边不掺和；
 * - bot 收藏的表情在 QQ 服务端，走适配器的 `fetch_custom_face` 现取，取一次缓存一分钟；
 * - 自定义表情存在 `data/guoba/chat-emoji/`，按内容哈希命名，重复上传同一张不会堆文件。
 *
 * 收藏表情的地址是适配器给的，前端会原样传回来，所以拉取前必须校验域名 ——
 * 不然就成了一个能把 Bot 所在内网当图片源读的 SSRF 口子。
 */
const CUSTOM_DIR = path.join(_paths.data, 'guoba', 'chat-emoji')
/**
 * QQ 自带表情图的位置。
 *
 * 正常是构建后的 server/static/faces；没构建过（dev 模式）时退回源码里的
 * web/public/faces，两边内容一样。
 */
const FACE_DIRS = [
  path.join(_paths.staticPath, 'faces'),
  path.join(_paths.pluginRoot, 'web/public/faces'),
]
/** 自定义表情张数上限，够用又不至于把磁盘堆满 */
const CUSTOM_LIMIT = 300
/** 与消息图片的资源上限保持一致，较大的动图也能收藏 */
const MAX_FILE = MAX_ASSET_SIZE
const FILE_TOO_LARGE = `请选择不超过 ${MAX_FILE / 1024 / 1024}MB 的表情`
const BAD_IMAGE = '请选择 PNG、JPG、GIF、WebP 或 BMP 图片'
/** 收藏表情缓存多久（毫秒） */
const FAV_TTL = 60 * 1000
/** 拉收藏表情的超时 */
const FAV_TIMEOUT = 15000
/** 发送时单张收藏表情的下载超时 */
const FETCH_TIMEOUT = 15000

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** 表情 id 只认「内容哈希.扩展名」，别的一律当非法路径 */
const ID_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp|bmp)$/

/**
 * 收藏表情的域名白名单。
 *
 * 这些前缀只会解析到腾讯的公网 CDN，按后缀放行不会把请求引到内网；
 * 适配器返回的地址目前都是 p.qpic.cn，留几个后缀是给商城表情兜底。
 */
const FAV_HOST_SUFFIX = ['.qpic.cn', '.qq.com', '.gtimg.cn', '.qq.com.cn']

function isFavUrl(url) {
  let u
  try {
    u = new URL(String(url ?? ''))
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase()
  return FAV_HOST_SUFFIX.some((suffix) => host.endsWith(suffix))
}

/** 按文件头认图片，不信上传时浏览器报的 MIME */
function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  return ''
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GuobaError(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class ChatEmojiService extends Service {

  /** 取消息缓冲里的段（右键收藏表情要按 messageId 找那条） */
  chatService = autowired('chatService')

  /** botId -> {at, urls} */
  #favCache = new Map()
  /** botId -> Promise，同一时刻只打一次适配器 */
  #favPending = new Map()
  /** 收藏表情发送时的字节缓存：url -> {at, buffer} */
  #fetched = new Map()

  /* ---------------- 收藏表情 ---------------- */

  /** 面板要的全部数据。收藏拉不到不算失败，原因给前端自己提示 */
  async snapshot({botId = '', refresh = false} = {}) {
    let favorites = []
    let favoritesError = ''
    try {
      favorites = (await this.favorites({botId, refresh})).urls
    } catch (err) {
      favoritesError = err?.message ?? String(err)
    }
    return {favorites, favoritesError, custom: await this.listCustom()}
  }

  /**
   * 取 bot 收藏的表情。
   *
   * 只有 OneBot 系（NapCat 等）认 `fetch_custom_face`，ICQQ / 官bot 会直接报错，
   * 这里把错误原样往上抛，由 controller 决定怎么提示。
   */
  async favorites({botId = '', refresh = false} = {}) {
    const key = String(botId ?? '')
    const hit = this.#favCache.get(key)
    if (!refresh && hit && Date.now() - hit.at < FAV_TTL) {
      return {urls: hit.urls, at: hit.at}
    }
    let pending = this.#favPending.get(key)
    if (!pending) {
      pending = this.#loadFavorites(key).finally(() => this.#favPending.delete(key))
      this.#favPending.set(key, pending)
    }
    const urls = await pending
    this.#favCache.set(key, {at: Date.now(), urls})
    return {urls, at: Date.now()}
  }

  async #loadFavorites(botId) {
    const owner = (botId && Bot.bots?.[botId]) || (botId && Bot.bots?.[Number(botId)]) || Bot

    // OneBot 系（NapCat / Lagrange / LLOneBot 等）的扩展 action
    if (typeof owner?.sendApi === 'function') {
      try {
        /**
         * 参数只有 LLOneBot 系认：`count` 默认 10（不传就只回 10 张），`return_type`
         * 默认 url。NapCat / Lagrange 这俩参数都不看，多传不影响。
         */
        const ret = await withTimeout(
          Promise.resolve(owner.sendApi('fetch_custom_face', {count: 500, return_type: 'url'})),
          FAV_TIMEOUT,
          '读取收藏表情超时',
        )
        return this.#pickFavList(ret)
      } catch {
        // 这个实现不认 fetch_custom_face，往下试 ICQQ 那套
      }
    }

    // ICQQ 内核：漫游表情就是收藏表情，返回的同样是 p.qpic.cn 地址
    if (typeof owner?.getRoamingStamp === 'function') {
      const list = await withTimeout(
        Promise.resolve(owner.getRoamingStamp(false)),
        FAV_TIMEOUT,
        '读取收藏表情超时',
      )
      return (Array.isArray(list) ? list : []).map(String).filter(isFavUrl)
    }

    throw new GuobaError('当前适配器不支持读取收藏表情')
  }

  /**
   * 收藏表情的返回格式各家不太一样：NapCat / Lagrange 是 `data: [url]`，
   * 有的实现直接回数组，也有包一层 `{urls: [...]}` 的，几种都收。
   */
  #pickFavList(ret) {
    const raw = Array.isArray(ret)
      ? ret
      : Array.isArray(ret?.data)
        ? ret.data
        : Array.isArray(ret?.data?.urls)
          ? ret.data.urls
          : Array.isArray(ret?.urls)
            ? ret.urls
            : []
    return raw.map(String).filter(isFavUrl)
  }

  /** 收藏 / 自定义表情在发送前统一换成字节 */
  async resolveForSend(item) {
    if (!item || typeof item !== 'object') return null
    if (item.kind === 'custom') {
      return (await this.readCustom(item.id)).buffer
    }
    if (item.kind === 'fav') {
      const url = String(item.url ?? '')
      if (!isFavUrl(url)) throw new GuobaError('表情地址不可用')
      const cached = this.#fetched.get(url)
      if (cached && Date.now() - cached.at < FAV_TTL) return cached.buffer
      const res = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT)})
      if (!res.ok) throw new GuobaError(`表情下载失败：HTTP ${res.status}`)
      const len = Number(res.headers.get('content-length'))
      if (len && len > MAX_FILE) throw new GuobaError(FILE_TOO_LARGE)
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length > MAX_FILE) throw new GuobaError(FILE_TOO_LARGE)
      // 缓存别无限长，收藏表情一两百张、每张百来 KB，留 100 条够用
      if (this.#fetched.size >= 100) this.#fetched.delete(this.#fetched.keys().next().value)
      this.#fetched.set(url, {at: Date.now(), buffer})
      return buffer
    }
    return null
  }

  /* ---------------- 自定义表情 ---------------- */

  async listCustom() {
    await fs.mkdir(CUSTOM_DIR, {recursive: true})
    const names = await fs.readdir(CUSTOM_DIR)
    const items = []
    for (const name of names) {
      const m = ID_RE.exec(name)
      if (!m) continue
      const st = await fs.stat(path.join(CUSTOM_DIR, name)).catch(() => null)
      if (!st?.isFile()) continue
      items.push({
        id: name,
        ext: m[1],
        size: st.size,
        at: Math.round(st.mtimeMs),
      })
    }
    return items.sort((a, b) => b.at - a.at)
  }

  async readCustom(id) {
    const name = String(id ?? '')
    if (!ID_RE.test(name)) throw new GuobaError('表情不存在')
    const file = path.join(CUSTOM_DIR, name)
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile()) throw new GuobaError('表情不存在')
    return {
      buffer: await fs.readFile(file),
      mime: EXT_MIME[name.split('.').pop()] || 'application/octet-stream',
    }
  }

  /**
   * 保存上传的表情。
   *
   * 用内容哈希做文件名：同一张图反复上传只落一份，也顺手挡掉了「文件名里带路径」
   * 这类脏输入。multer 已经把文件落在 data/upload_tmp，读完就删。
   */
  async saveCustom(files) {
    const list = (Array.isArray(files) ? files : []).slice(0, 20)
    if (!list.length) throw new GuobaError('没有收到表情文件')
    const buffers = []
    for (const file of list) {
      const buffer = await this.#readUpload(file)
      if (buffer?.length) buffers.push(buffer)
    }
    return this.#saveBuffers(buffers)
  }

  /**
   * 把消息里的图收进自定义。
   *
   * 右键「收藏表情」走这里：QQ 自带的小黄脸从静态资源里取图，图片（表情包或普通图）
   * 优先用回显时留的字节，没有就按直链下载 —— 主人明确要求普通图片也能收成表情。
   * 单张超限或下载失败时跳过；全都失败才提示，具体原因写日志。
   *
   * 优先用页面传上来的段：面板的内存缓冲只有 1000 条、重启还会清空，光靠 messageId
   * 去缓冲里找，翻几页历史消息就收藏不动了（主人实测踩过）。
   */
  async importFromMessage({messageId, segments} = {}) {
    const fromPage = this.#pickEmojiSegs(segments)
    const list = fromPage.length
      ? fromPage
      : this.#pickEmojiSegs(this.chatService.getBuffered(messageId)?.segments)
    if (!list.length) throw new GuobaError('这条消息里没有可收藏的图')
    const buffers = []
    let failureMessage = '收藏失败，请稍后再试'
    for (const seg of list) {
      try {
        const buffer = seg.type === 'face'
          ? await this.#readFaceImage(seg.id)
          : await this.#readSegImage(seg)
        if (!buffer?.length) throw new Error('没有取到图片数据')
        if (buffer.length > MAX_FILE) throw new GuobaError(FILE_TOO_LARGE)
        if (!sniffMime(buffer)) throw new GuobaError(BAD_IMAGE)
        buffers.push(buffer)
      } catch (err) {
        // 只把需要用户换图的提示带到面板，网络和资源错误留在日志，别一律误报过期
        if (err instanceof GuobaError && (err.message === FILE_TOO_LARGE || err.message === BAD_IMAGE)) {
          failureMessage = err.message
        }
        logger.warn(`[Guoba] 收藏消息表情失败（消息 ${messageId ?? ''}，类型 ${seg.type}）：${err?.stack ?? err}`)
      }
    }
    if (!buffers.length) throw new GuobaError(failureMessage)
    return this.#saveBuffers(buffers)
  }

  #pickEmojiSegs(segments) {
    return (Array.isArray(segments) ? segments : []).filter(
      (s) => s && (s.type === 'face' || s.type === 'image'),
    )
  }

  async #readFaceImage(id) {
    const fid = String(id ?? '')
    if (!/^\d+$/.test(fid)) return null
    for (const dir of FACE_DIRS) {
      const buffer = await fs.readFile(path.join(dir, `${fid}.png`)).catch(() => null)
      if (buffer?.length) return buffer
    }
    return null
  }

  async #readSegImage(seg) {
    if (seg.assetId) {
      try {
        const asset = this.chatService.getAsset(String(seg.assetId))
        if (asset?.buffer?.length) return asset.buffer
      } catch {
        // 重启后 AssetStore 已经清空，退回直链
      }
    }
    if (seg.url) return this.#download(seg.url)
    return null
  }

  /** 下载一张表情图。地址来自前端，先解析再判断，内网的一律不碰（同聊天图片代理的口径） */
  async #download(url) {
    let target
    let addr
    try {
      target = new URL(String(url ?? ''))
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new GuobaError('只支持 http(s) 图片')
      }
      addr = net.isIP(target.hostname)
        ? target.hostname
        : (await dnsLookup(target.hostname)).address
    } catch (err) {
      if (err instanceof GuobaError) throw err
      throw new GuobaError(`表情地址不可用：${err?.message ?? err}`)
    }
    if (isPrivateIp(addr)) throw new GuobaError('不下载内网地址')
    let res
    try {
      res = await fetch(target, {signal: AbortSignal.timeout(FETCH_TIMEOUT)})
    } catch (err) {
      throw new GuobaError(`表情下载失败：${err?.message ?? err}`)
    }
    if (!res.ok) throw new GuobaError(`表情下载失败：HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length'))
    if (len && len > MAX_FILE) throw new GuobaError(FILE_TOO_LARGE)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > MAX_FILE) throw new GuobaError(FILE_TOO_LARGE)
    return buffer
  }

  async #saveBuffers(buffers) {
    await fs.mkdir(CUSTOM_DIR, {recursive: true})
    const existing = (await fs.readdir(CUSTOM_DIR)).filter((n) => ID_RE.test(n))
    const added = []
    for (const buffer of buffers) {
      if (!buffer?.length) continue
      if (buffer.length > MAX_FILE) throw new GuobaError(FILE_TOO_LARGE)
      const mime = sniffMime(buffer)
      const ext = MIME_EXT[mime]
      if (!ext) continue
      const id = `${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}.${ext}`
      const dest = path.join(CUSTOM_DIR, id)
      const exists = await fs.stat(dest).then((s) => s.isFile()).catch(() => false)
      if (!exists) {
        if (existing.length + added.length >= CUSTOM_LIMIT) {
          throw new GuobaError(`自定义表情最多 ${CUSTOM_LIMIT} 张`)
        }
        await fs.writeFile(dest, buffer)
        added.push(id)
      }
    }
    return {added, custom: await this.listCustom()}
  }

  async removeCustom(id) {
    const name = String(id ?? '')
    if (!ID_RE.test(name)) throw new GuobaError('表情不存在')
    await fs.unlink(path.join(CUSTOM_DIR, name)).catch(() => {})
    return {removed: name, custom: await this.listCustom()}
  }

  async #readUpload(file) {
    if (Buffer.isBuffer(file?.buffer)) return file.buffer
    const src = file?.path
    if (!src) return null
    try {
      return await fs.readFile(src)
    } finally {
      fs.unlink(src).catch(() => {})
    }
  }
}
