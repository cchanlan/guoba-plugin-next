import net from 'node:net'
import {lookup as dnsLookup} from 'node:dns/promises'
import {GuobaError, Service} from '#guoba.framework'
import {AssetStore, flattenOneBot, normalizeMsg, toBase64File} from './model/msgSegment.js'
import {listBots} from './model/bots.js'

/**
 * 实时缓冲最多留多少条。
 *
 * 全局一份、按会话过滤，比每个会话各留一份省内存，游标语义也跟 LogService 一致。
 */
const MAX_MESSAGES = 1000
/** 活跃会话表上限，超了淘汰最久没动静的 */
const MAX_SESSIONS = 300
/** 拉历史的默认条数与上限 */
const HISTORY_COUNT = 20
const MAX_HISTORY_COUNT = 50
/** 一次 tail 最多回多少条，页面挂后台很久再回来时别一口气全塞回去 */
const MAX_TAIL = 200
/** 发送时最多带几张图 */
const MAX_SEND_IMAGES = 5
/** Raw JSON 的长度上限 */
const MAX_RAW_LEN = 20000
/** 代理白名单最多记多少条 url */
const MAX_PROXY_URLS = 3000
/** 代理单个文件的大小上限 */
const MAX_PROXY_SIZE = 20 * 1024 * 1024
const PROXY_TIMEOUT = 15000
/** 会话列表单页上限 */
const MAX_PAGE_SIZE = 100
/** 会话列表里最后一条消息的摘要长度 */
const PREVIEW_LEN = 40

/**
 * 已挂上的 message 监听存在 process 上。
 *
 * 热重载时本模块会被重新 import，模块级变量与实例都是新的，但上一代挂在 Bot 上的监听
 * 还在，不摘掉就会一条消息进两次缓冲。同 LogService 的 ORIGIN_KEY。
 */
const LISTENER_KEY = Symbol.for('guoba.chatService.listener')

/** 非文本段在会话列表摘要里的占位 */
const PREVIEW_TEXT = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  face: '[表情]',
  node: '[合并转发]',
  forward: '[合并转发]',
  markdown: '[Markdown]',
  button: '',
  reply: '',
}

/**
 * 是不是私有 / 环回 / 链路本地地址。
 *
 * 图片代理只在浏览器直连失败时兜底，而能直连的都是公网地址，所以拦掉内网对正常使用
 * 没有影响 —— 但能挡住拿这个接口探测 Bot 所在内网。解析不出来的一并当作不安全。
 */
function isPrivateIp(ip) {
  const ver = net.isIP(ip)
  if (ver === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    // 169.254 是链路本地，云上的元数据服务（169.254.169.254）也在里面
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (ver === 6) {
    const s = ip.toLowerCase()
    if (s === '::' || s === '::1') return true
    // fe80:: 链路本地、fc00::/7 唯一本地
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true
    // ::ffff:127.0.0.1 这类 v4 映射地址，取出 v4 再判一次
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m) return isPrivateIp(m[1])
    return false
  }
  return true
}

/**
 * 消息记录。
 *
 * 与沙盒相反 —— 这里是**真收真发**：消息流取自适配器与 QQ 服务端，发出去的会真的
 * 出现在群里。做两件事：
 *
 * 1. **实时追新**：挂一个 `Bot.on('message')`，把收到的消息规范化后进环形缓冲，
 *    前端拿游标轮询增量（同 LogService 的范式，不用长连接）。
 * 2. **拉历史**：OneBot v11 的 pick 结果上有 `getChatHistory`，取的是 QQ 服务端记录，
 *    含 bot 自己发的，比自建存储可靠。适配器没这方法就只能看面板运行期间的消息。
 *
 * 缓冲只在内存里，重启即丢；要长期留存请用 QQ 客户端。
 */
export default class ChatService extends Service {

