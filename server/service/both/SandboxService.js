import {GuobaError, Service} from '#guoba.framework'
import PluginsLoader from '../../../../../lib/plugins/loader.js'
import cfg from '../../../../../lib/config/config.js'

/** 沙盒会话里假装的适配器标识，日志里能一眼认出是面板发的 */
const ADAPTER_ID = 'guoba-sandbox'
const ADAPTER_NAME = '锅巴沙盒'

/**
 * 模拟的目标平台。
 *
 * 插件在 TRSS 上一般是无条件带上 button / markdown 段的，能不能真显示出来取决于目标平台：
 * OneBot 那边这些段会被适配器直接丢掉，只有 QQ 官方 Bot 才渲染。另有不少插件读
 * `e.bot.adapter.name` 决定发什么（各插件的 QQBot 分支），所以切平台时连适配器身份一起换，
 * 两种效果才都预览得准。rich 为 false 的平台，按钮与 markdown 段会标上 ignored。
 */
const PLATFORMS = {
  default: {id: ADAPTER_ID, name: ADAPTER_NAME, rich: false},
  qqbot: {id: 'QQBot', name: 'QQBot', rich: true},
}

/**
 * deal() 返回后再等这么久收尾。
 *
 * 插件里 `e.reply()` 前面挂了 await 的情况 deal() 自己会等，但也有不少插件把回复丢进
 * 后台（setTimeout、未 await 的 Promise），deal() 返回时它们还没发出来。留个小窗口能捞到
 * 大部分这类回复，又不至于让页面一直转圈。
 */
const TRAIL_MS = 300
/** 单次执行的总时长上限，插件卡住时别把请求也拖死 */
const RUN_TIMEOUT = 60_000

/** 资源表（回复里的图片、语音、文件）最多留多少项 */
const MAX_ASSETS = 60
/** 单个资源的大小上限，超了不留，只报个尺寸 */
const MAX_ASSET_SIZE = 20 * 1024 * 1024
/** 资源存活时长，页面早就关了就没必要留着占内存 */
const ASSET_TTL = 30 * 60 * 1000

/** 入站消息最多允许几张图 */
const MAX_INBOUND_IMAGES = 5
/** 转发消息最多展开几层，防御自引用的 node */
const MAX_FORWARD_DEPTH = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 剥掉日志字符串里的 ANSI 颜色码，e.logFnc 是带色的 */
const stripAnsi = (str) => String(str ?? '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')

const isHttp = (v) => typeof v === 'string' && /^https?:\/\//.test(v)

/**
 * 沙盒。
 *
 * 在面板里伪造一条消息事件，直接喂给 Yunzai 的 `PluginsLoader.deal()`，把插件的回复截在
 * 内存里回给前端 —— 不经过任何适配器，所以不会真的发到 QQ 上。
 *
 * 隔离做在 `e` 上：`e.reply` / `e.friend` / `e.group` / `e.member` 全是本服务造的假对象，
 * 插件走 `e.reply()`、`this.reply()`、`e.group.sendMsg()` 的回复都会落进捕获队列。`e.bot`
 * 是真实 Bot 的代理，只有 pick 到沙盒自己的 id 时才换成假对象 —— 保证插件读 `Bot.fl`、
 * `getGroupList()` 这些照样拿到真数据。代价是插件若绕过 e、直接 `Bot.pickGroup(真实群)
 * .sendMsg()`，沙盒拦不住，这一点在页面上有标注。
 *
 * 注意沙盒跑的是真实插件代码，写库、调接口、扣次数这类副作用都会真实发生。
 */
export default class SandboxService extends Service {

  /** 本次执行的捕获队列，null 表示当前没有执行中的会话 */
  #capture = null
  /** 资源表：assetId -> {buffer, mime, name, time} */
  #assets = new Map()
  #assetSeq = 0
  #msgSeq = 0
  /** 同一时刻只跑一条，避免两次执行的回复串在一起 */
  #running = false
  /** 本次执行模拟的平台是否渲染按钮/markdown，靠 #running 的串行保证不串场 */
  #rich = false

