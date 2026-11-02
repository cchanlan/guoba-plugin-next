import net from 'node:net'
import fs from 'node:fs/promises'
import {lookup as dnsLookup} from 'node:dns/promises'
import {autowired, GuobaError, Service} from '#guoba.framework'
import {AssetStore, flattenOneBot, normalizeMsg, toBase64File} from './model/msgSegment.js'
import {groupAvatarUrl, userAvatarUrl} from './model/avatar.js'
import {listBots, ensureContacts} from './model/bots.js'
import {getNote, isPinned, setPinned, isBlacklisted, setBlacklisted, setNote} from './model/chatPrefs.js'
import {listTempSessions, rememberTempSession} from './model/chatTempSessions.js'
import {mirrorGroupBlacklist} from './model/qqbotBlacklist.js'
import {packetSupport} from './model/packetSupport.js'
import {describeSendError} from './model/sendError.js'
import {
  decodeCursor as decodeRedisCursor,
  encodeCursor as encodeRedisCursor,
  getRedisClient,
  isQQBot,
  noticeText,
  pureId as pureOpenid,
  qqRedisKeys,
  readPage as readRedisPage,
} from './model/qqRedisStore.js'

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
/** 单张图片的大小上限 */
const MAX_SEND_IMAGE_SIZE = 20 * 1024 * 1024
/**
 * 富媒体单个文件的上限。
 */
const MAX_SEND_MEDIA_SIZE = 60 * 1024 * 1024
/**
 * 富媒体按扩展名判类型。
 */
const MEDIA_EXT = {
  video: new Set(['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ts', 'mpeg', 'mpg']),
  record: new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'ape', 'aiff', 'amr', 'silk']),
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif']),
}
/** 一条消息最多 @ 几个人 */
const MAX_SEND_ATS = 10
/** 一次最多带几个表情（QQ 小黄脸 + 收藏 / 自定义表情合计） */
const MAX_SEND_EMOJIS = 20
/** Raw JSON 的长度上限 */
const MAX_RAW_LEN = 20000
/**
 * 「查看原始消息」留的那份数据。
 *
 * 四档各自的字符上限 + 最多留几条消息。上报原文一般一两 KB，pb 那两档多半是空的，
 * 实际占用远小于上限；上限只是防某条超长消息把内存吃掉。
 */
const MAX_RAW_DUMP = 20000
const MAX_RAW_KEEP = 200
/** dump 里单个字符串的上限，base64 之类的长值截一下 */
const MAX_RAW_STR = 4096
/** dump 的最大深度，protobuf 嵌得深，够看结构就行 */
const MAX_RAW_DEPTH = 14
/** 事件对象上不必 dump 的字段：运行时对象或方法，跟消息内容无关 */
const RAW_SKIP = new Set(['bot', 'friend', 'group', 'member', 'adapter', 'raw'])
/** protobuf 元素 / 原文在各家实现里的字段名，逐个试 */
const PB_ELEM_KEYS = ['elems', 'elements', 'pb_elem', 'pbElem', 'msg_elems', 'msgElems']
const PB_RAW_KEYS = ['pb', 'pb_raw', 'pbRaw', 'protobuf', 'raw_pb', 'msg_pb']
/**
 * pb elem 从 pb raw 的这条路径下取：`3.6.3.1.2`。
 *
 * 同 Packet-plugin 的 `#取`（apps/getMsg.js），路径与要滤掉的那几个 key 都照它来，
 * 好让面板这边看到的跟群里 `#取` 出来的一致。37 / 9 / 16 分别是附加信息、
 * 匿名之类的杂项，不是消息内容。
 */
const PB_ELEM_PATH = ['3', '6', '3', '1', '2']
/**
 * QQBot markdown 正文里的 @ 人写法：`<@openid>`（QQBot-Plugin 拼正文时把 at 段拍成这个）。
 *
 * 网页上认不了这种标签，只会原样露出 32 位十六进制。成员表里有名字就换成 `@昵称`，
 * 跟消息里普通 at 段一个待遇。
 */
const MD_MENTION_RE = /<@!?([0-9a-fA-F]{16,})>/g
/** 同上，但连左右空白一起吃掉 —— 私聊里整个抹掉时用它，免得留下双空格 */
const MD_MENTION_SPACE_RE = /[ \t]*<@!?[0-9a-fA-F]{16,}>[ \t]*/g
/** 这段正文里有没有要补名字的 `<@openid>` */
const hasMdMention = (seg) =>
  seg?.type === 'markdown' && typeof seg.content === 'string' && seg.content.includes('<@')
const PB_ELEM_DROP = ['37', '9', '16']
/** Packet-plugin 的 helper，protobuf 编解码和 send_packet 都靠它 */
const PACKET_HELPER = '../../../../Packet-plugin/model/PacketHelper.js'
/** 代理白名单最多记多少条 url */
const MAX_PROXY_URLS = 3000
/** 昵称兜底缓存上限，超了挤掉最老的一半 */
const MAX_SENDER_NAMES = 2000
/** 群成员昵称缓存上限（按 群 : QQ 记，两个群各自的群名片不会串） */
const MAX_MEMBER_NAMES = 5000
/**
 * 同一个群两次拉成员列表的最小间隔。
 *
 * 群里 @ 的人多半没发过言，缓存里没有，只能去问适配器。适配器那边取成员列表相对重，
 * 而且失败时（协议端不支持、超时）没有缓存可依，不设间隔就变成每条带 @ 的消息都去拉一次。
 */
const MEMBER_FETCH_COOLDOWN = 60 * 1000
/**
 * 一次查不到后的重试间隔。
 *
 * 不能记成永久查不到：适配器的群成员列表是异步填的，消息到得比它早时第一次就问了个空；
 * 反过来也不能每条消息都去问一遍，那会把适配器压死。两者之间取一个中间值。
 */
const MEMBER_MISS_TTL = 10 * 60 * 1000
/** 戳一戳的动作名候选：OneBot v11 各家实现的叫法，逐个试 */
const POKE_ACTIONS = ['send_poke', 'set_poke', 'send_group_poke', '_send_poke', 'poke']
/** 代理单个文件的大小上限 */
const MAX_PROXY_SIZE = 20 * 1024 * 1024
const PROXY_TIMEOUT = 15000
/** 会话列表单页上限 */
const MAX_PAGE_SIZE = 100
/** 会话列表里最后一条消息的摘要长度 */
const PREVIEW_LEN = 40

/**
 * 会话 key。
 */
function sessionKey(botId, type, id) {
  return `${String(botId ?? '').trim()}:${type === 'friend' ? 'friend' : 'group'}:${String(id ?? '').trim()}`
}

/**
 * 现取群信息可以试的动作名。
 *
 * OneBot v11 没有标准接口，各家叫法不同：NapCat / Lagrange 是 `get_group_info`，
 * 有的实现另给一个字段更全的 `get_group_detail` / `get_group_info_ex`。逐个试，
 * 谁认用谁 —— 跟 {@link ChatService#poke} 一个路子。
 *
 * QQ 官方机器人不走这里（它没有 sendApi），单独走 {@link ChatService#fetchQQBotGroupInfo}。
 */
const GROUP_INFO_ACTIONS = ['get_group_info', 'get_group_detail', 'get_group_info_ex']

/**
 * 群信息里各字段在各家实现里的叫法。
 *
 * 适配器把群信息包在不同的壳里（扁平对象、`{data:{…}}`、`{group:{…}}`），逐个试键名
 * 比给每家写一套映射省事，跟 model/bots.js 的 ID_KEYS / LIST_WRAP_KEYS 同一思路。
 *
 * **QQ 官方机器人的那套键名（`group_finger_memo` / `group_class_text` / `group_member_num`）
 * 一定要带上**：它既出现在 `sdk.getGroupInfo()` 的返回里，也是 QQBot-Plugin 写进 `bot.gl`
 * 的那份（见 adapter/pick.js 的 setGroupMap）。少一个键名，QQBot 的群信息卡就是一片
 * 「（未设置）／（无）」，而数据其实一直在手边。
 */
const GROUP_INFO_FIELDS = {
  name: ['group_name', 'groupName', 'name'],
  memberCount: ['member_count', 'memberCount', 'member_num', 'memberNum', 'group_member_num'],
  maxMemberCount: ['max_member_count', 'maxMemberCount', 'max_member_num', 'maxMemberNum'],
  remark: ['group_remark', 'groupRemark', 'remark', 'group_memo', 'groupMemo', 'memo'],
  intro: [
    'group_intro',
    'groupIntro',
    'intro',
    'group_desc',
    'groupDesc',
    'group_description',
    'description',
    // QQ 官方机器人把「群简介」叫群指纹备注
    'group_finger_memo',
    'fingerMemo',
  ],
  category: [
    'group_class',
    'groupClass',
    'group_classify',
    'category',
    'class',
    // QQ 官方机器人的「群分类」，是个给人看的短文本（如「游戏」「交友扩列」）
    'group_class_text',
    'classText',
  ],
  tags: ['group_tags', 'groupTags', 'tags'],
}
/** 字段往下钻几层，够穿透 data / group 这种一层壳就行 */
const GROUP_INFO_DEPTH = 3
/** 现取的群信息缓存多久。右键「刷新群信息」会绕过它 */
const GROUP_LIVE_TTL = 60 * 1000

/**
 * 用户信息（私聊那边点头像看的那张卡）的候选键名。
 *
 * 比群信息简单得多：昵称、好友备注、openid / unionid，就这四样。
 * 面板记录那份（`bot.fl`）与 OneBot 现取那份（`get_friend_info`）键名基本一致，
 * 只有 QQ 官方机器人会在 `fl` 里额外塞 `openid` / `unionid`。
 */
const USER_INFO_FIELDS = {
  name: ['nickname', 'nick', 'name', 'user_name'],
  remark: ['remark', 'friend_remark', 'friendRemark', 'note'],
  openid: ['openid', 'open_id'],
  unionid: ['unionid', 'union_id'],
}
/**
 * OneBot 系问好友信息的动作名。
 *
 * 没有统一标准：go-cqhttp 系是 `get_friend_info`，OneBot v11 标准里叫 `get_stranger_info`。
 * 跟群信息、戳一戳一样逐个试，谁认用谁。
 */
const USER_INFO_ACTIONS = ['get_friend_info', 'get_stranger_info']
/** 现取的用户信息缓存多久，跟群信息一个节奏 */
const USER_LIVE_TTL = GROUP_LIVE_TTL

/**
 * 群成员信息（点头像卡片里的「入群时间」）的候选键名。
 *
 * 消息事件本身不带入群时间，只能点开卡片时现问适配器：icqq 的 `getInfo()` 与
 * OneBot 的 `get_group_member_info` 都叫 `join_time`，QQ 官方那边叫 `joined_at`，
 * 其余别名是给别的实现留的。
 */
const MEMBER_INFO_FIELDS = {
  joinTime: [
    'join_time', 'joinTime', 'join_time_stamp', 'joinTimeStamp',
    'join_group_time', 'joinGroupTime', 'join_at', 'joinAt', 'joined_at', 'joinedAt',
  ],
  /** 个性签名不是群成员接口给的，得单独问 get_stranger_info，见 #fetchSign */
  sign: ['longNick', 'long_nick', 'sign', 'signature', 'personalSign', 'personality'],
}
/** 成员信息现取的缓存：成功 5 分钟，失败 30 秒（失败重试别太勤，也别让刚入群的看不到） */
const MEMBER_LIVE_TTL = 5 * 60 * 1000
const MEMBER_LIVE_MISS_TTL = 30 * 1000
/** 群成员列表缓存多久。@ 索引是边打边过滤，一分钟内不重复问协议端 */
const MEMBER_LIST_TTL = 60 * 1000
/** 一次最多回多少个成员，大群全量塞给前端没必要 */
const MAX_MEMBER_LIST = 500

/**
 * 在响应里按候选键名找值，可以往下钻几层。
 *
 * 默认只要标量（群名、人数这些都是），`allowArray` 打开后才认数组 ——
 * 群标签是数组，被标量过滤挡掉的话 `tagsOf` 永远拿不到东西。
 */
