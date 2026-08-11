import {GuobaError, Service} from '#guoba.framework'
import PluginsLoader from '../../../../../lib/plugins/loader.js'
import cfg from '../../../../../lib/config/config.js'
import {AssetStore, normalizeMsg, toBase64File} from './model/msgSegment.js'
import {listBots} from './model/bots.js'

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

/** 资源表（回复里的图片、语音、文件）的上限见 model/msgSegment.js */

/** 入站消息最多允许几张图 */
const MAX_INBOUND_IMAGES = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 剥掉日志字符串里的 ANSI 颜色码，e.logFnc 是带色的 */
const stripAnsi = (str) => String(str ?? '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')

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
  /** 回复里的图片 / 语音 / 文件，段里只给 id，前端按需来拉 */
  #assets = new AssetStore()
  #msgSeq = 0
  /** 同一时刻只跑一条，避免两次执行的回复串在一起 */
  #running = false
  /** 本次执行模拟的平台是否渲染按钮/markdown，靠 #running 的串行保证不串场 */
  #rich = false

  constructor(guobaApp) {
    super(guobaApp)
  }

  /* ---------------- 账号 ---------------- */

  /** 可用账号列表，实现见 model/bots.js（消息记录页也用同一份判据） */
  listBots() {
    return listBots()
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
    const asset = this.#assets.get(id)
    if (!asset) {
      throw new GuobaError('资源不存在或已过期')
    }
    return asset
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
      const file = toBase64File(img)
      if (file) message.push({type: 'image', file, url: file})
    }
    const str = typeof text === 'string' ? text : ''
    if (str) message.push({type: 'text', text: str})
    return message
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
   * 具体规则在 model/msgSegment.js，与「消息记录」页共用一份，两页输出同一套结构，
   * 前端一个组件就能渲染。沙盒这边 download 为默认的 true —— 插件刚生成的图只在
   * 本地磁盘或内存里，不读进资源表就看不到。
   */
  #normalizeMsg(msg) {
    return normalizeMsg(msg, {assets: this.#assets, rich: this.#rich})
  }
}