  constructor(guobaApp) {
    super(guobaApp)
  }

  /* ---------------- 账号 ---------------- */

  /**
   * 可用账号列表。
   *
   * 判据与 StatusService 一致：`Bot.bots` 上挂着 logger、_events 这类非账号属性，
   * 甚至有插件往上塞自己的东西，只有带 adapter 的才是真账号。
   */
  listBots() {
    const uins = []
    const push = (v) => {
      const uin = String(v ?? '').trim()
      if (uin && !uins.includes(uin)) uins.push(uin)
    }

    if (Array.isArray(Bot?.uin)) Bot.uin.forEach(push)
    else if (Bot?.uin) push(Bot.uin)

    for (const [key, value] of Object.entries(Bot?.bots ?? {})) {
      if (value && typeof value === 'object' && value.adapter) push(key)
    }

    return uins.map((uin) => {
      const bot = Bot?.bots?.[uin]
      return {
        uin,
        nickname: typeof bot?.nickname === 'string' ? bot.nickname : '',
        adapter: typeof bot?.adapter?.name === 'string' ? bot.adapter.name : '',
      }
    })
  }

  /**
   * 账号列表 + 一份默认场景，前端首次打开时用。
   *
   * 默认把主人 QQ 里的第一个填进去 —— 面板本来就只有主人能登，这样进来就能直接测
   * master 权限的指令，不用手抄一遍 QQ 号。
   */
  getDefaults() {
    const bots = this.listBots()
    const masterQQ = (Array.isArray(cfg.masterQQ) ? cfg.masterQQ : [])
      .map(String)
      .filter((v) => v && v !== 'stdin')

    return {
      bots,
      masterQQ,
      scene: {
        selfId: bots[0]?.uin ?? '',
        isGroup: true,
        userId: masterQQ[0] ?? '80000000',
        nickname: '沙盒用户',
        groupId: '100000000',
        groupName: '沙盒测试群',
        card: '',
        isMaster: true,
        isOwner: false,
        isAdmin: false,
        atBot: true,
        platform: 'default',
      },
    }
  }

  /* ---------------- 插件规则 ---------------- */

  /**
   * 已加载的插件与它们的命令规则。
   *
   * 直接读 `PluginsLoader.priority` —— 那就是运行时真正参与匹配的那份，
   * 顺序即优先级顺序。
   */
  listRules() {
    const list = []
    for (const item of PluginsLoader.priority ?? []) {
      const plugin = item.plugin
      if (!plugin) continue
      list.push({
        /** 插件文件，形如 `example/test.js` */
        key: item.key,
        name: item.name ?? plugin.name ?? '',
        dsc: plugin.dsc ?? '',
        priority: item.priority ?? plugin.priority,
        event: plugin.event ?? 'message',
        rules: (plugin.rule ?? []).map((rule) => ({
          fnc: typeof rule.fnc === 'string' ? rule.fnc : '',
          reg: String(rule.reg ?? ''),
          event: rule.event ?? plugin.event ?? 'message',
          permission: rule.permission ?? 'all',
          log: rule.log !== false,
        })),
      })
    }
    return list
  }