function probeFields(source, keys, depth = GROUP_INFO_DEPTH, allowArray = false) {
  if (!source || typeof source !== 'object' || depth < 0) return undefined
  for (const key of keys) {
    const value = source[key]
    if (value == null || value === '') continue
    if (typeof value === 'object' && !(allowArray && Array.isArray(value))) continue
    return value
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const hit = probeFields(value, keys, depth - 1, allowArray)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** 把探到的值收成字符串，空值一律给空串，前端统一按「（未设置）」显示 */
function textOf(source, keys) {
  const hit = probeFields(source, keys)
  return hit == null ? '' : String(hit).trim()
}

/** 把探到的值收成正整数，认不出给 0 */
function numOf(source, keys) {
  const hit = Number(probeFields(source, keys))
  return Number.isFinite(hit) && hit > 0 ? Math.round(hit) : 0
}

/**
 * 入群时间归一成秒。
 *
 * OneBot / icqq 给的是秒，个别实现给毫秒，QQ 官方给 ISO 字符串 —— 三种都收，
 * 认不出返回 0。
 */
function joinTimeOf(source) {
  const raw = probeFields(source, MEMBER_INFO_FIELDS.joinTime)
  if (raw == null || raw === '') return 0
  if (typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw.trim())) {
    const at = Date.parse(raw)
    return Number.isFinite(at) && at > 0 ? Math.floor(at / 1000) : 0
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n > 1e12 ? n / 1000 : n)
}

/**
 * 群标签：QQ 官方机器人每个群最多挂十几个词，OneBot 系没有这个概念。
 *
 * 元素可能是裸字符串，也可能是 `{text}` / `{name}` 这种对象，两种都收。
 */
function tagsOf(source) {
  const hit = probeFields(source, GROUP_INFO_FIELDS.tags, GROUP_INFO_DEPTH, true)
  if (!Array.isArray(hit)) return []
  const out = []
  for (const item of hit) {
    const text = typeof item === 'string' ? item : (item?.text ?? item?.name ?? '')
    const t = String(text ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 把 QQ 官方机器人 `getGroupInfo` 的报错翻译成人话。
 *
 * 错误码是 QQ 那套（跟 OneBot 的 retcode 不是一个体系），QQBot-Web-Adapter 里也是
 * 按同一组码分的，这里对齐它 —— 面板上写「11293」没人看得懂，
 * 但「机器人非群成员」一眼就知道该干什么。
 */
function describeQQBotGroupError(err) {
  const msg = String(err?.message ?? err ?? '')
  if (/11293|非群成员|鉴权失败|kicked/i.test(msg)) {
    return '机器人不是这个群的成员，取不到群信息'
  }
  if (/1125[0-9]|invalid request/i.test(msg)) {
    return '该群状态异常（可能已解散或封禁），取不到群信息'
  }
  return `QQ 那边取群信息失败：${msg || '未知错误'}`
}

/**
 * 已挂上的 message 监听存在 process 上。
 *
 * 热重载时本模块会被重新 import，模块级变量与实例都是新的，但上一代挂在 Bot 上的监听
 * 还在，不摘掉就会一条消息进两次缓冲。同 LogService 的 ORIGIN_KEY。
 */
const LISTENER_KEY = Symbol.for('guoba.chatService.listener')

/** 非文本段在会话列表摘要里的占位 */
/**
 * markdown 段在会话列表里的摘要。
 */
function mdPreview(content) {
  return String(content ?? '')
    // 图片：alt 里带 `#宽px #高px` 的那种是 QQ 自动加的，认不出内容，统一写「图片」
    .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, (whole, alt) => (alt && !alt.includes('#') ? alt : '[图片]'))
    .replace(/\[([^\]\n]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>\s]+/gm, '')
    .replace(/[`*_~]+/g, '')
}

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
 * 富媒体文件该用哪个段类型。
 * @param file multer 给的文件对象（有 originalname / mimetype）
 */
function mediaSegType(file) {
  const mime = String(file?.mimetype ?? '').toLowerCase()
  const name = String(file?.originalname ?? '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() : ''
  if (mime.startsWith('image/') || MEDIA_EXT.image.has(ext)) return 'image'
  if (mime.startsWith('video/') || MEDIA_EXT.video.has(ext)) return 'video'
  if (mime.startsWith('audio/') || MEDIA_EXT.record.has(ext)) return 'record'
  return 'file'
}

/**
 * 是不是私有 / 环回 / 链路本地地址。
 *
 * 图片代理只在浏览器直连失败时兜底，而能直连的都是公网地址，所以拦掉内网对正常使用
 * 没有影响 —— 但能挡住拿这个接口探测 Bot 所在内网。解析不出来的一并当作不安全。
 */
export function isPrivateIp(ip) {
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
 *    含 bot 自己发的，比自建存储可靠。QQ 官方机器人（QQBot 适配器）没这个方法，
 *    改从 QQBot-Plugin 落进 Redis 的那份记录里读（见
 *    model/qqRedisStore.js）。两者都没有就只能看面板运行期间的消息。
 *
 * 缓冲只在内存里，重启即丢；要长期留存请用 QQ 客户端。
 */
export default class ChatService extends Service {

  /** 收藏 / 自定义表情的存取，发送时按它把表情换成字节 */
  chatEmojiService = autowired('chatEmojiService')

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
   * userId -> 最近见过的昵称。
   *
   * 有的 OneBot 实现（llob 等）上报消息时不带 sender 昵称，只有 qq 号，导致页面上
   * 显示不出名字。这里把每条消息里带名字的 sender 记下来，之后再见到同一个 id 就能兜底。
   */
  #names = new Map()
  /**
   * `群号:QQ` -> 群名片（缺了用昵称）。
   *
   * 只为 @ 段服务：OneBot 的 at 段里那个 `name` 字段是可选的，NapCat / Lagrange 上报时
   * 多数不给，页面上就只剩一串 QQ 号。群里发过言的人的昵称能从消息里顺手记下来，
   * 但被 @ 的人常常一句话没说，得问适配器要群成员列表才拿得到名字。
   */
  #memberNames = new Map()
  /** `群号:QQ` -> 上次没查到的时间戳，过了 MEMBER_MISS_TTL 再试一次 */
  #memberMiss = new Map()
  /** 群号 -> 上次去适配器拉成员列表的时间戳 */
  #memberFetched = new Map()
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
  /**
   * 「查看原始消息」的数据：messageId -> {array, raw, pbElem, pbRaw}。
   *
   * 都是已经序列化好的字符串 —— 事件对象上挂着 bot / friend 这些运行时对象，直接留引用
   * 会把整个 Bot 拖在内存里，收到时就 dump 成文本最省事。不随消息一起下发，
   * 前端点开弹窗才单独取一次。
   */
  #raws = new Map()
  /** Packet-plugin 的 helper：undefined 是还没试过，null 是没装 */
  #packet = undefined
  /** `botId:type:id` —— 这些会话上「不带 message_seq 重试」试过也没用，见 {@link getHistory} */
  #noRetryHistory = new Set()
  /**
   * 现取的群信息缓存：会话 key -> {at, data}。
   *
   * 群信息弹窗一打开就要问一次适配器，而它比读缓存慢得多（协议端往返），
   * 来回点几次同一个群没必要每次都问。右键「刷新群信息」用 refresh 绕开它。
   */
  #groupLiveCache = new Map()
  /**
   * 现取的用户信息缓存：会话 key -> {at, data}。理由同群信息那份。
   *
   * 只有 OneBot 系会往里放东西 —— QQ 官方机器人不现取（SDK 上压根没有好友信息接口），
   * 见 {@link ChatService#userInfo}。
   */
  #userLiveCache = new Map()
  /**
   * 现取的群成员信息缓存：`botId:群号:QQ` -> {at, data}。
   *
   * 点一次头像问一次适配器，同一个人来回点没必要每次都问；失败的也留一小会儿，
   * 免得协议端不支持时每点一下都卡一下。
   */
  #memberLiveCache = new Map()
  /** 群成员列表缓存：`botId:群号` -> {at, list}，@ 索引和群成员查询共用 */
  #memberListCache = new Map()
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

    /**
     * QQBot 的段里有三样 OneBot 系没有的东西，交给解析层处理（见 #msgOpts）：
     * 裸 openid 的 @、客户端表情的内联标记、以及**机器人发来的 markdown**。
     *
     * 别的机器人（`author.bot`）的正文一律按 markdown 走。自己发的那条不算：走 legacy 档时正文就是纯文本，
     * 当 markdown 解析会把 `#`、`>`、`*` 这些字符按语法吃掉。
     */
    const segments = await normalizeMsg(e.message, this.#msgOpts(botId, {
      botMarkdown: !self && e.raw_event?.d?.author?.bot === true,
    }))
    // sender 先过一遍 —— 他会进 #names，下面补 @ 名字时就能用上
    const sender = this.#sender(e.sender, e.user_id, botId, self)
    // 补全 @ 段的昵称。放在 #push 之前，进缓冲的就是补齐过的段。
    // markdown 正文里的 `<@openid>` 也得算 —— QQBot 的正文就是 markdown，
    // 只认 at 段的话这种消息会原样露出 32 位十六进制
    if (segments.some((s) => s?.type === 'at' || hasMdMention(s))) {
      await this.#resolveNames(segments, {botId, type, id})
    }
    const messageId = e.message_id != null ? String(e.message_id) : ''
    await this.#push({
      key: `${botId}:${type}:${id}`,
      botId,
      type,
      id,
      messageId,
      eventId: String(e.event_id ?? ''),
      messageSeq: this.#seqOf(e),
      time: Number(e.time) || Math.floor(Date.now() / 1000),
      self,
      sender,
      segments,
    }, {unread: !self})
    /**
     * 非好友私聊落一份盘：临时会话只活在收到的消息里，不进 `bot.fl`，
     * 不存的话重启就没了。好友表可能还没加载，先记下来，展示时再按好友表过滤。
     */
    if (type === 'friend' && !self) {
      const friends = Bot.getFriendMap?.()
      const isFriend = friends instanceof Map
        && (friends.has(Number(id)) || friends.has(id))
      if (!isFriend) {
        const active = this.#sessions.get(`${botId}:friend:${id}`)
        rememberTempSession({
          key: `${botId}:friend:${id}`,
          botId,
          userId: id,
          name: sender.nickname || sender.card || '',
          lastTime: active?.lastTime ?? Math.floor(Date.now() / 1000),
          lastText: active?.lastText ?? '',
          groupId: String(e.group_id ?? ''),
        })
      }
    }
    // 事件里的原始数据比历史接口给的全（有上报原文），后来的以它为准
    if (messageId) {
      const upload = this.#parseUpload(e)
      this.#storeRaw(messageId, {
        array: this.#dump(e.message),
        raw: this.#rawText(e, upload),
        pbElem: this.#pickPb(PB_ELEM_KEYS, upload, e),
        pbRaw: this.#pickPb(PB_RAW_KEYS, upload, e),
      })
    }
  }

  /* ---------------- 原始数据 ---------------- */

  /**
   * 存一条的原始数据。
   *
   * @param overwrite 已经有了要不要盖掉。实时事件覆盖历史接口的，反过来不行
   */
  #storeRaw(messageId, item, {overwrite = true} = {}) {
    const id = String(messageId ?? '')
    if (!id) return
    if (!overwrite && this.#raws.has(id)) return
    this.#raws.delete(id)
    this.#raws.set(id, item)
    // Map 保持插入序，超量从最早的开始丢
    while (this.#raws.size > MAX_RAW_KEEP) {
      const first = this.#raws.keys().next().value
      if (first === undefined) break
      this.#raws.delete(first)
    }
  }

  /** OneBot 适配器把收到的上报原文留在 `e.raw` 上，能解析出来就用它当「msg raw」 */
  #parseUpload(e) {
    if (typeof e?.raw !== 'string' || !e.raw.trim()) return null
    try {
      const parsed = JSON.parse(e.raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** 上报原文：能解析就美化，解析不了给原文，没有原文就 dump 事件对象自己 */
  #rawText(e, upload) {
    if (upload) return this.#dump(upload)
    if (typeof e?.raw === 'string' && e.raw.trim()) return this.#clip(e.raw)
    return this.#dump(e)
  }

  /**
   * 取 protobuf 那两档。
   *
   * 只有走协议的适配器（icqq / 开了 packet 的实现）才会带上，OneBot 上报里通常没有，
   * 取不到就返回空串，前端如实说明「当前适配器没提供」。
   */
  #pickPb(keys, ...sources) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue
      for (const key of keys) {
        const val = source[key]
        if (val == null || val === '' || (Array.isArray(val) && !val.length)) continue
        return this.#dump(val)
      }
    }
    return ''
  }

  /** 超长就截断，末尾标一下原长度 */
  #clip(text, max = MAX_RAW_DUMP) {
    const str = String(text ?? '')
    if (str.length <= max) return str
    return `${str.slice(0, max)}\n…（已截断，共 ${str.length} 字符）`
  }

  /**
   * 序列化成可读 JSON。
   *
   * `JSON.stringify` 直接上会栽在三处：事件对象里 bot / group 互相引用、protobuf 里的
   * uin 是 bigint、图片段可能带 Buffer。所以自己走一遍，顺手把长值和深层结构压掉。
   */
  #dump(value) {
    if (value == null) return ''
    const seen = new WeakSet()
    const walk = (val, depth, top = false) => {
      if (val === null) return null
      const type = typeof val
      if (type === 'string') return val.length > MAX_RAW_STR
        ? `${val.slice(0, MAX_RAW_STR)}…（共 ${val.length} 字符）`
        : val
      if (type === 'number' || type === 'boolean') return val
      if (type === 'bigint') return String(val)
      if (type === 'function' || type === 'symbol' || type === 'undefined') return undefined
      if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
        // 池化的 Buffer 里 byteOffset 不一定是 0，取字节要走 subarray 而不是 .buffer
        const head = Buffer.from(val.subarray(0, 32)).toString('hex')
        return `[二进制 ${val.length} 字节] ${head}${val.length > 32 ? '…' : ''}`
      }
      if (depth > MAX_RAW_DEPTH) return '[层级过深]'
      if (seen.has(val)) return '[循环引用]'
      seen.add(val)
      try {
        if (Array.isArray(val)) return val.map((item) => walk(item, depth + 1))
        if (val instanceof Set) return [...val].map((item) => walk(item, depth + 1))
        // Map 转对象后再走下面的通用分支，注意别覆盖 val，否则 finally 里销不掉 seen
        const target = val instanceof Map ? Object.fromEntries(val) : val
        const out = {}
        for (const key of Object.keys(target)) {
          // 顶层是事件对象时跳过运行时字段，深层的照常（段里也可能有叫 group 的键）
          if (top && RAW_SKIP.has(key)) continue
          let item
          try {
            item = walk(target[key], depth + 1)
          } catch (err) {
            // getter 抛异常的字段不该拖垮整份 dump
            item = `[取值失败：${err?.message ?? err}]`
          }
          if (item !== undefined) out[key] = item
        }
        return out
      } finally {
        seen.delete(val)
      }
    }
    try {
      return this.#clip(JSON.stringify(walk(value, 0, true), null, 2) ?? '')
    } catch (err) {
      return `[序列化失败：${err?.message ?? err}]`
    }
  }

  /**
   * 四档原始数据，给「查看原始消息」用。
   *
   * 前两档优先现取 —— `get_msg` 拿到的比缓冲里存的全（缓冲只是重启后 / 适配器没这
   * 接口时的兜底）。后两档得走协议：借 Packet-plugin 的 helper 用 NapCat 的
   * `send_packet` 发 SsoGetGroupMsg，跟群里 `#取` 是同一条路。
   */
  async getRaw({botId, type, id, messageId} = {}) {
    const mid = String(messageId ?? '').trim()
    if (!mid) throw new GuobaError('缺少消息 id')
    const cached = this.#raws.get(mid)
    const out = {
      found: !!cached,
      array: cached?.array ?? '',
      raw: cached?.raw ?? '',
      pbElem: cached?.pbElem ?? '',
      pbRaw: cached?.pbRaw ?? '',
      /** pb 那两档取不到时的原因，前端原样显示 */
      pbNote: '',
    }

    const bot = this.#bot(botId)
    let realSeq = null
    /** get_msg 成功返回了、但里面没有 real_seq —— 跟「get_msg 整个失败」是两码事，见 #getPb */
    let seqMissing = false
    if (typeof bot?.sendApi === 'function') {
      try {
        const res = await bot.sendApi('get_msg', {message_id: mid})
        // sendApi 回来的是个 Proxy，data 里的字段直接取得到
        const data = res?.data ?? res
        if (data && typeof data === 'object') {
          out.raw = this.#dump(data)
          if (data.message != null) out.array = this.#dump(data.message)
          out.found = true
          realSeq = data.real_seq ?? null
          seqMissing = realSeq == null
        }
      } catch (err) {
        // 消息太旧、实现没这接口都会失败，缓冲里那份还在，继续
        logger.debug(`[Guoba][消息记录] get_msg 失败：${err?.message ?? err}`)
      }
    }

    const pb = await this.#getPb({bot, type, id, messageId: mid, realSeq, seqMissing})
    out.pbNote = pb.pbNote ?? ''
    // 上报里自带 pb 字段的适配器（icqq 那类）留在缓冲里，协议现取到的优先
    out.pbElem = pb.pbElem || out.pbElem
    out.pbRaw = pb.pbRaw || out.pbRaw
    return out
  }

  /**
   * 自己发一次取历史的请求。
   *
   * 跟适配器的 `getChatHistory` 的唯一区别：**取最新时不带 `message_seq`**。适配器那边写死了
   * 要传（取最新时传 0），而有的协议端只处理了「不带」的情形，收到 0 就在自己那边炸
   * —— 见 {@link getHistory} 里的说明。
   *
   * @return {Promise<object[]|null>}
   */
  async #historyViaApi({botId, type, id, count, seq}) {
    const bot = this.#bot(botId)
    if (typeof bot?.sendApi !== 'function') throw new GuobaError('当前适配器没有 sendApi')
    const isGroup = type === 'group'
    const params = isGroup
      ? {group_id: Number(id) || id}
      : {user_id: Number(id) || id}
    params.count = count
    params.reverseOrder = true
    // 0 表示「取最新」，这种情况下把参数整个省掉
    if (seq) params.message_seq = seq

    const res = await bot.sendApi(isGroup ? 'get_group_msg_history' : 'get_friend_msg_history', params)
    // sendApi 回来的是个 Proxy，messages 直接取得到；不同实现也可能直接给数组
    const msgs = res?.messages ?? res?.data?.messages ?? res?.data ?? res
    if (!Array.isArray(msgs)) throw new GuobaError('协议端没有返回 messages 数组')
    // 适配器会用 parseMsg 把 `{type, data}` 扁平化，自己发请求就得自己来一遍，
    // 否则下游拿到的段结构跟实时消息不一致
    return msgs.map((it) => (it?.message ? {...it, message: flattenOneBot(it.message)} : it))
  }

  /**
   * 按 bot_id 取账号，不传就用默认的那个。
   *
   * 选到 mock（JiuLi 调试适配器）时**不要**偷偷换成真账号：mock 的 sendMsg 只写进内存数组，
   * 真账号的会发到真群里 —— 用户在沙盒里试发一条，消息就跑到别人群里去了。
   * 默认账号由 model/bots.js 的 listBots 把伪账号沉到末尾来保证（见 utils/account.js）。
   */
  #bot(botId) {
    const uin = Number(botId) || botId
    return (uin && Bot.bots?.[uin]) || null
  }

  /**
   * 取 protobuf 那两档。
   *
   * 依赖三样东西，缺哪样都如实说明而不是留白：群消息、Packet-plugin（提供 pb 编解码）、
   * 协议端支持 `send_packet` —— 那是 NapCat 的 packet 模式扩展，别家协议端没有这个接口。
   */
  async #getPb({bot, type, id, messageId, realSeq, seqMissing}) {
    if (typeof bot?.sendApi !== 'function') {
      return {pbNote: '当前适配器没有 sendApi，取不了 protobuf。'}
    }
    if (type !== 'group') {
      return {pbNote: 'protobuf 只能取群消息 —— 走的是 SsoGetGroupMsg，私聊没有对应的包。'}
    }
    const helper = await this.#packetHelper()
    if (!helper) {
      return {pbNote: '没找到 Packet-plugin。protobuf 的编解码由它提供，装上并让协议端开启 packet 模式（NapCat）后这两档才有内容。'}
    }

    const support = this.#packetSupport(bot)
    // get_msg 明明成功了却没有 real_seq，说明这个协议端不给这个字段。Packet-plugin 内部
    // 也只会拿同一个接口再问一遍，白跑一趟还会抛「请尝试更新 napcat」误导人，直接说清楚
    if (realSeq == null && seqMissing) {
      return {pbNote: support.unsupported
        ? support.note
        : `协议端没有在 get_msg 里返回 real_seq，取不到 SsoGetGroupMsg 需要的消息序号。${support.note}`}
    }

    try {
      // helper 只用到 e.bot 与 e.group_id，给个最小的假 e 就行
      const fakeEvent = {bot, group_id: Number(id) || id}
      const data = await helper.getMsg(fakeEvent, realSeq ?? messageId, realSeq != null)
      if (!data) {
        return {pbNote: support.unsupported ? support.note : `协议端没有返回 protobuf 数据。${support.note}`}
      }
      let elems = PB_ELEM_PATH.reduce((cur, key) => cur?.[key], data)
      elems = Array.isArray(elems)
        ? elems.filter((item) => !PB_ELEM_DROP.includes(Object.keys(item ?? {})[0]))
        : []
      return {
        // 用 Packet-plugin 的 replacer，bigint 出来是 `123L`、Buffer 是 `hex->…`，跟 `#取` 一致
        pbRaw: this.#stringify(data, helper.replacer),
        pbElem: elems.length ? this.#stringify(elems, helper.replacer) : '',
        pbNote: elems.length ? '' : '这条消息在 pb 里没有 elem 元素（滤掉杂项后是空的），pb raw 档还是完整的。',
      }
    } catch (err) {
      // 不支持的协议端上，Packet-plugin 抛的原文（「请尝试更新 napcat」之类）只会让人白折腾，
      // 留给日志，界面上给准确的那句
      if (support.unsupported) {
        logger.debug(`[Guoba][消息记录] 取 protobuf 失败（${support.label}）：${err?.message ?? err}`)
        return {pbNote: support.note}
      }
      return {pbNote: `取 protobuf 失败：${err?.message ?? err}\n${support.note}`}
    }
  }

  /**
   * 当前协议端支不支持取 pb，以及取不到时该说什么。见 {@link packetSupport}。
   */
  #packetSupport(bot) {
    return packetSupport(bot)
  }

  /** Packet-plugin 是可选依赖，动态 import 一次，成功与失败都记下来不重复试 */
  async #packetHelper() {
    if (this.#packet !== undefined) return this.#packet
    try {
      this.#packet = await import(PACKET_HELPER)
    } catch (err) {
      logger.debug(`[Guoba][消息记录] 没加载到 Packet-plugin：${err?.message ?? err}`)
      this.#packet = null
    }
    return this.#packet
  }

  #stringify(value, replacer) {
    try {
      return this.#clip(JSON.stringify(value, replacer, 2) ?? '')
    } catch (err) {
      return `[序列化失败：${err?.message ?? err}]`
    }
  }

  /** 翻页游标。NapCat 给 message_seq，缺了就退回 message_id（部分实现里两者同值） */
  #seqOf(item) {
    const seq = item?.message_seq ?? item?.real_seq ?? item?.message_id
    return seq != null && seq !== '' ? String(seq) : ''
  }

  /**
   * normalizeMsg 的适配器开关。
   * @param botMarkdown 这段正文要不要直接当 markdown 渲染，见 {@link ChatService}
   */
  #msgOpts(botId, {botMarkdown = false} = {}) {
    const bot = this.#bot(botId)
    const qqbot = isQQBot(bot)
    return {
      download: false,
      botMarkdown,
      selfId: qqbot ? String(botId ?? '') : '',
      sep: bot?.adapter?.sep || ':',
      dropFace: qqbot,
    }
  }

  #sender(sender, userId, botId, self = false) {
    const uin = String(sender?.user_id ?? userId ?? '')
    const card = String(sender?.card ?? '')
    const nickname = String(sender?.nickname ?? '')
    const name = card || nickname
    /**
     * 记一份，给之后 @ 他、或别处缺昵称的消息兜底（满了自动挤掉最老的一半）。
     *
     * **机器人自己发的消息要单独记。** QQBot-Plugin 存自家人消息时，`user_id` 写的是
     * **会话对方**的 id（它存的是会话标识），而 nickname 是机器人自己的。照 user_id 记，
     * 等于把对方的名字写成了机器人自己 —— 之后正文里 `<@对方openid>` 解析出来就是
     * `@机器人`（私聊里那个「@狐泽」就是这么来的）。所以这条只按机器人自己的账号记。
     */
    if (name) this.#rememberName(self ? String(botId ?? '') : uin, name)
    // 有的实现上报不带昵称，兜底用之前见过的名字；自家那条别去查 uin，那查出来是对方的
    const fallback = self ? String(this.#bot(botId)?.nickname ?? '') : this.#names.get(uin) || ''
    return {
      userId: uin,
      nickname: nickname || fallback || '',
      card,
      role: String(sender?.role ?? ''),
      /** 群头衔，页面上跟在昵称后面显示一个小标签 */
      title: String(sender?.title ?? ''),
      openid: String(sender?.openid ?? ''),
      unionid: String(sender?.unionid ?? ''),
      /** QQBot 这类适配器事件里直接带头像地址，没带的按 id 算（见 model/avatar.js） */
      avatar: userAvatarUrl(uin, botId, sender?.avatar),
    }
  }

  /**
   * 入缓冲。已经有同一条 messageId 的就不再进 —— NapCat 若开了自身消息上报，
   * 面板自己发的那条会先被本地塞进来一次、再从事件里来一次。
   *
   * @param remember 段里的 http 直链要不要进代理白名单。只有适配器给的才算，
   *                 面板自己发出去的不算（Raw 档能自填 url，那等于放开任意地址代理）
   */
  async #push(msg, {unread = false, remember = true} = {}) {
    if (!msg.key) return null
    if (msg.messageId && this.#index.has(msg.messageId)) return this.#index.get(msg.messageId)
    // 补全 @ 段的昵称。放在入缓冲之前，存下来的就是补齐过的段
    if (remember) await this.#resolveNames(msg.segments, msg)
    msg.seq = this.#seq++
    this.#messages.push(msg)
    if (msg.messageId) this.#index.set(msg.messageId, msg)
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
      else if (seg.type === 'markdown') text += mdPreview(seg.content) || PREVIEW_TEXT.markdown
      // 表情包也是一张图，但摘要是给人扫一眼的，写成 [表情] 比 [图片] 准确
      else if (seg.type === 'image' && seg.subType === 1) text += PREVIEW_TEXT.face
      else text += PREVIEW_TEXT[seg.type] ?? `[${seg.type}]`
      if (text.length > PREVIEW_LEN) break
    }
    text = text.replace(/\s+/g, ' ').trim()
    const name = msg.self ? '我' : (msg.sender?.card || msg.sender?.nickname || '')
    const body = text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text
    return name ? `${name}：${body}` : body
  }

  /**
   * 入库前的收尾：补全 @ 段的昵称，并把段里的 http 直链记进代理白名单。
   * （白名单跟缓冲一起淘汰，原来单有一个 #remember 做这事，现在合成一趟走完）
   */
  async #resolveNames(segments, {botId, type, id} = {}, {remember = true} = {}) {
    const groupId = type === 'group' ? String(id ?? '') : ''
    /**
     * 有要补的名字才值得往下走：群里的 at 段 / markdown 正文里的 `<@openid>`。
     * 私聊也有 —— 那边没有成员表，但好友表里有对方，见下面 nameOf 的第 2 级。
     *
     * 白名单那件事不跟它一起早退：一张图也不 @ 的消息（绝大多数）照样要登记 url。
     */
    const wantNames = segments?.some?.((s) => s?.type === 'at' || hasMdMention(s))
    if (!wantNames && !remember) return
    const cold = []
    /** at 段 / markdown 正文里的 openid 都按 `${selfId}:${openid}` 这个完整形式进缓存 */
    const bot = this.#bot(botId)
    const sep = bot?.adapter?.sep || ':'
    const qqbot = isQQBot(bot)
    /** 机器人自己被 @ 时段的 `qq` 就是账号本身，成员表里没这一号 */
    const selfUin = String(botId ?? '')
    /**
     * 名字分三级取：
     * 1. 群名片表（`群号:成员id`）—— 群里发过言的、以及从成员列表拉回来的
     * 2. 私聊的好友表（`bot.fl`）—— 私聊里没有成员表，正文 @ 的那个人就是会话对方
     * 3. 全局昵称表 —— 谁发过言就记谁
     *
     * 第 3 级只给 QQBot 兜底。它是最不可靠的一级：靠消息里带的 sender 现攒，
     * 对方一直没说话时就是空的（那时只剩第 2 级撑着）。
     */
    const nameOf = (uin) => {
      const hit = groupId ? this.#memberNames.get(`${groupId}:${uin}`) : ''
      if (hit) return hit
      if (!qqbot) return ''
      // 私聊：直接问好友表，别指望对方发过言
      if (!groupId) {
        const friend = textOf(this.#friendEntry(String(uin)), USER_INFO_FIELDS.name)
        if (friend) return friend
      }
      return this.#names.get(String(uin)) || ''
    }

    const walk = (list) => {
      for (const seg of list ?? []) {
        if (remember && typeof seg?.url === 'string' && seg.url.startsWith('http')) {
          // Set 保持插入序，超量时从最早的开始丢
          if (this.#proxyUrls.size >= MAX_PROXY_URLS) {
            const first = this.#proxyUrls.values().next().value
            if (first !== undefined) this.#proxyUrls.delete(first)
          }
          this.#proxyUrls.add(seg.url)
        }
        if (seg?.type === 'at' && seg.qq) {
          const uin = String(seg.qq)
          if (!seg.name && uin !== 'all') {
            if (uin === selfUin) {
              seg.name = String(bot?.nickname ?? '') || '机器人'
            } else {
              const name = nameOf(uin)
              if (name) seg.name = name
              else if (groupId) cold.push(uin)
            }
          }
        }
        if (hasMdMention(seg)) {
          /**
           * 私聊里没有 @ 这回事 —— 一对一只剩对方一个人，@ 谁都是他，写了也是废话。
           * 所以正文里的 `<@openid>` 整个抹掉：既别露出 32 位十六进制，也别写成 `@对方`。
           * 群里照旧换成 `@昵称`。
           */
          if (!groupId) {
            const before = seg.content
            // 连左右空白一起吃，免得 `你好 <@x> 在吗` 抹完变成双空格
            seg.content = before.replace(MD_MENTION_SPACE_RE, ' ')
            // 原来就以 @ 开头时上面会留一个行首空格；只在这种时候去，
            // 别的一律不动 —— 无差别 trim 会把 markdown 的缩进代码块也吃掉
            if (/^[ \t]*<@/.test(before)) seg.content = seg.content.replace(/^[ \t]+/, '')
          } else {
            seg.content = seg.content.replace(MD_MENTION_RE, (whole, openid) => {
              const uin = `${botId}${sep}${openid}`
              const name = nameOf(uin)
              if (name) return `@${name}`
              // 缓存里还没有就先原样留着，名字取回来后再走一趟（调用方本来就跑两趟）
              cold.push(uin)
              return whole
            })
          }
        }
        if (Array.isArray(seg?.nodes)) {
          for (const node of seg.nodes) walk(node.segments)
        }
      }
    }
    walk(segments)

    // 群里 @ 的人多半没发过言，缓存里没有，去适配器要一次成员列表
    if (cold.length) await this.#fillMemberNames(groupId, botId, [...new Set(cold)])
  }

  /** 把一次拿到的群成员灌进缓存；成员对象各家实现字段略有出入，两个名字都认 */
  #cacheMembers(groupId, members) {
    for (const info of members ?? []) {
      const uin = String(info?.user_id ?? info?.userId ?? '')
      if (!uin) continue
      const name = String(info?.card || info?.nickname || info?.name || '').trim()
      if (!name) continue
      this.#memberNames.set(`${groupId}:${uin}`, name)
      this.#rememberName(uin, name)
    }
    this.#trimMembers()
  }

  #trimMembers() {
    // 顺手把过期的那批「没查到」清掉 —— 每次补名字都会走这儿，不必单开一个定时器
    for (const [key, at] of this.#memberMiss) {
      if (Date.now() - at < MEMBER_MISS_TTL) continue
      this.#memberMiss.delete(key)
    }
    if (this.#memberNames.size <= MAX_MEMBER_NAMES) return
    for (const key of this.#memberNames.keys()) {
      this.#memberNames.delete(key)
      if (this.#memberNames.size <= MAX_MEMBER_NAMES / 2) break
    }
  }

  /** 这个组合刚查过、还没到重试时间 */
  #missed(key) {
    const at = this.#memberMiss.get(key)
    if (at == null) return false
    if (Date.now() - at >= MEMBER_MISS_TTL) {
      this.#memberMiss.delete(key)
      return false
    }
    return true
  }

  #markMissed(key) {
    this.#memberMiss.set(key, Date.now())
  }

  /**
   * 去适配器问这一批人的群名片。
   *
   * 两档：先要整个群的成员列表（多数适配器都实现了，一次问全，之后就都命中缓存了），
   * 没这个能力才逐个查。同一个群有冷却，取不到时不至于每条带 @ 的消息都去拉一次。
   */
  async #fillMemberNames(groupId, botId, uins) {
    const group = this.#pick('group', groupId, botId)
    const fetched = this.#memberFetched.get(groupId) ?? 0

    // 冷却期内不再问列表接口，直接让下面逐个查的那档去顶着
    if (group && Date.now() - fetched >= MEMBER_FETCH_COOLDOWN) {
      this.#memberFetched.set(groupId, Date.now())
      try {
        if (typeof group.getMemberMap !== 'function') throw new Error('适配器不支持取群成员列表')
        const got = await group.getMemberMap()
        this.#cacheMembers(groupId, got instanceof Map ? got.values() : got)
      } catch (err) {
        // 协议端没实现这个接口是常事，不是用户操作失败，日志记一条就够了
        logger.debug(`[Guoba][消息记录] 取群 ${groupId} 成员列表失败：${err?.message ?? err}`)
      }
    }

    for (const uin of uins) {
      const key = `${groupId}:${uin}`
      if (this.#memberNames.has(key) || this.#missed(key)) continue
      if (typeof group?.pickMember !== 'function') continue
      try {
        const member = group.pickMember(uin)
        const info = typeof member?.getInfo === 'function' ? await member.getInfo()
          : typeof member?.getGroupMemberInfo === 'function' ? await member.getGroupMemberInfo()
            : member?.info
        const name = String(info?.card || info?.nickname || info?.name || '').trim()
        if (name) this.#memberNames.set(key, name)
        else this.#markMissed(key)
      } catch {
        // 查不到先记一笔，隔一阵再试 —— 适配器的成员列表本身是异步填的，
        // 第一次问可能还没有，判成永久查不到就再也补不上了
        this.#markMissed(key)
      }
    }
    this.#trimMembers()
  }

  /** 记一份 QQ -> 昵称，给「同一个人在别处发过言」兜底。满了挤掉最老的一半 */
  #rememberName(uin, name) {
    const id = String(uin ?? '')
    if (!id || !name) return
    this.#names.set(id, String(name))
    if (this.#names.size <= MAX_SENDER_NAMES) return
    for (const key of this.#names.keys()) {
      this.#names.delete(key)
      if (this.#names.size <= MAX_SENDER_NAMES / 2) break
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
  async listSessions({type = 'group', botId = '', keyword = '', pageNo = 1, pageSize = 30} = {}) {
    const isGroup = type !== 'friend'
    // 适配器连接时那次拉取可能没成功，缓存空着就先补一次，见 ensureContacts
    await ensureContacts(isGroup ? 'group' : 'friend', botId)
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
      // 关键词只匹配真名与号码，不匹配备注 —— 备注是用户自己起的别名，
      // 拿它参与搜索会让「按群名找群」变成「按我起的名字找群」，反而找不着
      if (kw && !name.toLowerCase().includes(kw) && !sid.includes(kw)) continue
      const key = sessionKey(owner, isGroup ? 'group' : 'friend', sid)
      const active = this.#sessions.get(key)
      list.push({
        key,
        botId: owner,
        type: isGroup ? 'group' : 'friend',
        id: sid,
        name,
        // 群备注（用户自己起的别名）。前端显示时优先用它，真名放 title ——
        // QQBot-Web-Adapter 也是「优先备注，其次真名」，否则备注就没意义了
        note: getNote(key),
        // 头像地址按适配器算，QQBot 的 openid 前端拼不出来（见 model/avatar.js）
        avatar: isGroup
          ? groupAvatarUrl(sid, info?.avatar)
          : userAvatarUrl(sid, owner, info?.avatar),
        lastTime: active?.lastTime ?? 0,
        lastText: active?.lastText ?? '',
        unread: active?.unread ?? 0,
        // 置顶与黑名单是面板自己的状态（见 model/chatPrefs.js），列表里带上让前端能标记
        pinned: isPinned(key),
        blacklisted: isBlacklisted(key),
      })
    }

    /**
     * 私聊列表补上「临时会话」。
     *
     * 好友表（`bot.fl`）里只有加过好友的人，群临时会话 / 陌生人私聊根本不在里面。
     * 收到过的会落进 chatTempSessions 的 JSON（内存活跃表只在本进程里有效，重启就没了），
     * 这里把「持久化的 + 本进程刚收到的」合起来，再滤掉已经是好友的，前端标一个「临时」。
     */
    if (!isGroup) {
      const tempMap = new Map()
      for (const item of listTempSessions(wantBot)) tempMap.set(item.key, {...item})
      for (const [activeKey, active] of this.#sessions) {
        const matched = /^([^:]+):friend:(.+)$/.exec(activeKey)
        if (!matched) continue
        if (wantBot && matched[1] !== wantBot) continue
        const old = tempMap.get(activeKey)
        tempMap.set(activeKey, {
          key: activeKey,
          botId: matched[1],
          userId: matched[2],
          name: old?.name || this.#names.get(matched[2]) || matched[2],
          lastTime: active.lastTime,
          lastText: active.lastText,
          unread: active.unread,
        })
      }
      for (const [activeKey, item] of tempMap) {
        const sid = String(item.userId ?? '')
        if (!sid) continue
        // 已经是好友的交给上面的好友表那一路，这里不重复
        if (map.has(Number(sid)) || map.has(sid)) continue
        const name = item.name || this.#names.get(sid) || sid
        if (kw && !name.toLowerCase().includes(kw) && !sid.includes(kw)) continue
        list.push({
          key: activeKey,
          botId: item.botId,
          type: 'friend',
          id: sid,
          name,
          note: getNote(activeKey),
          avatar: userAvatarUrl(sid, item.botId),
          lastTime: item.lastTime ?? 0,
          lastText: item.lastText ?? '',
          unread: item.unread ?? 0,
          pinned: isPinned(activeKey),
          blacklisted: isBlacklisted(activeKey),
          temp: true,
        })
      }
    }

    // 置顶的排最前（且不受有没有消息影响），其余按最近活跃，最后按号码 —— 顺序稳定不跳动
    list.sort((a, b) =>
      (Number(b.pinned) - Number(a.pinned))
      || (b.lastTime - a.lastTime)
      || a.id.localeCompare(b.id))

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
   * 两条路：OneBot 系走适配器的 `getChatHistory`（QQ 服务端记录），QQBot 系走 Redis
   * （QQBot-Plugin 落的那份）。都没有就如实返回 `supported: false`，前端会退而显示
   * 面板运行期间收到的消息。
   *
   * @param seq   翻页游标，传本地最早一条的 messageSeq；0 或空取最新
   * @param count 条数
   */
  async getHistory({botId, type, id, seq = 0, count = HISTORY_COUNT} = {}) {
    const target = this.#pick(type, id, botId)
    const cursor = this.#seq - 1
    if (typeof target?.getChatHistory !== 'function') {
      const viaRedis = await this.#historyViaRedis({botId, type, id, seq, count})
      if (viaRedis) return {...viaRedis, cursor}
      /**
       * 非 OneBot 适配器多半没有这能力，前端据此提示「只能看面板运行期间的消息」。
       * QQBot 另说一句 —— 它有落库的那份记录，读不到多半是存储后端或保存期限的问题，
       * 泛泛地讲「适配器不支持」会把人带到错的方向上。
       */
      const note = isQQBot(this.#bot(botId))
        ? '这是 QQ 官方机器人，历史消息由 QQBot-Plugin (风佬) 提供，当前没读到记录。'
        + '请确认消息存储设置消息记录开关已开启且存储后端是redis，'
        : ''
      return {supported: false, messages: [], hasMore: false, cursor, note}
    }

    const num = Math.min(Math.max(Number(count) || HISTORY_COUNT, 1), MAX_HISTORY_COUNT)
    // message_seq 是数字或字符串，视实现而定，能转数字就转
    const from = seq === 0 || seq === '' || seq == null ? 0 : (Number(seq) || seq)
    const api = type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
    let raw
    try {
      raw = await target.getChatHistory(from, num)
    } catch (err) {
      logger.error(`[Guoba][消息记录] ${api} 失败（${type} ${id}）：${err?.stack ?? err}`)
      /**
       * 按「不支持」返回，而不是抛出去。
       *
       * 协议端这个接口用不了是它的能力问题，不是用户操作失败 —— 抛出去会在页面上弹一个红色
       * 报错，而走这条路前端会显示既有的那句说明，并自动拿实时缓冲里的消息填上（见
       * `fillFromBuffer`），至少还看得到面板运行期间的消息。
       */
      const note = `协议端取不到这个会话的历史消息（${api} 内部报错：${err?.message ?? err}）。`
        + '这是协议端自己的问题，锅巴和云崽都改不了；下面显示的是面板运行期间收到的消息。'
      const fail = {supported: false, messages: [], hasMore: false, cursor, note}
      const retryKey = `${botId}:${type}:${id}`
      // 试过一次不带 message_seq 也没用的会话，别每次打开都再白发一遍请求
      if (this.#noRetryHistory.has(retryKey)) return fail
      /**
       * 适配器**总会**带上 `message_seq`，取最新时那个值是 0 —— 而有的协议端只处理了「不带这个
       * 参数」的情形。所以自己再发一次，取最新时把这个参数整个省掉。
       *
       * 实测对 LLOneBot v8.1.8 没用：它在
       * `onebot11/action/llbot/msg/GetFriendMsgHistory.ts:75` 抛
       * `Cannot read properties of undefined (reading 'start')`，带不带 message_seq 都一样，
       * 所以那不是参数的问题。留着这一手是给别的协议端用的。
       */
      try {
        raw = await this.#historyViaApi({botId, type, id, count: num, seq: from})
        logger.mark(`[Guoba][消息记录] ${api} 改为不带 message_seq 重试后成功（${type} ${id}）`)
      } catch (retryErr) {
        this.#noRetryHistory.add(retryKey)
        logger.debug(`[Guoba][消息记录] 不带 message_seq 重试也失败：${retryErr?.message ?? retryErr}`)
        return fail
      }
    }

    const list = (Array.isArray(raw) ? raw : [raw]).filter((it) => it && typeof it === 'object')
    const key = `${botId}:${type === 'group' ? 'group' : 'friend'}:${id}`
    const messages = []
    for (const item of list) {
      const userId = String(item.user_id ?? item.sender?.user_id ?? '')
      const messageId = item.message_id != null ? String(item.message_id) : ''
      messages.push({
        key,
        botId: String(botId ?? ''),
        type: type === 'group' ? 'group' : 'friend',
        id: String(id ?? ''),
        messageId,
        messageSeq: this.#seqOf(item),
        time: Number(item.time) || 0,
        self: userId === String(botId ?? ''),
        sender: this.#sender(item.sender, userId, botId),
        segments: await normalizeMsg(item.message ?? item.content, this.#msgOpts(botId)),
      })
      // 历史接口没有上报原文，只能拿返回的条目本身；已经有实时那份的不覆盖
      if (messageId) {
        this.#storeRaw(messageId, {
          array: this.#dump(item.message ?? item.content),
          raw: this.#dump(item),
          pbElem: this.#pickPb(PB_ELEM_KEYS, item),
          pbRaw: this.#pickPb(PB_RAW_KEYS, item),
        }, {overwrite: false})
      }
    }
    // 各实现返回的顺序不一致，自己排一遍（旧 → 新）
    messages.sort((a, b) => (a.time - b.time) || String(a.messageSeq).localeCompare(String(b.messageSeq)))
    for (const msg of messages) await this.#resolveNames(msg.segments, {botId, type, id})

    return {
      supported: true,
      messages,
      /** 拿满了就认为还有更早的，前端继续往上翻 */
      hasMore: messages.length >= num,
      // 顺带把基线游标给前端，省一次请求；从这里开始轮询增量
      cursor,
    }
  }

  /* ---------------- QQBot：从 Redis 读历史 ---------------- */

  /**
   * 从 Redis 里读 QQBot 的历史消息。
   *
   * 存储后端设成 redis 时，QQBot-Plugin 会把每条消息写进
   * `wind-msg:*` / `wind-bot-msg:*` 两个 ZSET（键名见 model/qqRedisStore.js）。这里
   * 把它们取出来、按面板的结构还原，好让消息记录页跟 OneBot 系一样能往上翻历史。
   *
   * @return {Promise<{supported: true, messages: object[], hasMore: boolean}|null>}
   *   null 表示没有可用数据（不是 QQBot、Redis 没接上、或这个会话压根没有记录），
   *   由调用方回退到「只能看面板运行期间的消息」。
   */
  async #historyViaRedis({botId, type, id, seq, count}) {
    const client = getRedisClient()
    if (!client) return null
    // 只对 QQBot 会话走这条路：别的适配器没有这套键，白查一遍还容易误读
    if (!isQQBot(this.#bot(botId))) return null
    const keys = qqRedisKeys(type, id)
    if (!keys.length) return null

    const want = Math.min(Math.max(Number(count) || HISTORY_COUNT, 1), MAX_HISTORY_COUNT)
    const cursor = decodeRedisCursor(seq)
    const {items, hasMore} = await readRedisPage(client, keys, cursor, want)
    // 首屏（没有游标）就一条都没读到 —— 这个会话确实没有记录，交给上层回退
    if (!items.length && !cursor) return null

    const key = `${botId}:${type === 'group' ? 'group' : 'friend'}:${id}`
    const messages = []
    for (const {item, ts, ordinal} of items) {
      messages.push(await this.#fromRedisItem(item, {
        botId, type, id, key,
        // 翻页游标就是这条的「时间戳 + 同秒序号」，前端原样回传
        messageSeq: encodeRedisCursor(ts, ordinal),
      }))
    }
    // readPage 给的是「新 → 旧」，页面要「旧 → 新」
    messages.reverse()
    /**
     * 补 @ 段昵称，顺手把段里的直链记进代理白名单（rkey 过期时要靠它代拉）。
     *
     * `#resolveNames` 是两段式的：缓存里有就直接填，没有就先去适配器要一次成员列表 ——
     * 也就是说**冷启动那一趟填不上名字，得再走一遍**。实时那条路上 `#onMessage` 与
     * `#push` 会各跑一次，正好把这两段覆盖掉；这里只有一次机会，所以自己补一趟。
     */
    for (const msg of messages) await this.#resolveNames(msg.segments, {botId, type, id})
    for (const msg of messages) await this.#resolveNames(msg.segments, {botId, type, id})

    return {supported: true, messages, hasMore}
  }

  /**
   * 把 Redis 里存的那条 QQBot 记录转成面板的消息结构。
   *
   * 字段与 QQBot-Plugin/lib/message.js 写入时一一对应；段数组的形态跟 OneBot 那套一样
   * （`{type, ...}` 平铺），所以直接交给 normalizeMsg 就行。
   */
  async #fromRedisItem(item, {botId, type, id, key, messageSeq}) {
    const userId = String(item.user_id ?? '')
    const messageId = item.message_id != null && item.message_id !== '' ? String(item.message_id) : ''
    const rawSender = item.sender && typeof item.sender === 'object' ? item.sender : {}
    /**
     * 群通知（入群 / 退群 / 机器人被拉入踢出）跟普通消息同存一个 ZSET，只有 is_notice
     * 标记不同。面板没有「通知」这种段，压成一行系统文案当文本发出去。
     */
    const segments = item.is_notice
      ? [{type: 'text', text: noticeText(item)}]
      : await normalizeMsg(item.message ?? item.content, this.#msgOpts(botId, {
        botMarkdown: item.is_bot === true && item.me !== true,
      }))

    const message = {
      key,
      botId: String(botId ?? ''),
      type: type === 'group' ? 'group' : 'friend',
      id: String(id ?? ''),
      messageId,
      eventId: String(item.event_id ?? ''),
      messageSeq,
      time: Number(item.timestamp) || 0,
      /**
       * 是不是机器人自己发的。
       *
       * 不能拿 `userId === botId` 判 —— QQBot 的 user_id 是 `${selfId}:${openid}` 这种
       * 复合形式，永远等于不了 botId。写入侧对机器人自己的消息打了 `me` 标记，认它。
       */
      self: item.me === true,
      recalled: !!item.recalled,
      // 昵称 / 头像写入侧单独存了一份，sender 里那份可能缺，这里合并着取
      sender: this.#sender({
        ...rawSender,
        user_id: userId || rawSender.user_id,
        nickname: item.nickname || rawSender.nickname,
        avatar: item.avatar || rawSender.avatar,
      }, userId, botId, item.me === true),
      segments,
    }
    // Redis 里这条就是最原始的一份，留给「查看原始消息」的 msg raw 档
    if (messageId) {
      this.#storeRaw(messageId, {
        array: this.#dump(item.message),
        raw: this.#dump(item),
        pbElem: '',
        pbRaw: '',
      }, {overwrite: false})
    }
    return message
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
        segments: await normalizeMsg(content, this.#msgOpts(botId)),
      })
    }
    for (const node of nodes) await this.#resolveNames(node.segments, {botId, type, id})
    return {nodes}
  }

  /** 取一份自己发出去的图片，供 /chat/asset/:id 回传 */
  getAsset(assetId) {
    const asset = this.#assets.get(assetId)
    if (!asset) throw new GuobaError('资源不存在或已过期')
    return asset
  }

  /** 按 id 取内存里的那条消息（收藏表情要按段取字节） */
  getBuffered(messageId) {
    return this.#index.get(String(messageId ?? '')) ?? null
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
   * @param images  图片，元素为 dataURL 或 base64（小图兼容用，大图走 files）
   * @param files   multipart 上传上来的文件，元素为 `{buffer}` 或 `{path}`
   * @param ats     要 @ 的 QQ 号，拼在最前面
   * @param replyTo 引用哪条消息的 message_id（QQ 上显示成一条引用）
   * @param replyMsgId   被动回复用的 msg_id，见下方 source
   * @param replyEventId 被动回复用的 event_id，见下方 source
   * @param kind    消息类型：legacy（普通，默认）/ markdown / ark / media（富媒体）。
   *                后三种只有 QQ 官方机器人（QQBot-Plugin）认得，面板只在 QQBot 会话下给。
   * @param ark     kind=ark 时的参数，JSON 字符串 `{template_id, kv}`
   * @param faces   QQ 自带表情的 face id 数组，元素可以是数字或数字字符串
   * @param emojis  收藏 / 自定义表情，元素为 `{kind: 'fav', url}` 或 `{kind: 'custom', id}`
   */
  async send({
    botId, type, id, text = '', images = [], files = [], ats = [],
    replyTo = '', replyMsgId = '', replyEventId = '', kind = 'legacy', ark = '',
    faces = [], emojis = [],
  } = {}) {
    const msg = []
    if (replyTo) msg.push({type: 'reply', id: String(replyTo)})
    /**
     * 被动回复。
     */
    const source = replyMsgId || replyEventId
      ? {
        ...(replyMsgId ? {id: String(replyMsgId)} : {}),
        ...(replyEventId ? {event_id: String(replyEventId)} : {}),
      }
      : null

    /* ---- QQBot 的三种专属类型：段结构跟普通档差得远，单独走 ---- */

    if (kind === 'markdown') {
      const md = typeof text === 'string' ? text.trim() : ''
      if (!md) throw new GuobaError('Markdown 内容不能为空')
      msg.push({type: 'markdown', data: md})
      return this.#sendMsg({botId, type, id, msg, source})
    }

    if (kind === 'ark') {
      msg.push(this.#buildArkSeg(ark))
      return this.#sendMsg({botId, type, id, msg, source})
    }

    if (kind === 'media') {
      const uploads = this.#toArray(files)
      if (!uploads.length) throw new GuobaError('富媒体要选一个文件')
      for (const file of uploads.slice(0, MAX_SEND_IMAGES)) {
        const buffer = await this.#readUpload(file, MAX_SEND_MEDIA_SIZE)
        if (buffer?.length) msg.push({type: mediaSegType(file), file: buffer})
      }
      if (!msg.some((i) => i.type !== 'reply')) throw new GuobaError('没有读到可发送的文件')
      return this.#sendMsg({botId, type, id, msg, source})
    }

    /* ---- 普通档 ---- */

    for (const item of this.#toArray(this.#parseAts(ats)).slice(0, MAX_SEND_ATS)) {
      // ats 可能是字符串/数字，也可能带 name 的对象（前端 @ 时一起传的）
      const uin = String(item && typeof item === 'object' ? item.qq : item ?? '').trim()
      const atName = item && typeof item === 'object' && item.name ? String(item.name) : ''
      if (uin) msg.push({type: 'at', qq: uin, ...(atName ? {name: atName} : {})})
    }
    /**
     * 表情：QQ 自带的发 face 段；收藏 / 自定义表情是图片，带上 sub_type=1，
     * 客户端才会按表情包渲染（不然就是一张能点开放大的普通图片）。
     */
    const faceIds = this.#parseFlatList(faces)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id >= 0)
      .slice(0, MAX_SEND_EMOJIS)
    for (const fid of faceIds) msg.push({type: 'face', id: fid})
    const emojiItems = this.#parseFlatList(emojis)
      .filter((item) => item && typeof item === 'object')
      .slice(0, MAX_SEND_EMOJIS)
    for (const item of emojiItems) {
      const buffer = await this.chatEmojiService.resolveForSend(item)
      // sub_type 是 OneBot 的字段，asface 是 ICQQ 的；各实现只认自己那个，多的会被忽略
      if (buffer?.length) msg.push({type: 'image', file: buffer, sub_type: 1, asface: true})
    }
    /**
     * 图片优先用 multipart 上来的字节。
     *
     * 共享 TRSS 端口时 body 解析器是宿主的 `express.json()`（默认 100kb 上限），
     * 一张图 base64 塞进 JSON 就 413 了，所以正常路径走 multipart。
     */
    const uploads = this.#toArray(files).slice(0, MAX_SEND_IMAGES)
    // 被 @ 的人和后面的内容之间补一个空格，QQ 客户端里不然会「@张三文字」贴在一起
    if (msg.some((i) => i.type === 'at')
      && (uploads.length || this.#toArray(images).length || faceIds.length || emojiItems.length || text)) {
      msg.push({type: 'text', text: ' '})
    }
    for (const file of uploads) {
      const buffer = await this.#readUpload(file)
      if (buffer?.length) msg.push({type: 'image', file: buffer})
    }
    const left = MAX_SEND_IMAGES - uploads.length
    for (const img of this.#toArray(images).slice(0, Math.max(left, 0))) {
      const file = toBase64File(img)
      if (file) msg.push({type: 'image', file})
    }
    const str = typeof text === 'string' ? text : ''
    if (str) msg.push({type: 'text', text: str})
    // 只有引用段等于没内容，QQ 那边会发失败
    if (!msg.some((i) => i.type !== 'reply')) {
      throw new GuobaError('消息内容不能为空')
    }
    return this.#sendMsg({botId, type, id, msg, source})
  }

  #toArray(v) {
    if (Array.isArray(v)) return v
    return v == null || v === '' ? [] : [v]
  }

  /**
   * multipart 表单里的数组字段是 JSON 文本，JSON body 里已经是数组，两种都收。
   * 解析不出来就当没传，别为了一条表情把整条消息打回去。
   */
  #parseFlatList(v) {
    if (Array.isArray(v)) return v
    if (typeof v !== 'string') return v == null || v === '' ? [] : [v]
    const t = v.trim()
    if (!t) return []
    try {
      const p = JSON.parse(t)
      return Array.isArray(p) ? p : [p]
    } catch {
      return []
    }
  }

  /**
   * ats 从 multipart 表单字段来的时候是 JSON 字符串（`["123","456"]`），
   * 走 JSON body 的时候是数组，两种都要收。解析失败就按逗号分隔兜底。
   */
  #parseAts(ats) {
    if (typeof ats !== 'string') return ats
    const t = ats.trim()
    if (!t) return []
    try {
      const p = JSON.parse(t)
      return Array.isArray(p) ? p : [p]
    } catch {
      return t.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }

  /**
   * Ark 卡片段。
   */
  #buildArkSeg(ark) {
    let parsed
    try {
      parsed = typeof ark === 'string' ? JSON.parse(ark) : ark
    } catch (err) {
      throw new GuobaError(`Ark 参数不是合法 JSON：${err?.message ?? err}`)
    }
    const templateId = Number(parsed?.template_id)
    if (!Number.isFinite(templateId) || templateId <= 0) {
      throw new GuobaError('Ark 模板不能为空')
    }
    const kv = this.#toArray(parsed?.kv)
      .map((i) => ({key: String(i?.key ?? '').trim(), value: String(i?.value ?? '').trim()}))
      .filter((i) => i.key && i.value)
    if (!kv.length) {
      throw new GuobaError('Ark 至少要填一个字段')
    }
    return {type: 'ark', template_id: templateId, kv}
  }

  /**
   * 取上传文件的字节。
   *
   * 锅巴全局挂的 multer 是落盘的（`data/upload_tmp/`），读完就删 —— 文件已经进
   * 消息段了，临时文件留着只是占地方。
   *
   * @param maxSize 这个文件的大小上限，默认按图片算
   */
  async #readUpload(file, maxSize = MAX_SEND_IMAGE_SIZE) {
    if (Buffer.isBuffer(file?.buffer)) return file.buffer
    const src = file?.path
    if (!src) return null
    try {
      const buffer = await fs.readFile(src)
      if (buffer.length > maxSize) {
        const mb = Math.round(maxSize / 1024 / 1024)
        throw new GuobaError(`文件过大（单个上限 ${mb}MB）`)
      }
      return buffer
    } finally {
      fs.unlink(src).catch(() => {})
    }
  }

  /**
   * 戳一戳。
   *
   * OneBot v11 协议里没有标准 poke 动作，各家实现的叫法不一样：
   * NapCat 是 `send_poke`，Lagrange 是 `set_poke`，llob 是 `poke` / `send_group_poke`。
   * 直接走适配器底层的 `sendApi` 逐个试，谁认用谁，就不用为每种实现各写一套了。
   */
  async poke({botId, type, id, userId = ''} = {}) {
    const uin = String(userId ?? '').trim()
    if (!uin) throw new GuobaError('缺少要戳的用户')
    const owner = (botId && Bot.bots?.[Number(botId) || botId]) || Bot
    if (typeof owner?.sendApi !== 'function') {
      throw new GuobaError('当前适配器不支持戳一戳')
    }
    // 群戳带 group_id + user_id，私聊戳只带 user_id（各家参数的键名也不统一，一起给上）
    const params = type === 'group'
      ? {group_id: Number(id) || id, user_id: Number(uin) || uin}
      : {user_id: Number(uin) || uin}
    const actions = POKE_ACTIONS
    for (const action of actions) {
      try {
        const ret = await owner.sendApi(action, params)
        // sendApi 对不认的动作一般直接抛错，个别实现把错误塞在返回里，也当没成功
        const code = ret?.retcode ?? ret?.code ?? 0
        if (code !== 0 && code !== 1) continue
        return {ok: true, action}
      } catch {
        // 这个动作名不认，换下一个
      }
    }
    throw new GuobaError('戳一戳失败：适配器不认这些动作（NapCat 需开启对应扩展动作）')
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
  async #sendMsg({botId, type, id, msg, source = null}) {
    let res
    /**
     * QQBot 一律自己拼 data 直发，不走 `pickGroup().sendMsg`。
     */
    if (isQQBot(this.#bot(botId))) {
      res = await this.#sendWithSource({botId, type, id, msg, source})
    } else {
      const target = this.#pick(type, id, botId)
      if (typeof target?.sendMsg !== 'function') {
        throw new GuobaError(`未找到可用的发送对象：${id}`)
      }
      try {
        res = await target.sendMsg(msg)
      } catch (err) {
        // 适配器原文是给开发者看的（整条 URL + 错误码），翻成人话再抛给面板
        logger.error(`[Guoba] 面板发送消息失败：${err?.message ?? err}`)
        throw new GuobaError(describeSendError(err))
      }
    }

    /**
     * QQBot-Plugin 的 `sendMsg` **从不抛错**：它把每条的失败收在 `rets.error` 里，
     * 最后返回 `{message_id: [], data: [], error: [...]}`（见它的 adapter/send.js）。
     * 不认这个形状的话，面板会把失败当成功 —— 消息根本没出去，界面却本地补了一条回显，
     * 用户看不出任何异常。这里把这种返回翻成异常。
     */
    const botErrors = Array.isArray(res?.error) ? res.error.filter(Boolean) : []
    if (botErrors.length) {
      const detail = botErrors.map((e) => e?.message ?? e).join(' | ')
      logger.error(`[Guoba] 面板发送消息失败：${detail}`)
      // 多段消息可能只挂了一部分，说清楚免得用户以为全没发出去
      const partial = Array.isArray(res.message_id) && res.message_id.length ? '（部分消息已发出）' : ''
      throw new GuobaError(describeSendError(botErrors[0]) + partial)
    }

    // QQBot 的 message_id 是数组（一次发多段），OneBot 是单值，两种都要认
    const rawId = Array.isArray(res?.message_id) ? res.message_id[0] : res?.message_id
    const messageId = rawId != null && rawId !== '' ? String(rawId) : ''
    const self = String(botId ?? '')
    const bot = Bot.bots?.[self]
    /**
     * bot 自己发的消息不一定会有 message 事件（要协议端开了自身消息上报才有），
     * 所以在这儿主动补一条；真来了事件也会按 messageId 去重，不会重复。
     * 这条要读盘 —— 刚发的图是 base64，不留一份字节页面上就显示不出来。
     */
    const pushed = await this.#push({
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
        title: '',
      },
      segments: await normalizeMsg(msg, {assets: this.#assets}),
    }, {remember: false})

    return {messageId, message: pushed, cursor: this.#seq - 1}
  }

  /**
   * 直接调 QQBot 适配器发送（普通发送与被动回复共用这一条）。
   */
  async #sendWithSource({botId, type, id, msg, source = null}) {
    const bot = this.#bot(botId)
    if (!isQQBot(bot)) {
      throw new GuobaError('当前适配器不支持被动回复（msg_id / event_id 回复是 QQ 官方机器人专有）')
    }
    const group = type === 'group'
    const send = group ? bot.adapter?.sendGroupMsg : bot.adapter?.sendFriendMsg
    if (typeof send !== 'function') {
      throw new GuobaError('当前适配器不支持被动回复')
    }
    const data = {
      self_id: String(botId ?? ''),
      bot,
      [group ? 'group_id' : 'user_id']: pureOpenid(id),
      platform: group ? 'QQ-group' : 'QQ-private',
      legacy: this.#isLegacyMsg(msg),
    }
    try {
      return await send.call(bot.adapter, data, msg, source ?? undefined)
    } catch (err) {
      logger.error(`[Guoba] 面板发送消息失败：${err?.message ?? err}`)
      throw new GuobaError(describeSendError(err))
    }
  }

  /**
   * 这条消息该不该按「普通文本」发（= QQBot 的 `data.legacy`）。
   */
  #isLegacyMsg(msg) {
    const md = new Set(['markdown', 'ark', 'at'])
    return !this.#toArray(msg).some((seg) => md.has(seg?.type))
  }

  /**
   * 复读：把缓冲里那条消息按段原样再发一遍。
   *
   * 不能只拿文本拼 —— 图片/表情只发文字占位就没意义了。这里按段类型重建：
   * 图片优先用回显时存的字节（assetId），没有就用直链；表情直接带 id。
   * reply / button / markdown / node 这类没法原样重发，跳过。
   */
  async resend({botId, type, id, messageId} = {}) {
    if (!messageId) throw new GuobaError('缺少消息 id')
    const msg = this.#index.get(String(messageId))
    if (!msg) throw new GuobaError('这条消息不在内存里，无法复读')
    const segs = this.#toSendSegs(msg.segments)
    if (!segs.length) throw new GuobaError('这条消息没有可复读的内容（图片资源可能已过期）')
    return this.#sendMsg({botId, type, id, msg: segs})
  }

  /** 缓冲段转回可发送的 OneBot 段，能原样重发的才收 */
  #toSendSegs(segments) {
    const out = []
    for (const seg of segments ?? []) {
      if (seg.type === 'text' && seg.text) {
        out.push({type: 'text', text: seg.text})
      } else if (seg.type === 'at' && seg.qq) {
        out.push({type: 'at', qq: String(seg.qq)})
      } else if (seg.type === 'face' && seg.id != null) {
        out.push({type: 'face', id: Number(seg.id)})
      } else if (seg.type === 'image') {
        // 优先用回显时留的字节（自己发的图），没有就退回直链（收到的图，rkey 可能已过期）
        const asset = seg.assetId ? this.#assets.get(seg.assetId) : null
        // 表情包复读还得是表情包：sub_type 给 OneBot、asface 给 ICQQ
        const sticker = seg.subType === 1 ? {sub_type: 1, asface: true} : {}
        if (asset?.buffer) out.push({type: 'image', file: asset.buffer, name: seg.name, ...sticker})
        else if (seg.url) out.push({type: 'image', file: seg.url, ...sticker})
      } else if ((seg.type === 'record' || seg.type === 'video' || seg.type === 'file') && seg.url) {
        out.push({type: seg.type, file: seg.url, name: seg.name})
      }
      // reply / button / markdown / node 复读不了，跳过
    }
    return out
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
      if (item === false) {
        throw new GuobaError('撤回失败：适配器没接受这条撤回（多半是没有权限，或超过了两分钟时限）')
      }
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

  /* ---------------- 群信息 / 置顶 / 拉黑 ---------------- */

  /**
   * 群信息。
   *
   * 两路数据拼起来：
   * - **面板记录**：适配器连接时给的那份全量群列表（`bot.gl`），随时都在，字段少；
   * - **适配器现取**：`get_group_info` 系列动作，字段全但慢，还可能失败
   *   （协议端没这个动作、群号对不上、QQBot 拿不到群详情）。
   *
   * 弹窗上「群人数（记录 / 实际）」两栏就是这两路：记录是前者，实际是后者。
   * 现取失败不报错，如实把原因（liveError）带回去让前端说明 —— 只有记录那一栏也够用。
   *
   * @param refresh 跳过现取的缓存，强制问一次适配器（右键「刷新群信息」走这条）
   */
  async groupInfo({botId = '', id = '', refresh = false} = {}) {
    const gid = String(id ?? '').trim()
    if (!gid) throw new GuobaError('缺少群号')
    const owner = String(botId ?? '').trim()
    const bot = this.#bot(owner)
    const key = sessionKey(owner, 'group', gid)
    const entry = this.#groupEntry(gid)
    const qqbot = isQQBot(bot)

    let live = null
    let liveAt = 0
    let liveError = ''
    const hit = this.#groupLiveCache.get(key)
    if (!refresh && hit && Date.now() - hit.at < GROUP_LIVE_TTL) {
      live = hit.data
      liveAt = hit.at
    } else if (qqbot && typeof this.#qqbotSdk(bot)?.getGroupInfo !== 'function') {
      // QQ 官方机器人没有 sendApi，它走 SDK；SDK 都没接上就没得现取
      liveError = '当前 QQ 机器人没接上 SDK，取不到实时的群信息'
    } else if (!qqbot && typeof bot?.sendApi !== 'function') {
      liveError = '当前适配器没有 sendApi，取不到实时的群信息'
    } else {
      try {
        live = qqbot
          ? await this.#fetchQQBotGroupInfo(bot, gid)
          : await this.#fetchGroupInfo(bot, gid, refresh)
        liveAt = Date.now()
        this.#groupLiveCache.set(key, {at: liveAt, data: live})
        // 名字 / 人数回填进适配器的群缓存，左侧列表跟着一起更新
        this.#applyGroupInfo(bot, gid, live)
      } catch (err) {
        liveError = err?.message ?? String(err)
      }
    }

    /**
     * 面板记录的那份（`bot.gl`）也要按各家键名读。
     *
     * QQBot 的 `gl` 里根本没有 `member_count`，它叫 `group_member_num`；
     * 早先这里写死了 `entry.member_count`，于是 QQBot 的「记录」一栏永远是空。
     */
    const recorded = entry && typeof entry === 'object' ? entry : null

    return {
      key,
      botId: owner,
      id: gid,
      /** 前端拿它区分这是群卡还是用户卡（两张卡共用一份缓存） */
      type: 'group',
      name:
        textOf(live, GROUP_INFO_FIELDS.name) ||
        textOf(recorded, GROUP_INFO_FIELDS.name) ||
        gid,
      avatar: groupAvatarUrl(gid, entry?.avatar),
      // QQBot 的群 id 是 `${selfId}:${groupOpenid}` 复合形式，面板上单独给一栏看真身
      openid: pureOpenid(gid),
      /** 面板记录的群人数（现取不到时这一栏是唯一的参考） */
      recordedMemberCount: numOf(recorded, GROUP_INFO_FIELDS.memberCount),
      /** 适配器现取的群人数，取不到是 0 */
      liveMemberCount: numOf(live, GROUP_INFO_FIELDS.memberCount),
      maxMemberCount:
        numOf(live, GROUP_INFO_FIELDS.maxMemberCount) ||
        numOf(recorded, GROUP_INFO_FIELDS.maxMemberCount),
      /**
       * 群备注是**面板自己记的**（右键菜单「备注」里填），不来自适配器 ——
       * QQBot-Web-Adapter 也是这么做的。OneBot 系顺手把适配器给的群备注当兜底。
       */
      remark: getNote(key) || textOf(live, GROUP_INFO_FIELDS.remark),
      /** 适配器没给现取数据时，退回面板记录那份，别让卡片空着 */
      intro: textOf(live, GROUP_INFO_FIELDS.intro) || textOf(recorded, GROUP_INFO_FIELDS.intro),
      category:
        textOf(live, GROUP_INFO_FIELDS.category) || textOf(recorded, GROUP_INFO_FIELDS.category),
      /** 群标签，只有 QQ 官方机器人有 */
      tags: tagsOf(live).length ? tagsOf(live) : tagsOf(recorded),
      /** 现取失败的原因，空串表示这次拿到的是实时数据 */
      liveError,
      /** 现取的时间戳（秒），前端显示「刚刚更新」用 */
      refreshedAt: liveAt ? Math.floor(liveAt / 1000) : 0,
      pinned: isPinned(key),
      blacklisted: isBlacklisted(key),
    }
  }

  /** 刷新群信息：数据跟 {@link groupInfo} 完全一样，只是跳过缓存、强制问一次适配器 */
  async refreshGroupInfo({botId = '', id = ''} = {}) {
    return this.groupInfo({botId, id, refresh: true})
  }

  /**
   * 用户信息：私聊那边点头像弹出的那张卡。
   *
   * 结构与 {@link groupInfo} 对称，两路数据：
   * - **面板记录**：适配器连接时那份好友列表（`bot.fl`）里的一条，随时都在；
   * - **适配器现取**：OneBot 系的 `get_friend_info` / `get_stranger_info`。
   *
   * QQ 官方机器人这边**刻意不现取**：SDK 上根本没有好友信息接口
   * （它只有 getSelfInfo / getGroupMemberInfo / getGroupBotInfo，见 QQBot-Plugin 的用法），
   * 注定取不到的东西还每次都报一句「取不到」只是噪音。`fl` 里那份（昵称、openid、
   * unionid）就是能拿到的全部，卡片上有什么显示什么，`liveError` 留空。
   */
  async userInfo({botId = '', id = '', refresh = false} = {}) {
    const uid = String(id ?? '').trim()
    if (!uid) throw new GuobaError('缺少用户 id')
    const owner = String(botId ?? '').trim()
    const bot = this.#bot(owner)
    const key = sessionKey(owner, 'friend', uid)
    const entry = this.#friendEntry(uid)
    const qqbot = isQQBot(bot)

    let live = null
    let liveAt = 0
    let liveError = ''
    if (!qqbot) {
      const hit = this.#userLiveCache.get(key)
      if (!refresh && hit && Date.now() - hit.at < USER_LIVE_TTL) {
        live = hit.data
        liveAt = hit.at
      } else if (typeof bot?.sendApi !== 'function') {
        liveError = '当前适配器没有 sendApi，取不到实时的用户信息'
      } else {
        try {
          live = await this.#fetchUserInfo(bot, uid, refresh)
          liveAt = Date.now()
          this.#userLiveCache.set(key, {at: liveAt, data: live})
          this.#applyUserInfo(bot, uid, live)
        } catch (err) {
          liveError = err?.message ?? String(err)
        }
      }
    }

    const recorded = entry
    return {
      key,
      botId: owner,
      id: uid,
      /** 前端拿它区分这是群卡还是用户卡（两张卡共用一份缓存） */
      type: 'friend',
      name: textOf(live, USER_INFO_FIELDS.name) || textOf(recorded, USER_INFO_FIELDS.name) || uid,
      avatar: userAvatarUrl(uid, owner, recorded?.avatar ?? live?.avatar),
      /**
       * QQBot 的好友 id 是 `${selfId}:${openid}` 复合形式，跟群一样，剥前缀拿真身；
       * `fl` 里已经存了 `openid` 的话优先用它（那是适配器从事件里带下来的原值）。
       */
      openid: textOf(recorded, USER_INFO_FIELDS.openid) || (qqbot ? pureOpenid(uid) : ''),
      unionid: textOf(live, USER_INFO_FIELDS.unionid) || textOf(recorded, USER_INFO_FIELDS.unionid),
      /** 适配器给的好友备注（跟群备注不是一回事：这个来自 QQ，不是面板自己填的） */
      remark: textOf(live, USER_INFO_FIELDS.remark) || textOf(recorded, USER_INFO_FIELDS.remark),
      liveError,
      refreshedAt: liveAt ? Math.floor(liveAt / 1000) : 0,
      pinned: isPinned(key),
      blacklisted: isBlacklisted(key),
      /** 前端据此把「账号」那一栏的标签在 openid / QQ 之间切 */
      qqbot,
    }
  }

  /** 刷新用户信息：数据跟 {@link userInfo} 一样，只是跳过缓存 */
  async refreshUserInfo({botId = '', id = ''} = {}) {
    return this.userInfo({botId, id, refresh: true})
  }

  /**
   * 群成员列表：输入框里打 @ 时的昵称索引。
   *
   * 两档取法：群对象上的成员表（icqq 这类）→ OneBot 的 `get_group_member_list`。
   * 拉一次缓存一分钟，关键词在本地过滤，输入过程中不再反复问协议端。
   */
  async groupMembers({botId = '', groupId = '', keyword = ''} = {}) {
    const gid = String(groupId ?? '').trim()
    if (!gid) throw new GuobaError('缺少群号')
    const owner = String(botId ?? '').trim()
    const bot = this.#bot(owner)
    if (!bot) throw new GuobaError('找不到这个机器人账号')
    const cacheKey = `${owner}:${gid}`
    let hit = this.#memberListCache.get(cacheKey)
    if (!hit || Date.now() - hit.at >= MEMBER_LIST_TTL) {
      const list = await this.#fetchGroupMembers(bot, gid)
      hit = {at: Date.now(), list}
      this.#memberListCache.set(cacheKey, hit)
    }
    const kw = String(keyword ?? '').trim().toLowerCase()
    const list = kw
      ? hit.list.filter((m) =>
        m.name.toLowerCase().includes(kw)
        || m.card.toLowerCase().includes(kw)
        || m.userId.includes(kw))
      : hit.list
    return {list: list.slice(0, MAX_MEMBER_LIST), total: list.length}
  }

  /** 取整份群成员表，统一成 `{userId, name, card, role}` */
  async #fetchGroupMembers(bot, gid) {
    const groupId = Number(gid) || gid
    const out = []
    const seen = new Set()
    const push = (uid, card, nickname, role) => {
      const id = String(uid ?? '').trim()
      if (!id || seen.has(id)) return
      seen.add(id)
      // 群名片常常是一串空格，trim 后为空就该退回昵称 / QQ 号
      const cleanCard = String(card ?? '').trim()
      const cleanNick = String(nickname ?? '').trim()
      out.push({
        userId: id,
        name: cleanCard || cleanNick || id,
        card: cleanCard,
        role: String(role ?? ''),
      })
    }

    try {
      const group = typeof bot.pickGroup === 'function' ? bot.pickGroup(groupId) : null
      if (typeof group?.getMemberMap === 'function') {
        const map = await group.getMemberMap()
        for (const member of map instanceof Map ? map.values() : map ?? []) {
          const info = member?.info ?? member
          push(
            info?.user_id ?? member?.user_id,
            info?.card ?? member?.card,
            info?.nickname ?? member?.nickname,
            info?.role ?? member?.role,
          )
        }
      }
    } catch {
      // 群对象上没这张表（多数 OneBot 实现），走下面的接口
    }

    if (!out.length && typeof bot.sendApi === 'function') {
      const res = await bot.sendApi('get_group_member_list', {group_id: groupId})
      const data = res?.data ?? res
      if (Array.isArray(data)) {
        for (const item of data) {
          push(item?.user_id, item?.card, item?.nickname, item?.role)
        }
      }
    }

    if (!out.length) throw new GuobaError('这个适配器取不到群成员列表')
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return out
  }

  /**
   * 群成员信息：消息记录里点头像弹出的信息卡补的「入群时间」。
   *
   * 消息事件里不带入群时间，只能点开卡片时现问适配器：先走群对象上的成员
   * （icqq 的 `getInfo()` 等），不行再退 OneBot 的标准动作 `get_group_member_info`；
   * QQ 官方机器人走 SDK 的 `getGroupMemberInfo`。
   *
   * 取不到不算错 —— 返回空时间 + liveError，卡片上如实写一句，别整张卡打不开。
   */
  async memberInfo({botId = '', groupId = '', userId = ''} = {}) {
    const gid = String(groupId ?? '').trim()
    const uid = String(userId ?? '').trim()
    if (!gid) throw new GuobaError('缺少群号')
    if (!uid) throw new GuobaError('缺少成员 QQ')
    const owner = String(botId ?? '').trim()
    const bot = this.#bot(owner)
    const cacheKey = `${owner || 'default'}:${gid}:${uid}`

    const hit = this.#memberLiveCache.get(cacheKey)
    const ttl = hit?.data?.joinTime ? MEMBER_LIVE_TTL : MEMBER_LIVE_MISS_TTL
    if (hit && Date.now() - hit.at < ttl) return hit.data

    let live = null
    let liveError = ''
    try {
      live = bot && isQQBot(bot)
        ? await this.#fetchQQBotMemberInfo(bot, gid, uid)
        : await this.#fetchMemberInfo(bot, gid, uid)
    } catch (err) {
      liveError = err?.message ?? String(err)
    }

    const joinTime = joinTimeOf(live)
    // 签名不在群成员信息里，NapCat / Lagrange 的 get_stranger_info 才有（longNick）
    const sign = await this.#fetchSign(bot, uid)
    const data = {
      userId: uid,
      /** 秒，0 表示取不到 */
      joinTime,
      /** 个性签名，取不到是空串 */
      sign,
      liveError: joinTime ? '' : (liveError || '这个适配器没给入群时间'),
    }
    this.#memberLiveCache.set(cacheKey, {at: Date.now(), data})
    return data
  }

  /** 问适配器要个性签名：NapCat / Lagrange 的 get_stranger_info 会给 longNick */
  async #fetchSign(bot, uid) {
    if (typeof bot?.sendApi !== 'function') return ''
    const userId = Number(uid) || uid
    for (const action of ['get_stranger_info', 'get_friend_info']) {
      try {
        const res = await bot.sendApi(action, {user_id: userId, no_cache: true})
        const data = res?.data ?? res
        if (!data || typeof data !== 'object') continue
        const sign = probeFields(data, MEMBER_INFO_FIELDS.sign)
        if (sign != null) return String(sign).trim()
      } catch {
        // 协议端不认这个动作就试下一个；都拿不到就空着
      }
    }
    return ''
  }

  /** 问适配器要一个群成员的详情，两档：群对象上的成员 → OneBot 动作 */
  async #fetchMemberInfo(bot, gid, uid) {
    if (!bot) throw new GuobaError('找不到这个机器人账号')
    const groupId = Number(gid) || gid
    const userId = Number(uid) || uid
    let member = null
    try {
      const group = typeof bot.pickGroup === 'function' ? bot.pickGroup(groupId) : null
      member = typeof group?.pickMember === 'function' ? group.pickMember(userId) : null
    } catch {
      member = null
    }
    if (member) {
      try {
        const info = typeof member.getInfo === 'function' ? await member.getInfo()
          : typeof member.getGroupMemberInfo === 'function' ? await member.getGroupMemberInfo()
            : member.info
        if (info && typeof info === 'object') return info
      } catch {
        // 成员对象这条路走不通（不在群、适配器没实现），落到下面问接口
      }
    }
    if (typeof bot.sendApi === 'function') {
      const res = await bot.sendApi('get_group_member_info', {group_id: groupId, user_id: userId})
      const data = res?.data ?? res
      if (data && typeof data === 'object') return data
    }
    throw new GuobaError('当前适配器取不到成员信息')
  }

  /** QQ 官方机器人的成员信息：SDK 上是 `getGroupMemberInfo(群 openid, 成员 openid)` */
  async #fetchQQBotMemberInfo(bot, gid, uid) {
    const sdk = this.#qqbotSdk(bot)
    if (typeof sdk?.getGroupMemberInfo !== 'function') {
      throw new GuobaError('当前 QQ 机器人没接上 SDK，取不到成员信息')
    }
    const groupOpenid = pureOpenid(gid)
    const memberOpenid = pureOpenid(uid)
    if (!groupOpenid || !memberOpenid) {
      throw new GuobaError('群或成员的 openid 是空的，取不到成员信息')
    }
    const data = await sdk.getGroupMemberInfo(groupOpenid, memberOpenid)
    if (!data || typeof data !== 'object') throw new GuobaError('QQ 那边没回成员信息')
    return data
  }

  /** 面板记录的那份好友信息（`bot.fl` 里的一条） */
  #friendEntry(uid) {
    const map = Bot.getFriendMap?.()
    if (!(map instanceof Map)) return null
    // 键可能是数字（OneBot 的 QQ 号）也可能是字符串（QQBot 的复合 id），两边都试一下
    const entry = map.get(Number(uid) || uid) ?? map.get(String(uid))
    return entry && typeof entry === 'object' ? entry : null
  }

  /** 问一次适配器要好友信息，动作名逐个试 */
  async #fetchUserInfo(bot, uid, refresh) {
    const params = {user_id: Number(uid) || uid}
    // no_cache 是 NapCat 的扩展，别家不认也会忽略。只在显式刷新时带上
    if (refresh) params.no_cache = true
    const tried = []
    for (const action of USER_INFO_ACTIONS) {
      let res
      try {
        res = await bot.sendApi(action, params)
      } catch (err) {
        tried.push(`${action}: ${err?.message ?? err}`)
        continue
      }
      const data = res?.data ?? res
      if (!data || typeof data !== 'object') {
        tried.push(`${action}: 返回 ${typeof data}`)
        continue
      }
      // 个别实现把错误塞在返回里而不是抛错
      const code = data.retcode
      if (code != null && code !== 0 && code !== 1) {
        tried.push(`${action}: retcode=${code}`)
        continue
      }
      return data
    }
    throw new GuobaError(`取不到用户信息（${tried.join('；')}）`)
  }

  /**
   * 把现取的好友信息回填进适配器的好友缓存。
   *
   * 会话列表的名字与头像都从 `bot.fl` 读（见 {@link listSessions}），不回填的话
   * 卡片上是新昵称、左边列表还是旧的。
   */
  #applyUserInfo(bot, uid, data) {
    const map = bot?.fl
    if (!(map instanceof Map)) return
    const entry = map.get(Number(uid) || uid) ?? map.get(String(uid))
    if (!entry || typeof entry !== 'object') return
    const name = textOf(data, USER_INFO_FIELDS.name)
    const remark = textOf(data, USER_INFO_FIELDS.remark)
    const avatar = textOf(data, ['avatar', 'avatar_url', 'avatarUrl'])
    if (name) entry.nickname = name
    if (remark) entry.remark = remark
    if (avatar) entry.avatar = avatar
  }

  /**
   * 置顶 / 取消置顶。
   *
   * 纯面板状态，不动适配器，所以同步返回。`saved` 为 false 表示内存里已经改了、
   * 但没写进磁盘（重启会丢），前端可以提示一句。
   */
  setPin({botId = '', type = 'group', id = '', pinned = true} = {}) {
    const sid = String(id ?? '').trim()
    if (!sid) throw new GuobaError('缺少会话 id')
    const key = sessionKey(botId, type, sid)
    return {key, pinned: !!pinned, saved: setPinned(key, pinned)}
  }

  /**
   * 设置 / 清除群备注。
   *
   * 备注是**用户自己给群起的名字**，不来自任何适配器 —— 所以这里只写面板那份 JSON，
   * 不动适配器。传空串就是清除。返回清好的文本，前端直接拿来回显。
   */
  setGroupNote({botId = '', id = '', note = ''} = {}) {
    const sid = String(id ?? '').trim()
    if (!sid) throw new GuobaError('缺少群号')
    const key = sessionKey(botId, 'group', sid)
    const saved = setNote(key, note)
    return {key, note: getNote(key), saved}
  }

  /**
   * 拉黑 / 取消拉黑。
   *
   * 分两层：
   * 1. 锅巴面板自己记一份（model/chatPrefs.js）—— 列表上的标记与排序靠它，任何适配器都有；
   * 2. QQ 官方机器人再顺手同步给 QQBot-Plugin 的黑名单（model/qqbotBlacklist.js），
   *    那份才是真正决定机器人理不理这个群的名单，QQBot-Web-Adapter 也是这么接的。
   *
   * 其余适配器锅巴这边没有统一的黑名单接口，只做第 1 层，并在 note 里说清楚 ——
   * 悄悄「拉黑」了却没有任何效果，比说一句实话难查得多。
   */
  async setBlacklist({botId = '', type = 'group', id = '', blacklisted = true} = {}) {
    const sid = String(id ?? '').trim()
    if (!sid) throw new GuobaError('缺少会话 id')
    const key = sessionKey(botId, type, sid)
    const saved = setBlacklisted(key, blacklisted)

    let mirrored = false
    let note = ''
    if (type === 'friend') {
      note = '私聊拉黑只记在锅巴面板里，机器人那边不受影响'
    } else if (isQQBot(this.#bot(botId))) {
      const res = await mirrorGroupBlacklist(sid, blacklisted)
      mirrored = res.ok
      note = res.note
    } else {
      note = '当前适配器没有黑名单接口，只在锅巴面板里标记'
    }
    return {key, blacklisted: !!blacklisted, saved, mirrored, note}
  }

  /** 面板记录的那份群信息（`bot.gl` 里的一条） */
  #groupEntry(gid) {
    const map = Bot.getGroupMap?.()
    if (!(map instanceof Map)) return null
    const entry = map.get(Number(gid) || gid)
    return entry && typeof entry === 'object' ? entry : null
  }

  /**
   * QQ 官方机器人的 SDK。
   *
   * QQBot-Plugin 把它挂在 `Bot[uin].sdk` 上（见它的 adapter/connect.js），
   * QQBot-Web-Adapter 也是这么取的：`Bot[selfId]?.sdk || Bot[selfId]`。
   * 后半个兜底是给别的 fork 留的 —— 有的直接把方法摊在 bot 上。
   */
  #qqbotSdk(bot) {
    return bot?.sdk ?? bot ?? null
  }

  /**
   * 问 QQ 官方机器人要群信息。
   *
   * 跟 OneBot 系完全不是一回事：那边是 `sendApi('get_group_info')`，这边是 SDK 上的
   * `getGroupInfo(纯 openid)`（走 `/v2/groups/{id}/info`）。QQBot-Web-Adapter 用的就是它，
   * 群人数 / 群简介 / 群分类 全在这一份里 —— 这正是「QQBot 下单独处理」的原因。
   *
   * 群 id 得先剥掉 `${selfId}:` 前缀，SDK 只认纯 openid。
   */
  async #fetchQQBotGroupInfo(bot, gid) {
    const sdk = this.#qqbotSdk(bot)
    if (typeof sdk?.getGroupInfo !== 'function') {
      throw new GuobaError('当前 QQ 机器人没接上 SDK，取不到实时的群信息')
    }
    const pure = pureOpenid(gid)
    if (!pure) throw new GuobaError('这个群的 openid 是空的，取不到实时的群信息')
    try {
      const data = await sdk.getGroupInfo(pure)
      if (!data || typeof data !== 'object') {
        throw new GuobaError('QQ 那边没回群信息')
      }
      return data
    } catch (err) {
      throw new GuobaError(describeQQBotGroupError(err))
    }
  }

  /** 问一次适配器要群信息，动作名逐个试 */
  async #fetchGroupInfo(bot, gid, refresh) {
    const params = {group_id: Number(gid) || gid}
    // no_cache 是 NapCat 的扩展，别家不认也会忽略。只在用户显式刷新时带上，
    // 免得开一次弹窗就绕过协议端自己的缓存
    if (refresh) params.no_cache = true
    const tried = []
    for (const action of GROUP_INFO_ACTIONS) {
      let res
      try {
        res = await bot.sendApi(action, params)
      } catch (err) {
        tried.push(`${action}: ${err?.message ?? err}`)
        continue
      }
      // sendApi 回来的是个 Proxy，data 里的字段直接取得到（同 get_msg 那两处）
      const data = res?.data ?? res
      if (!data || typeof data !== 'object') {
        tried.push(`${action}: 返回 ${typeof data}`)
        continue
      }
      // 个别实现把错误塞在返回里而不是抛错
      const code = data.retcode
      if (code != null && code !== 0 && code !== 1) {
        tried.push(`${action}: retcode=${code}`)
        continue
      }
      return data
    }
    throw new GuobaError(`取不到群信息（${tried.join('；')}）`)
  }

  /**
   * 把现取的群信息回填进适配器的群缓存。
   *
   * 会话列表的名字与人数都从 `bot.gl` 读（见 {@link listSessions}），不写回去的话
   * 「刷新群信息」就只刷新了弹窗、左侧列表纹丝不动。
   */
  #applyGroupInfo(bot, gid, data) {
    const map = bot?.gl
    if (!(map instanceof Map)) return
    const entry = map.get(Number(gid) || gid)
    if (!entry || typeof entry !== 'object') return
    const name = textOf(data, GROUP_INFO_FIELDS.name)
    const memberCount = numOf(data, GROUP_INFO_FIELDS.memberCount)
    const maxMemberCount = numOf(data, GROUP_INFO_FIELDS.maxMemberCount)
    const remark = textOf(data, GROUP_INFO_FIELDS.remark)
    const intro = textOf(data, GROUP_INFO_FIELDS.intro)
    const category = textOf(data, GROUP_INFO_FIELDS.category)
    const tags = tagsOf(data)
    if (name) entry.group_name = name
    if (memberCount) entry.member_count = memberCount
    if (maxMemberCount) entry.max_member_count = maxMemberCount
    if (remark) entry.group_remark = remark
    // QQBot-Plugin 自己那套键名也写一遍：它下次启动时从 gl 读的就是这几个，
    // 只写 member_count 的话，面板刷新完过一阵又变回旧值（见它的 setGroupMap）
    if (memberCount) entry.group_member_num = memberCount
    if (intro) entry.group_finger_memo = intro
    if (category) entry.group_class_text = category
    if (tags.length) entry.group_tags = tags
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