  /** 全局环形缓冲，按 key 过滤出单个会话 */
  #messages = []
  /** messageId -> 消息，去重用（NapCat 开了自身消息上报时，回显和事件会撞一次） */
  #index = new Map()
  /** 下一条的序号，只增不减 */
  #seq = 1
  /**
   * 活跃会话：key -> {lastTime, lastText, unread}。
   * 只记有过消息的，会话列表本身来自 Bot 的好友 / 群列表。
   */
  #sessions = new Map()
  /** 活跃表的版本号，前端据此决定要不要重画左侧列表 */
  #rev = 1
  /**
   * 自己发出去的图片留一份字节，段里只给 id。
   * 真实消息段自带 QQ 直链不用存，只有面板自己发的图是 base64，得留着才能回显。
   */
  #assets = new AssetStore()
  /**
   * 允许代理的图片直链白名单。
   *
   * QQ 直链带 rkey，过期后浏览器直连会失败，得由服务端代拉一次。但代理接口不能成为
   * 任意 URL 的出网口子，所以只放行「确实在消息里出现过」的那些。
   */
  #proxyUrls = new Set()
  #handler = null
  #attached = false

  constructor(guobaApp) {
    super(guobaApp)
    this.attach()
  }

  /* ---------------- 实时追新 ---------------- */

  /**
   * 挂上消息监听。
   *
   * `Bot.em()` 是逐级 emit 的（`message.group.normal` → `message.group` → `message`），
   * 挂最外层的 `message` 一次就能收全所有会话。
   */
  attach() {
    if (this.#attached) return
    if (typeof Bot?.on !== 'function') {
      // 极早期 Bot 还没建好，等一会儿再挂
      setTimeout(() => this.attach(), 3000)
      return
    }
    this.#attached = true
    const saved = process[LISTENER_KEY]
    if (typeof saved === 'function') Bot.off('message', saved)
    /**
     * 处理串成一条链。`#onMessage` 里的 normalizeMsg 有 await，两条消息紧挨着进来时
     * 段少的那条会先跑完、先拿到 seq，缓冲顺序就跟实际到达顺序反了。
     */
    let queue = Promise.resolve()
    const handler = (e) => {
      // 这个回调挂在全局消息流上，出任何异常都不能影响 Bot 自己处理消息
      queue = queue
        .then(() => this.#onMessage(e))
        .catch((err) => {
          logger.debug(`[Guoba][消息记录] 处理消息出错：${err?.stack ?? err}`)
        })
    }
    Bot.on('message', handler)
    this.#handler = handler
    process[LISTENER_KEY] = handler
  }

  /** 摘掉监听，卸载插件时用 */
  detach() {
    if (!this.#attached) return
    this.#attached = false
    if (this.#handler) Bot.off?.('message', this.#handler)
    this.#handler = null
    delete process[LISTENER_KEY]
  }

  async #onMessage(e) {
    if (e?.post_type !== 'message' || !e.message) return
    const botId = String(e.self_id ?? '')
    const self = String(e.user_id ?? '') === botId
    const type = e.message_type === 'group' ? 'group' : 'friend'
    /**
     * 私聊里「自己发的」那条，user_id 是自己，对方在 target_id 上（OneBot 的
     * message_sent 事件），拿它才能归到正确的会话去。
     */
    const id = type === 'group'
      ? String(e.group_id ?? '')
      : String((self ? (e.target_id ?? e.peer_id) : null) ?? e.user_id ?? '')
    if (!botId || !id) return

    const segments = await normalizeMsg(e.message, {download: false})
    this.#push({
      key: `${botId}:${type}:${id}`,
      botId,
      type,
      id,
      messageId: e.message_id != null ? String(e.message_id) : '',
      messageSeq: this.#seqOf(e),
      time: Number(e.time) || Math.floor(Date.now() / 1000),
      self,
      sender: this.#sender(e.sender, e.user_id),
      segments,
    }, {unread: !self})
  }

  /** 翻页游标。NapCat 给 message_seq，缺了就退回 message_id（部分实现里两者同值） */
  #seqOf(item) {
    const seq = item?.message_seq ?? item?.real_seq ?? item?.message_id
    return seq != null && seq !== '' ? String(seq) : ''
  }