  /**
   * 只做匹配预览，不执行任何插件。
   *
   * 走一遍与 deal() 相同的文本预处理（`dealText` 去全角井号、`srReg`/`zzzReg` 前缀标准化），
   * 否则页面上输入 `*帮助` 会显示匹配不到，跟实际行为不符。
   */
  matchRules(text, isGroup = false) {
    const raw = typeof text === 'string' ? text : ''
    let msg = PluginsLoader.dealText(raw)
    let game = ''
    if (PluginsLoader.srReg.test(msg)) {
      game = 'sr'
      msg = msg.replace(PluginsLoader.srReg, '#星铁')
    } else if (PluginsLoader.zzzReg.test(msg)) {
      game = 'zzz'
      msg = msg.replace(PluginsLoader.zzzReg, '#绝区零')
    }

    const eventName = isGroup ? 'message.group.normal' : 'message.private.friend'
    const matched = []
    for (const item of PluginsLoader.priority ?? []) {
      const plugin = item.plugin
      if (!plugin?.rule) continue
      for (const rule of plugin.rule) {
        const ruleEvent = rule.event ?? plugin.event ?? 'message'
        // 规则声明的事件是前缀式的（message / message.group / message.group.normal）
        if (ruleEvent && !eventName.startsWith(ruleEvent.replace(/\.\*/g, ''))) continue
        let hit = false
        try {
          hit = rule.reg instanceof RegExp ? rule.reg.test(msg) : new RegExp(rule.reg).test(msg)
        } catch {
          // 正则本身有问题，当没匹配上
        }
        if (!hit) continue
        matched.push({
          key: item.key,
          name: item.name ?? plugin.name ?? '',
          priority: item.priority ?? plugin.priority,
          fnc: typeof rule.fnc === 'string' ? rule.fnc : '',
          reg: String(rule.reg ?? ''),
          permission: rule.permission ?? 'all',
        })
        break
      }
    }
    return {msg, game, matched}
  }

  /* ---------------- 资源 ---------------- */

  /** 取一个捕获到的资源，供 /sandbox/asset/:id 回传 */
  getAsset(id) {
    const asset = this.#assets.get(String(id))
    if (!asset) {
      throw new GuobaError('资源不存在或已过期')
    }
    return asset
  }

  /** 存一份资源，返回 id。超限的只记尺寸不留内容 */
  #putAsset(buffer, mime, name) {
    this.#gcAssets()
    const id = `a${++this.#assetSeq}`
    this.#assets.set(id, {buffer, mime: mime || 'application/octet-stream', name: name || id, time: Date.now()})
    // Map 保持插入序，超量时从最老的开始丢
    while (this.#assets.size > MAX_ASSETS) {
      const oldest = this.#assets.keys().next().value
      this.#assets.delete(oldest)
    }
    return id
  }

  #gcAssets() {
    const expired = Date.now() - ASSET_TTL
    for (const [id, asset] of this.#assets) {
      if (asset.time < expired) this.#assets.delete(id)
      else break
    }
  }

  /* ---------------- 执行 ---------------- */

  /**
   * 发一条沙盒消息，返回捕获到的回复。
   *
   * @param scene  会话场景，见 #normalizeScene
   * @param text   文本内容
   * @param images 图片，元素为 dataURL 或 base64 字符串
   */
  async runMessage({scene, text = '', images = []} = {}) {
    if (this.#running) {
      throw new GuobaError('上一条还在处理中，请稍候')
    }

    const message = this.#buildInbound(text, images)
    if (!message.length) {
      throw new GuobaError('消息内容不能为空')
    }

    const sc = this.#normalizeScene(scene)
    const e = this.#buildEvent(sc, message)
    this.#rich = (PLATFORMS[sc.platform] ?? PLATFORMS.default).rich

    // 黑白名单在 deal() 里是静默 return 的，先自己判一次好给出原因
    if (!PluginsLoader.checkBlack(e)) {
      return this.#result(e, [], 0, 'blacklist')
    }

    this.#relaxLimit(e)

    this.#running = true
    this.#capture = []
    const begin = Date.now()
    let error = null
    let captured = []
    try {
      const deal = PluginsLoader.deal(e)
      // deal() 内部对插件是 await 的，但插件自己可能不 await，超时只是兜底
      await Promise.race([deal, sleep(RUN_TIMEOUT)])
      // 捞一把丢进后台的回复
      await sleep(TRAIL_MS)
    } catch (err) {
      error = err
      logger.error(`[Guoba][沙盒] 执行出错：${err?.stack ?? err}`)
    } finally {
      captured = this.#capture ?? []
      this.#capture = null
      this.#running = false
    }

    const elapsed = Date.now() - begin
    const replies = []
    for (const item of captured) {
      replies.push({
        id: `m${++this.#msgSeq}`,
        via: item.via,
        time: item.time,
        segments: await this.#normalizeMsg(item.msg),
      })
    }

    let blocked = null
    if (!replies.length && !error) {
      // deal() 里几处静默 return 的分支，挑能判定的给个说明
      if (e.only_reply_at === false) blocked = 'onlyReplyAt'
      else if (!this.#hitName(e)) blocked = 'noRule'
      else blocked = 'noReply'
    }

    return this.#result(e, replies, elapsed, blocked, error)
  }

  #result(e, replies, elapsed, blocked, error) {
    return {
      /** 经 dealText 与游戏前缀标准化后的文本，插件正则匹配的就是这个 */
      msg: e.msg ?? '',
      /** 命中的插件与方法，取自 deal() 写进 e 的 logFnc */
      hit: this.#hitName(e),
      isMaster: !!e.isMaster,
      game: e.game ?? '',
      elapsed,
      /** 没有回复时的原因：blacklist / onlyReplyAt / noRule / noReply */
      blocked: blocked ?? null,
      error: error ? String(error?.message ?? error) : null,
      replies,
    }
  }

  /** deal() 把命中的插件写成 `[插件名(方法名)]` 塞进 e.logFnc，还带着颜色码 */
  #hitName(e) {
    const text = stripAnsi(e.logFnc).trim()
    if (!text) return ''
    return text.replace(/^\[|]$/g, '')
  }

  /**
   * 放宽限流。
   *
   * deal() 里的 msgThrottle 会把 1 秒内重复的同一句话直接丢掉（loader.js checkLimit），
   * 群 CD 同理。放在真实群里是必要的，但沙盒里连点两次「#帮助」没反应只会让人以为坏了，
   * 所以把本次这条对应的记录清掉。只删自己这一条，不动别人的。
   */
  #relaxLimit(e) {
    const msgId = `${e.self_id}:${e.user_id}:${e.raw_message}`
    delete PluginsLoader.msgThrottle[msgId]
    if (e.group_id) {
      delete PluginsLoader.groupCD[e.group_id]
      delete PluginsLoader.singleCD[`${e.group_id}.${e.user_id}`]
    }
  }

  /* ---------------- 场景与事件 ---------------- */

  /** 场景参数兜底。id 保持字符串或数字原样，适配器不一定用数字 QQ 号 */
  #normalizeScene(scene = {}) {
    const num = (v, def) => {
      const s = String(v ?? '').trim()
      if (!s) return def
      return Number(s) || s
    }
    const bots = this.listBots()
    const selfId = String(scene.selfId ?? '').trim() || bots[0]?.uin || ADAPTER_ID
    return {
      selfId: Number(selfId) || selfId,
      isGroup: !!scene.isGroup,
      userId: num(scene.userId, 80000000),
      nickname: String(scene.nickname ?? '').trim() || '沙盒用户',
      groupId: num(scene.groupId, 100000000),
      groupName: String(scene.groupName ?? '').trim() || '沙盒测试群',
      card: String(scene.card ?? '').trim(),
      isMaster: !!scene.isMaster,
      isOwner: !!scene.isOwner,
      isAdmin: !!scene.isAdmin,
      atBot: !!scene.atBot,
      platform: Object.hasOwn(PLATFORMS, scene.platform) ? scene.platform : 'default',
    }
  }

  /** 把前端传来的文本与图片拼成 message 段数组 */
  #buildInbound(text, images) {
    const message = []
    const list = Array.isArray(images) ? images.slice(0, MAX_INBOUND_IMAGES) : []
    for (const img of list) {
      const file = this.#toBase64File(img)
      if (file) message.push({type: 'image', file, url: file})
    }
    const str = typeof text === 'string' ? text : ''
    if (str) message.push({type: 'text', text: str})
    return message
  }

  /**
   * dataURL / 裸 base64 统一成 Yunzai 认的 `base64://` 形式。
   *
   * 各适配器与 puppeteer 都按这个约定读图（见 lib/util.js 的 fileType），
   * 插件拿到 e.img 后无论是转存还是直接发都能用。
   */
  #toBase64File(input) {
    if (typeof input !== 'string' || !input) return null
    if (input.startsWith('base64://')) return input
    const m = input.match(/^data:[^;]*;base64,(.+)$/s)
    if (m) return `base64://${m[1]}`
    if (/^[A-Za-z0-9+/=\s]+$/.test(input)) return `base64://${input.replace(/\s/g, '')}`
    return null
  }

  /**
   * 造一个事件对象。
   *
   * 字段与 `Bot.prepareEvent()` 处理完的成品对齐（见 lib/bot.js），因为我们不走 Bot.em，
   * 那一步补的 bot / friend / group / member / reply 都得自己给全，插件才不会因为少个
   * 字段就抛异常。
   */
  #buildEvent(sc, message) {
    const self = this
    const platform = PLATFORMS[sc.platform] ?? PLATFORMS.default
    const raw = message.map((i) => (i.type === 'text' ? i.text : `[${i.type}]`)).join('')
    const messageId = `sandbox-${Date.now().toString(36)}-${++this.#msgSeq}`

    // 群聊里勾了 at 就在最前面插一段 at，dealEvent 据此置 e.atBot
    if (sc.isGroup && sc.atBot) {
      message = [{type: 'at', qq: sc.selfId, text: `@${sc.selfId}`}, ...message]
    }

    const push = (via) => (msg) => self.#collect(via, msg)

    const friend = this.#makeContact({
      via: 'friend',
      info: {user_id: sc.userId, nickname: sc.nickname, remark: sc.nickname},
    })
    const member = this.#makeContact({
      via: 'member',
      info: {
        user_id: sc.userId,
        group_id: sc.groupId,
        nickname: sc.nickname,
        card: sc.card || sc.nickname,
        is_owner: sc.isOwner,
        is_admin: sc.isAdmin,
        role: sc.isOwner ? 'owner' : sc.isAdmin ? 'admin' : 'member',
      },
    })
    const group = this.#makeContact({
      via: 'group',
      info: {
        group_id: sc.groupId,
        group_name: sc.groupName,
        // deal() 的 checkLimit 会读这两个字段，沙盒里恒为未禁言
        mute_left: 0,
        all_muted: false,
        is_owner: false,
        is_admin: false,
      },
      extra: {
        pickMember: () => member,
        getMemberMap: async () => new Map([[sc.userId, member.info]]),
        getMemberArray: async () => [member.info],
      },
    })

    const e = {
      post_type: 'message',
      message_type: sc.isGroup ? 'group' : 'private',
      sub_type: sc.isGroup ? 'normal' : 'friend',
      self_id: sc.selfId,
      user_id: sc.userId,
      message_id: messageId,
      time: Math.floor(Date.now() / 1000),
      message,
      raw_message: raw,
      sender: {
        user_id: sc.userId,
        nickname: sc.nickname,
        card: sc.isGroup ? (sc.card || sc.nickname) : undefined,
        role: sc.isGroup ? member.info.role : undefined,
      },
      adapter_id: platform.id,
      adapter_name: platform.name,
      /**
       * deal() 里只会把 isMaster 置 true、不会置 false（loader.js dealEvent），
       * 所以这里预设 true 能存活，勾掉主人身份时也不会被真实 master 配置反向覆盖成 true
       * —— 除非沙盒 QQ 号本身就是配置里的主人，那属实是主人，符合预期。
       */
      isMaster: sc.isMaster,
      bot: this.#makeBotProxy(sc, friend, group, member, platform),
      friend,
      reply: push('reply'),
      /** 面板自己用的标记，插件里判断 e.isSandbox 可以跳过高危操作 */
      isSandbox: true,
    }

    if (sc.isGroup) {
      e.group_id = sc.groupId
      e.group_name = sc.groupName
      e.group = group
      e.member = member
    }

    return e
  }

  /** 造一个假的会话对象（好友 / 群 / 群成员），sendMsg 只收不发 */
  #makeContact({via, info, extra = {}}) {
    const self = this
    const contact = {
      ...info,
      info,
      sendMsg: (msg) => self.#collect(via, msg),
      recallMsg: () => true,
      sendFile: (file, name) => self.#collect(via, {type: 'file', file, name}),
      makeForwardMsg: (msg) => Bot.makeForwardMsg(msg),
      sendForwardMsg: (msg) => self.#collect(via, {type: 'node', data: msg}),
      getInfo: () => info,
      getAvatarUrl: () => '',
      /** 插件用 e.getReply() 取引用消息，沙盒里没有历史，给个空 */
      getMsg: () => null,
      getChatHistory: () => [],
      ...extra,
    }
    return contact
  }

  /**
   * e.bot 用真实 Bot 的代理。
   *
   * 插件里读 `e.bot.uin`、`e.bot.fl`、`e.bot.getGroupList()` 很常见，透传真实 Bot 才不会
   * 报错；只有 pick 到沙盒自己这个用户/群时才换成假对象，这样 `e.bot.pickGroup(e.group_id)
   * .sendMsg()` 这种写法也能被截住。pick 到别的目标就是真的 —— 这是「只拦 e 上下文」的
   * 边界，页面上有说明。
   */
  #makeBotProxy(sc, friend, group, member, platform) {
    const real = Bot?.bots?.[sc.selfId] ?? Bot
    const sameUser = (id) => String(id) === String(sc.userId)
    const sameGroup = (id) => String(id) === String(sc.groupId)

    const overrides = {
      pickFriend: (id) => (sameUser(id) ? friend : real.pickFriend?.(id)),
      pickUser: (id) => (sameUser(id) ? friend : real.pickUser?.(id)),
      pickGroup: (id) => (sameGroup(id) ? group : real.pickGroup?.(id)),
      pickMember: (gid, uid) =>
        sameGroup(gid) && sameUser(uid) ? member : real.pickMember?.(gid, uid),
      /** 插件普遍读 adapter.name 判平台，这里给模拟的那个，不是真实账号的 */
      adapter: {id: platform.id, name: platform.name},
    }

    // QQBot 适配器的 markdown 开关，插件会读它决定发不发 md（如 kkkkkk-10086 的 mkbutton）
    if (platform.rich) overrides.config = {markdown: {type: 1}}

    return new Proxy(overrides, {
      get(target, prop) {
        if (prop in target) return target[prop]
        const value = real?.[prop]
        return typeof value === 'function' ? value.bind(real) : value
      },
      has(target, prop) {
        return prop in target || prop in Object(real)
      },
      // 下面两个 trap 让 Object.keys(e.bot) / {...e.bot} 也能看到真实 Bot 的属性，
      // 否则插件遍历 bot 时只会拿到上面那几个 pick 方法
      ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(Object(real))])]
      },
      getOwnPropertyDescriptor(target, prop) {
        const own = Reflect.getOwnPropertyDescriptor(target, prop)
        if (own) return own
        const desc = Reflect.getOwnPropertyDescriptor(Object(real), prop)
        // ownKeys 报出来的键必须是 configurable 的，否则 Object.keys 会抛 invariant
        return desc ? {...desc, configurable: true} : undefined
      },
    })
  }

  /** 收下一条回复。捕获队列关闭后到的（插件后台慢慢发的）直接丢，免得串到下一条消息里 */
  #collect(via, msg) {
    if (!this.#capture) {
      logger.debug(`[Guoba][沙盒] 忽略一条迟到的回复（${via}）`)
      return {message_id: `sandbox-late-${Date.now().toString(36)}`}
    }
    this.#capture.push({via, msg, time: Date.now()})
    return {message_id: `sandbox-${Date.now().toString(36)}`, time: Math.floor(Date.now() / 1000)}
  }

  /* ---------------- 回复规范化 ---------------- */

  /**
   * 把插件发出来的东西拍平成前端能渲染的段数组。
   *
   * 插件传给 reply 的形态五花八门：字符串、Segment 对象、嵌套数组、Buffer、
   * 甚至 `{type:'node'}` 的转发消息，这里统一成 `{type, ...}` 的平坦列表。
   */
  async #normalizeMsg(msg, depth = 0) {
    const out = []
    await this.#flatten(msg, out, depth)
    return out
  }

  async #flatten(msg, out, depth) {
    if (msg === null || msg === undefined || msg === false) return

    if (Array.isArray(msg)) {
      for (const item of msg) await this.#flatten(item, out, depth)
      return
    }

    if (typeof msg === 'string' || typeof msg === 'number' || typeof msg === 'boolean') {
      const text = String(msg)
      if (text) out.push({type: 'text', text})
      return
    }

    // 有插件直接 reply 一个 Buffer，按图片处理（Yunzai 各适配器也是这么认的）
    if (Buffer.isBuffer(msg)) {
      out.push(await this.#fileSeg('image', {file: msg}))
      return
    }

    if (typeof msg !== 'object') return

    const type = msg.type || (msg.file ? 'image' : '')

    switch (type) {
      case 'text':
        if (msg.text) out.push({type: 'text', text: String(msg.text)})
        return
      case 'at':
        out.push({type: 'at', qq: String(msg.qq ?? msg.id ?? ''), name: msg.name ?? msg.text ?? ''})
        return
      case 'reply':
        out.push({type: 'reply', id: String(msg.id ?? msg.text ?? '')})
        return
      case 'face':
        out.push({type: 'face', id: String(msg.id ?? '')})
        return
      case 'image':
      case 'record':
      case 'video':
      case 'file':
        out.push(await this.#fileSeg(type, msg))
        return
      case 'node':
        out.push(await this.#nodeSeg(msg, depth))
        return
      case 'button':
        out.push(this.#buttonSeg(msg))
        return
      case 'markdown':
        out.push(this.#markdownSeg(msg))
        return
      case 'raw':
        // 没法在网页上还原成原样，原始数据丢给前端折叠显示
        out.push({type, raw: this.#dump(msg)})
        return
      default:
        out.push({type: type || 'unknown', raw: this.#dump(msg)})
    }
  }

  /**
   * markdown 段。原生模板（模板 id + params）的内容在 QQ 服务端，本地还原不出来，
   * 只有 content 形式的能渲染，其余照旧摊原始数据。
   */
  #markdownSeg(msg) {
    const data = msg.data
    const content = typeof data === 'string' ? data : data?.content
    const seg = {type: 'markdown'}
    if (typeof content === 'string' && content) seg.content = content
    else seg.raw = this.#dump(msg)
    if (!this.#rich) seg.ignored = true
    return seg
  }

  /**
   * 按钮段。`segment.button(...行)` 的 data 就是参数列表，每个参数是一行、
   * 行内是按钮数组（lib/modules/oicq/index.js），但也有插件直接传单个按钮对象，
   * 这里一律拍成二维。认不出结构时保留原始 JSON，别让按钮悄悄消失。
   */
  #buttonSeg(msg) {
    const rows = []
    for (const row of Array.isArray(msg.data) ? msg.data : [msg.data]) {
      if (!row) continue
      const btns = []
      for (const item of Array.isArray(row) ? row : [row]) {
        const btn = this.#button(item)
        if (btn) btns.push(btn)
      }
      if (btns.length) rows.push(btns)
    }
    const seg = {type: 'button', rows}
    if (!rows.length) seg.raw = this.#dump(msg)
    if (!this.#rich) seg.ignored = true
    return seg
  }

  /**
   * 单个按钮。字段各家写法不一，常见的都认一遍：
   * callback 点击即以该文本触发指令，input 只填进输入框等用户补参数，link 是外链。
   */
  #button(item) {
    if (!item || typeof item !== 'object') return null
    const btn = {text: String(item.text ?? item.label ?? item.render_data?.label ?? '')}
    // 官方 QQBot 的原始结构把动作塞在 action.data 里，是链接还是指令看内容判断
    const act = item.action?.data
    const callback = item.callback ?? item.data ?? (isHttp(act) ? null : act)
    const link = item.link ?? item.url ?? (isHttp(act) ? act : null)
    if (callback != null && typeof callback !== 'object') btn.callback = String(callback)
    if (item.input != null) btn.input = String(item.input)
    if (link != null) btn.link = String(link)
    if (item.permission ?? item.action?.permission) btn.limited = true
    return btn.text || btn.callback || btn.input || btn.link ? btn : null
  }

  /**
   * 图片 / 语音 / 视频 / 文件段。
   *
   * http 直链直接把 url 给前端，让浏览器自己拉，既省一次服务端下载也省内存；
   * base64、本地路径、Buffer 才走 `Bot.fileType` 取字节存进资源表。
   */
  async #fileSeg(type, msg) {
    const seg = {type, name: typeof msg.name === 'string' ? msg.name : ''}
    const src = msg.file ?? msg.url ?? msg.data

    if (isHttp(src)) {
      seg.url = src
      return seg
    }

    let file
    try {
      file = await Bot.fileType({file: src, name: msg.name})
    } catch (err) {
      seg.error = String(err?.message ?? err)
      return seg
    }

    if (!Buffer.isBuffer(file?.buffer)) {
      // fileType 内部把异常吞了，取不到字节时它会返回一个只有 name/url 的壳
      seg.error = '读取失败'
      seg.name ||= file?.name ?? ''
      return seg
    }

    seg.name = seg.name || file.name || ''
    seg.size = file.buffer.length
    const mime = file.type?.mime || (type === 'image' ? 'image/png' : 'application/octet-stream')
    if (file.buffer.length > MAX_ASSET_SIZE) {
      // 超大的不往内存里塞，只把尺寸报给前端
      seg.tooLarge = true
      return seg
    }
    seg.assetId = this.#putAsset(file.buffer, mime, seg.name)
    seg.mime = mime
    return seg
  }

  /** 转发消息。data 是 `{nickname, user_id, message}` 的数组，逐条递归展开 */
  async #nodeSeg(msg, depth) {
    const seg = {type: 'node', nodes: []}
    if (depth >= MAX_FORWARD_DEPTH) {
      // 自引用的 node 会无限套下去，到这层就不再展开
      seg.truncated = true
      return seg
    }
    const list = Array.isArray(msg.data) ? msg.data : [msg.data]
    for (const node of list) {
      if (!node) continue
      seg.nodes.push({
        nickname: String(node.nickname ?? node.name ?? ''),
        userId: String(node.user_id ?? node.uin ?? ''),
        time: node.time ?? null,
        segments: await this.#normalizeMsg(node.message ?? node, depth + 1),
      })
    }
    return seg
  }

  /** 兜底展示：把不认识的段转成一行 JSON，太长的截掉 */
  #dump(msg) {
    let text
    try {
      text = JSON.stringify(msg, (key, value) =>
        Buffer.isBuffer(value) ? `<Buffer ${value.length}>` : value)
    } catch {
      text = String(msg)
    }
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  }
}