  #sender(sender, userId) {
    return {
      userId: String(sender?.user_id ?? userId ?? ''),
      nickname: String(sender?.nickname ?? ''),
      card: String(sender?.card ?? ''),
      role: String(sender?.role ?? ''),
    }
  }

  /**
   * 入缓冲。已经有同一条 messageId 的就不再进 —— NapCat 若开了自身消息上报，
   * 面板自己发的那条会先被本地塞进来一次、再从事件里来一次。
   *
   * @param remember 段里的 http 直链要不要进代理白名单。只有适配器给的才算，
   *                 面板自己发出去的不算（Raw 档能自填 url，那等于放开任意地址代理）
   */
  #push(msg, {unread = false, remember = true} = {}) {
    if (!msg.key) return null
    if (msg.messageId && this.#index.has(msg.messageId)) return this.#index.get(msg.messageId)
    msg.seq = this.#seq++
    this.#messages.push(msg)
    if (msg.messageId) this.#index.set(msg.messageId, msg)
    if (remember) this.#remember(msg.segments)
    if (this.#messages.length > MAX_MESSAGES * 1.2) {
      // 攒够一批再裁，省得每条都挪一次数组
      const cut = this.#messages.splice(0, this.#messages.length - MAX_MESSAGES)
      for (const item of cut) if (item.messageId) this.#index.delete(item.messageId)
    }
    this.#touch(msg, unread)
    return msg
  }

  /** 更新活跃表 */
  #touch(msg, unread) {
    const old = this.#sessions.get(msg.key)
    const session = {
      lastTime: msg.time,
      lastText: this.#preview(msg),
      unread: (old?.unread ?? 0) + (unread ? 1 : 0),
    }
    this.#sessions.set(msg.key, session)
    if (this.#sessions.size > MAX_SESSIONS) {
      let oldestKey = null
      let oldest = Infinity
      for (const [key, item] of this.#sessions) {
        if (item.lastTime < oldest) {
          oldest = item.lastTime
          oldestKey = key
        }
      }
      if (oldestKey) this.#sessions.delete(oldestKey)
    }
    this.#rev++
  }

  /** 会话列表里那一行摘要 */
  #preview(msg) {
    let text = ''
    for (const seg of msg.segments ?? []) {
      if (seg.type === 'text') text += seg.text ?? ''
      else if (seg.type === 'at') text += `@${seg.name || seg.qq}`
      else text += PREVIEW_TEXT[seg.type] ?? `[${seg.type}]`
      if (text.length > PREVIEW_LEN) break
    }
    text = text.replace(/\s+/g, ' ').trim()
    const name = msg.self ? '我' : (msg.sender?.card || msg.sender?.nickname || '')
    const body = text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text
    return name ? `${name}：${body}` : body
  }

  /** 把段里的 http 直链记进代理白名单，跟缓冲一起淘汰 */
  #remember(segments) {
    for (const seg of segments ?? []) {
      if (typeof seg?.url === 'string' && seg.url.startsWith('http')) {
        // Set 保持插入序，超量时从最早的开始丢
        if (this.#proxyUrls.size >= MAX_PROXY_URLS) {
          const first = this.#proxyUrls.values().next().value
          if (first !== undefined) this.#proxyUrls.delete(first)
        }
        this.#proxyUrls.add(seg.url)
      }
      if (Array.isArray(seg?.nodes)) {
        for (const node of seg.nodes) this.#remember(node.segments)
      }
    }
  }

  /* ---------------- 读 ---------------- */

  /**
   * 取实时增量。
   *
   * @param key    只要这个会话的消息，空则不返回消息（只用来拿基线游标）
   * @param cursor 上次取到的 seq
   * @param rev    上次拿到的活跃表版本，没变就不重复回传左侧列表的摘要
   */
  tail({key = '', cursor, rev} = {}) {
    /**
     * `cursor` 没传（刚进页面，只要一个基线，不要历史）与 `cursor=0`（把缓冲里现有的
     * 都给我，降级模式下的兜底）是两回事，而空串经 Number 会变成 0，先把空值挡掉。
     * 判 `>= 0` 而不是 `> 0`：第一条消息的 seq 就是 1，判后者会把它永远漏掉。
     */
    const from = cursor === '' || cursor == null ? NaN : Number(cursor)
    const oldest = this.#messages.length ? this.#messages[0].seq : this.#seq
    const has = Number.isFinite(from) && from >= 0
    // 游标比缓冲里最老的还老，说明中间几条已经被挤掉了，前端提示一下并重新拉历史
    const missed = has && from + 1 < oldest

    let messages = []
    if (has && key) {
      messages = this.#messages.filter((it) => it.seq > from && it.key === key)
      if (messages.length > MAX_TAIL) messages = messages.slice(messages.length - MAX_TAIL)
    }

    const myRev = this.#rev
    return {
      messages,
      // 游标跟着全量走，不受会话过滤影响，否则别的会话的消息下次还会被算成新的
      cursor: this.#seq - 1,
      rev: myRev,
      sessions: Number(rev) === myRev ? null : this.#activeMap(),
      missed,
      /** 当前会话的未读，前端进来时清掉 */
      unread: key ? (this.#sessions.get(key)?.unread ?? 0) : 0,
    }
  }

  /** 活跃摘要，key -> {lastTime, lastText, unread} */
  #activeMap() {
    const out = {}
    for (const [key, item] of this.#sessions) out[key] = {...item}
    return out
  }

  /**
   * 会话列表。
   *
   * 名单来自 Bot 的好友 / 群列表（每项带 bot_id，多账号下才知道该用哪个号发），
   * 叠上活跃表里的最后一条摘要与未读数，有动静的排前面。
   *
   * @param type 'group' | 'friend'
   */
  listSessions({type = 'group', botId = '', keyword = '', pageNo = 1, pageSize = 30} = {}) {
    const isGroup = type !== 'friend'
    const map = (isGroup ? Bot.getGroupMap?.() : Bot.getFriendMap?.()) ?? new Map()
    const kw = String(keyword ?? '').trim().toLowerCase()
    const wantBot = String(botId ?? '').trim()

    const list = []
    for (const [id, info] of map) {
      const owner = String(info?.bot_id ?? '')
      if (wantBot && owner !== wantBot) continue
      const sid = String(id)
      const name = String(
        (isGroup ? info?.group_name : (info?.nickname ?? info?.remark)) ?? '',
      )
      if (kw && !name.toLowerCase().includes(kw) && !sid.includes(kw)) continue
      const key = `${owner}:${isGroup ? 'group' : 'friend'}:${sid}`
      const active = this.#sessions.get(key)
      list.push({
        key,
        botId: owner,
        type: isGroup ? 'group' : 'friend',
        id: sid,
        name,
        lastTime: active?.lastTime ?? 0,
        lastText: active?.lastText ?? '',
        unread: active?.unread ?? 0,
      })
    }

    // 有消息的按最近活跃排前面，其余按号码，顺序稳定不跳动
    list.sort((a, b) => (b.lastTime - a.lastTime) || a.id.localeCompare(b.id))

    const size = Math.min(Math.max(Number(pageSize) || 30, 1), MAX_PAGE_SIZE)
    const page = Math.max(Number(pageNo) || 1, 1)
    const start = (page - 1) * size
    return {
      list: list.slice(start, start + size),
      total: list.length,
      pageNo: page,
      pageSize: size,
      rev: this.#rev,
      sessions: this.#activeMap(),
    }
  }

  /**
   * 拉历史消息。
   *
   * @param seq   翻页游标，传本地最早一条的 messageSeq；0 或空取最新
   * @param count 条数
   */
  async getHistory({botId, type, id, seq = 0, count = HISTORY_COUNT} = {}) {
    const target = this.#pick(type, id, botId)
    const cursor = this.#seq - 1
    if (typeof target?.getChatHistory !== 'function') {
      // 非 OneBot 适配器多半没有这能力，前端据此提示「只能看面板运行期间的消息」
      return {supported: false, messages: [], hasMore: false, cursor}
    }

    const num = Math.min(Math.max(Number(count) || HISTORY_COUNT, 1), MAX_HISTORY_COUNT)
    // message_seq 是数字或字符串，视实现而定，能转数字就转
    const from = seq === 0 || seq === '' || seq == null ? 0 : (Number(seq) || seq)
    let raw
    try {
      raw = await target.getChatHistory(from, num)
    } catch (err) {
      throw new GuobaError(`拉取历史消息失败：${err?.message ?? err}`)
    }

    const list = (Array.isArray(raw) ? raw : [raw]).filter((it) => it && typeof it === 'object')
    const key = `${botId}:${type === 'group' ? 'group' : 'friend'}:${id}`
    const messages = []
    for (const item of list) {
      const userId = String(item.user_id ?? item.sender?.user_id ?? '')
      messages.push({
        key,
        botId: String(botId ?? ''),
        type: type === 'group' ? 'group' : 'friend',
        id: String(id ?? ''),
        messageId: item.message_id != null ? String(item.message_id) : '',
        messageSeq: this.#seqOf(item),
        time: Number(item.time) || 0,
        self: userId === String(botId ?? ''),
        sender: this.#sender(item.sender, userId),
        segments: await normalizeMsg(item.message ?? item.content, {download: false}),
      })
    }
    // 各实现返回的顺序不一致，自己排一遍（旧 → 新）
    messages.sort((a, b) => (a.time - b.time) || String(a.messageSeq).localeCompare(String(b.messageSeq)))
    for (const msg of messages) this.#remember(msg.segments)

    return {
      supported: true,
      messages,
      /** 拿满了就认为还有更早的，前端继续往上翻 */
      hasMore: messages.length >= num,
      // 顺带把基线游标给前端，省一次请求；从这里开始轮询增量
      cursor,
    }
  }

  /** 看合并转发的内容。段里只有一个 id，内容在 QQ 服务端 */
  async getForward({botId, type, id, messageId} = {}) {
    const mid = String(messageId ?? '').trim()
    if (!mid) throw new GuobaError('缺少消息 id')
    const target = this.#pick(type, id, botId)
    if (typeof target?.getForwardMsg !== 'function') {
      throw new GuobaError('当前适配器不支持查看合并转发')
    }
    let raw
    try {
      raw = await target.getForwardMsg(mid)
    } catch (err) {
      throw new GuobaError(`拉取合并转发失败：${err?.message ?? err}`)
    }

    const list = (Array.isArray(raw) ? raw : [raw]).filter((it) => it && typeof it === 'object')
    const nodes = []
    for (const item of list) {
      /**
       * 适配器只对 `message` 字段做了 parseMsg，放在 `content` 下的那些还是 OneBot
       * 原生结构，得自己拍平一次。
       */
      const content = item.message ?? flattenOneBot(item.content ?? [])
      nodes.push({
        nickname: String(item.sender?.nickname ?? item.nickname ?? ''),
        userId: String(item.sender?.user_id ?? item.user_id ?? ''),
        time: Number(item.time) || null,
        segments: await normalizeMsg(content, {download: false}),
      })
    }
    for (const node of nodes) this.#remember(node.segments)
    return {nodes}
  }

  /** 取一份自己发出去的图片，供 /chat/asset/:id 回传 */
  getAsset(assetId) {
    const asset = this.#assets.get(assetId)
    if (!asset) throw new GuobaError('资源不存在或已过期')
    return asset
  }

  /**
   * 代理一张图。
   *
   * QQ 直链的 rkey 有时效，过期后浏览器直连会 403，交给服务端重拉一次往往还能拿到。
   * 只放行缓冲里出现过的 url —— 这个接口不能变成任意地址的出网通道。
   */
  async proxy(url) {
    const target = String(url ?? '')
    if (!this.#proxyUrls.has(target)) {
      throw new GuobaError('该链接不在当前消息记录里')
    }
    let addr
    try {
      const u = new URL(target)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new GuobaError('只代理 http(s) 链接')
      }
      /**
       * 白名单说明「这链接在消息里出现过」，不说明它安全 —— 本地部署的协议端会把图片
       * 挂在内网地址上，这类 url 一样会进白名单。真去拉之前解析一次，内网的不碰。
       */
      addr = net.isIP(u.hostname) ? u.hostname : (await dnsLookup(u.hostname)).address
    } catch (err) {
      if (err instanceof GuobaError) throw err
      throw new GuobaError(`链接不可用：${err?.message ?? err}`)
    }
    if (isPrivateIp(addr)) throw new GuobaError('不代理内网地址')

    let res
    try {
      res = await fetch(target, {signal: AbortSignal.timeout(PROXY_TIMEOUT)})
    } catch (err) {
      throw new GuobaError(`拉取失败：${err?.message ?? err}`)
    }
    if (!res.ok) throw new GuobaError(`拉取失败：HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length'))
    if (len && len > MAX_PROXY_SIZE) throw new GuobaError('文件过大，未代理')
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > MAX_PROXY_SIZE) throw new GuobaError('文件过大，未代理')
    return {buffer, mime: res.headers.get('content-type') || 'application/octet-stream'}
  }

  /* ---------------- 写 ---------------- */

  /**
   * 发一条消息。**会真的发到 QQ 上。**
   *
   * @param text    文本
   * @param images  图片，元素为 dataURL 或 base64
   * @param replyTo 引用哪条消息的 message_id
   */
  async send({botId, type, id, text = '', images = [], replyTo = ''} = {}) {
    const msg = []
    if (replyTo) msg.push({type: 'reply', id: String(replyTo)})
    const list = Array.isArray(images) ? images.slice(0, MAX_SEND_IMAGES) : []
    for (const img of list) {
      const file = toBase64File(img)
      if (file) msg.push({type: 'image', file})
    }
    const str = typeof text === 'string' ? text : ''
    if (str) msg.push({type: 'text', text: str})
    // 只有引用段等于没内容，QQ 那边会发失败
    if (!msg.some((i) => i.type !== 'reply')) {
      throw new GuobaError('消息内容不能为空')
    }
    return this.#sendMsg({botId, type, id, msg})
  }

  /**
   * 发原始消息段数组。
   *
   * 相当于在插件里直接 `sendMsg([{...}])`，用来试适配器认不认某种段
   * （`{"type":"raw","data":{…}}` 会被 OneBot 适配器原样交给协议端）。
   */
  async sendRaw({botId, type, id, raw} = {}) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) throw new GuobaError('内容不能为空')
    if (text.length > MAX_RAW_LEN) {
      throw new GuobaError(`内容过长（上限 ${MAX_RAW_LEN} 字符）`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new GuobaError(`JSON 解析失败：${err?.message ?? err}`)
    }
    // 单个段也收，包一层就是了
    const list = Array.isArray(parsed) ? parsed : [parsed]
    if (!list.length) throw new GuobaError('段数组不能为空')
    list.forEach((item, i) => {
      if (typeof item === 'string' || typeof item === 'number') return
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new GuobaError(`第 ${i + 1} 项必须是对象或字符串`)
      }
      if (!item.type || typeof item.type !== 'string') {
        throw new GuobaError(`第 ${i + 1} 项缺少 type 字段`)
      }
    })
    return this.#sendMsg({botId, type, id, msg: list})
  }

  /** 真正发出去，并把自己这条塞进缓冲好让页面上看到 */
  async #sendMsg({botId, type, id, msg}) {
    const target = this.#pick(type, id, botId)
    if (typeof target?.sendMsg !== 'function') {
      throw new GuobaError(`未找到可用的发送对象：${id}`)
    }
    let res
    try {
      res = await target.sendMsg(msg)
    } catch (err) {
      throw new GuobaError(`发送失败：${err?.message ?? err}`)
    }

    const messageId = res?.message_id != null ? String(res.message_id) : ''
    const self = String(botId ?? '')
    const bot = Bot.bots?.[self]
    /**
     * bot 自己发的消息不一定会有 message 事件（要协议端开了自身消息上报才有），
     * 所以在这儿主动补一条；真来了事件也会按 messageId 去重，不会重复。
     * 这条要读盘 —— 刚发的图是 base64，不留一份字节页面上就显示不出来。
     */
    const pushed = this.#push({
      key: `${self}:${type === 'group' ? 'group' : 'friend'}:${id}`,
      botId: self,
      type: type === 'group' ? 'group' : 'friend',
      id: String(id ?? ''),
      messageId,
      messageSeq: this.#seqOf(res),
      time: Number(res?.time) || Math.floor(Date.now() / 1000),
      self: true,
      sender: {
        userId: self,
        nickname: String(bot?.nickname ?? ''),
        card: '',
        role: '',
      },
      segments: await normalizeMsg(msg, {assets: this.#assets}),
    }, {remember: false})

    return {messageId, message: pushed, cursor: this.#seq - 1}
  }

  /**
   * 撤回。只能撤 bot 自己发的，且有时限（群管理员可撤别人的）。
   *
   * OneBotv11 的 recallMsg 把每条的结果收进数组，失败时塞的是错误对象而不是抛出来
   * （`.catch(i => i)`），所以得自己翻一遍看有没有出错。
   */
  async recall({botId, type, id, messageId} = {}) {
    const mid = String(messageId ?? '').trim()
    if (!mid) throw new GuobaError('缺少消息 id')
    const target = this.#pick(type, id, botId)
    if (typeof target?.recallMsg !== 'function') {
      throw new GuobaError('当前适配器不支持撤回')
    }
    let res
    try {
      res = await target.recallMsg(mid)
    } catch (err) {
      throw new GuobaError(`撤回失败：${err?.message ?? err}`)
    }
    for (const item of Array.isArray(res) ? res : [res]) {
      // Error 实例、或带 retcode 的失败响应
      const err = item instanceof Error ? item.message : null
      const bad = err ?? (item?.retcode && item.retcode !== 0 ? (item.msg || item.wording) : null)
      if (bad) throw new GuobaError(`撤回失败：${bad}`)
    }
    const msg = this.#index.get(mid)
    if (msg) {
      msg.recalled = true
      // 撤回也算一次变化，让左侧列表跟着刷
      this.#rev++
    }
    return {messageId: mid}
  }

  /** 清掉某个会话的未读 */
  markRead(key) {
    const session = this.#sessions.get(String(key ?? ''))
    if (session?.unread) {
      session.unread = 0
      this.#rev++
    }
    return {key: String(key ?? ''), rev: this.#rev}
  }

  /** 页面上显示的状态，顺带把账号列表给前端选号 */
  status() {
    return {
      bots: listBots(),
      messages: this.#messages.length,
      max: MAX_MESSAGES,
      cursor: this.#seq - 1,
      rev: this.#rev,
      attached: this.#attached,
      maxImages: MAX_SEND_IMAGES,
    }
  }

  /**
   * 按 bot_id 取到操作对象。
   *
   * 同 OicqService：多账号下不指定 bot_id 的话，`Bot.pickGroup` 找不到时会「随机选择Bot」，
   * 消息就发到别的号上去了。
   */
  #pick(type, id, botId) {
    const target = Number(id) || id
    if (!target) throw new GuobaError('缺少会话 id')
    const owner = (botId && Bot.bots?.[Number(botId) || botId]) || Bot
    return type === 'group' ? owner.pickGroup(target) : owner.pickUser(target)
  }
}
