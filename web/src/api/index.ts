import { del, get, post, put, type RequestOptions } from './request'
import { API_BASE } from '@/utils/env'
import type {
  ConfigTab,
  FsTreeNode,
  HomeData,
  LoginUser,
  MenuItem,
  MsgStat,
  PluginItem,
  SystemStatus,
} from '@/types'

/* ---------------- 登录 / 用户 ---------------- */

/** 主人快速登录：用 #锅巴登录 生成的 code 换 token */
export const apiQuickLogin = (code: string) =>
  post<{ token: string }>('/login/quick', { code }, { showError: false })

/**
 * 请求登录验证码：后端打印到控制台，同时私聊发给主人。
 * pushed 为收到私聊的主人数量，0 表示只能去控制台看。
 */
export const apiRequestLoginCode = () =>
  post<{ pushed?: number }>('/login/code/request', {})

/** 用控制台验证码换 token */
export const apiCheckLoginCode = (code: string) =>
  post<{ token: string }>('/login/code/check', { code }, { showError: false })

export const apiLogout = (token: string) =>
  post('/logout', { token }, { showError: false })

/** 聊天确认登录：发起一个待主人确认的登录请求 */
export const apiCreateConfirmRequest = () =>
  post<{ id: string; code: string; expire: number }>('/login/confirm/request', {})

/** 轮询确认结果，approved 时带回 token */
export const apiPollConfirmRequest = (id: string) =>
  post<{ status: 'pending' | 'approved'; token: string }>(
    '/login/confirm/poll',
    { id },
    { showError: false },
  )

export const apiGetLoginUser = () => get<LoginUser>('/user/getLoginUser')

export const apiGetPermCode = () =>
  get<{ permCode: string[]; liteToken: string }>('/getPermCode')

export const apiGetMenuList = () => get<MenuItem[]>('/getMenuList')

/* ---------------- 首页 ---------------- */

export const apiGetHomeData = () => get<HomeData>('/home/data')

/** 系统状态。轮询调用，失败不弹提示，避免断网时刷屏 */
export const apiGetSystemStatus = () =>
  get<SystemStatus>('/home/status', undefined, { showError: false })

/** 消息统计，days 为趋势天数（后端限制 1-30） */
export const apiGetMsgStat = (days = 7) =>
  get<MsgStat>('/home/msg-stat', { days }, { showError: false })

export const apiGetCityWeather = () =>
  get<{ weather: any }>('/helper/city_weather', undefined, { showError: false })

/** 当前配置的天气城市 */
export const apiGetCity = () => get<{ city: string }>('/helper/city')

/** 全部可选城市名，量大但只在打开选择器时拉一次 */
export const apiGetCityOptions = () => get<string[]>('/helper/city/options')

/** 切换天气城市 */
export const apiSetCity = (city: string) => post<{ city: string }>('/helper/city', { city })

/**
 * 随机角色图片地址（装了 miao-plugin 才有素材，否则后端回落到内置图）。
 * 该接口直接返回图片文件，token 走 query。
 */
export function homeRandomImageUrl(token: string, ts?: number) {
  const q = new URLSearchParams({ token })
  if (ts) q.set('_t', String(ts))
  return `${API_BASE}/home/random-image?${q.toString()}`
}

/* ---------------- 配置管理 ---------------- */

export const apiGetConfigTabs = () => get<ConfigTab[]>('/config/tabs')

export const apiGetConfigData = (key: string) => get<any>('/config/data', { key })

export const apiSetConfigData = (key: string, data: any) =>
  post('/config/data', { key, data }, { showSuccess: true })

export const apiRemoveCardForm = (formKey: string, cardKey: string) =>
  del('/config/card-Form', { formKey, cardKey })

/* ---------------- 插件 ---------------- */

export const apiGetPlugins = (force = false) =>
  get<PluginItem[]>('/plugin/list', { force })

export const apiGetPluginReadme = (link: string, force = false) =>
  get<string>('/plugin/readme', { link, force })

export const apiInstallPlugin = (body: {
  link: string
  autoRestart?: boolean
  autoNpmInstall?: boolean
}) => put<any>('/plugin/install', body, { showSuccess: true })

export const apiUninstallPlugin = (body: { name: string; autoRestart?: boolean }) =>
  put<any>('/plugin/uninstall', body, { showSuccess: true })

export const apiGetPluginConfig = (pluginName: string) =>
  get<any>(`/plugin/s/${encodeURIComponent(pluginName)}/config`)

export const apiSetPluginConfig = (pluginName: string, data: any) =>
  put(`/plugin/s/${encodeURIComponent(pluginName)}/config`, data, { showSuccess: true })

export const apiDoPluginAction = (
  pluginName: string,
  action: string,
  args?: any,
  options?: RequestOptions,
) =>
  post<any>(
    `/plugin/do/${encodeURIComponent(pluginName)}/action`,
    { action, args },
    { showSuccess: true, ...options },
  )

/* ---------------- 系统 ---------------- */

export const apiRestartBot = () => post('/bot/restart', {}, { showSuccess: true })

export const apiRestartGuoba = () => post('/sys/restart-guoba', {}, { showSuccess: true })

export const apiGetFsTreeRoot = () => get<FsTreeNode[]>('/sys/fs/tree/root')

export const apiGetFsTreeChildren = (path: string) =>
  get<FsTreeNode[]>('/sys/fs/tree/children', { path })

export const apiCreateDir = (path: string, name: string) =>
  put('/sys/fs/create-dir', { path, name }, { showSuccess: true })

/* ---------------- QQ 好友 / 群 ---------------- */

export interface PageQuery {
  pageNo?: number
  pageSize?: number
  [key: string]: any
}

export const apiQueryFriendList = (params: PageQuery) =>
  get<any>('/oicq/friend/list', params)

export const apiQueryGroupList = (params: PageQuery) =>
  get<any>('/oicq/group/list', params)

export const apiPickUser = (qq: string | number) => get<any>('/oicq/pick/user', { qq })

export const apiPickGroup = (groupId: string | number) =>
  get<any>('/oicq/pick/group', { groupId })

/** 主动给好友或群发消息，botId 用于指定发信账号 */
export const apiSendMsg = (body: {
  type: 'friend' | 'group'
  id: string | number
  msg: string
  botId?: string | number
}) => post<{ id: number; type: string; messageId: string | null }>('/oicq/send-msg', body)

/** 删除好友，不可逆 */
export const apiDeleteFriend = (body: { userId: string | number; botId?: string | number }) =>
  del<{ userId: number }>('/oicq/friend', body, { showSuccess: true })

/* ---------------- 群发 ---------------- */

export interface BroadcastTarget {
  id: string | number
  botId?: string | number
  /** 只用于失败列表里显示，服务端不据此发送 */
  name?: string
}

/** 群发任务进度，字段见 server/service/both/OicqService.js */
export interface BroadcastTask {
  id: string
  type: 'friend' | 'group'
  msg: string
  interval: number
  total: number
  sent: number
  failed: number
  status: 'running' | 'done' | 'canceled'
  startAt: number
  endAt: number | null
  errors: Array<{ id: number | string; name: string; error: string }>
}

/** 起一个群发任务，立刻返回任务信息，发送在后台按 interval 逐个进行 */
export const apiStartBroadcast = (body: {
  type: 'friend' | 'group'
  targets: BroadcastTarget[]
  msg: string
  interval?: number
}) => post<BroadcastTask>('/oicq/broadcast', body)

/** 查询群发进度 */
export const apiGetBroadcast = (taskId: string) =>
  get<BroadcastTask>(`/oicq/broadcast/${taskId}`)

/** 停止群发，已发出的收不回来 */
export const apiCancelBroadcast = (taskId: string) =>
  post<BroadcastTask>(`/oicq/broadcast/${taskId}/cancel`)

/** 退出群聊，isDismiss 为解散群（仅群主可用），不可逆 */
export const apiQuitGroup = (body: {
  groupId: string | number
  isDismiss?: boolean
  botId?: string | number
}) => del<{ groupId: number; isDismiss: boolean }>('/oicq/group', body, { showSuccess: true })

/* ---------------- 插件自定义页面 ---------------- */

/** 已注册的自定义页面，字段见 server/service/both/CustomPageService.js */
export interface CustomPage {
  id: string
  /** plugin：插件 guoba/ 目录提供；store：在面板里建的，可编辑 */
  source: 'plugin' | 'store'
  /** 来源插件目录名，面板内建页面为空 */
  pluginName: string
  /** 展示用的来源名 */
  label: string
  /** 该页面自定义接口的前缀，不含面板挂载前缀 */
  apiPath: string
  title: string
  icon?: string
  /** 直接注入的 HTML 片段 */
  html?: string
  /** iframe 嵌入的 HTML 文件名，优先级高于 html */
  src?: string
  style?: string
  script?: string
  priority?: number
}

/** 面板内建页面的描述符 */
export interface CustomPageMeta {
  id: string
  title: string
  icon: string
  /** html：注入片段，继承面板样式；frame：iframe 嵌完整 HTML */
  mode: 'html' | 'frame'
  priority: number
}

/** 面板内建页面的完整内容，编辑器用 */
export interface CustomPageSource extends CustomPageMeta {
  html: string
  css: string
  js: string
  /** 可选的 api.js，导出 init(ctx) 注册自定义接口 */
  api: string
}

export const apiGetCustomPages = () => get<CustomPage[]>('/custom-page/list')

export const apiGetCustomPage = (id: string) =>
  get<CustomPage>(`/custom-page/detail/${encodeURIComponent(id)}`, undefined, { showError: false })

export const apiReloadCustomPages = () =>
  post<number>('/custom-page/reload', {}, { showSuccess: true })

/** 页面静态资源地址，iframe 与注入的 css/js 都走这里 */
export function customPageAssetUrl(id: string, file: string) {
  return `${API_BASE}/custom-page/asset/${encodeURIComponent(id)}/${encodeURIComponent(file)}`
}

/* -------- 面板内建页面的管理 -------- */

export const apiGetStorePages = () => get<CustomPageMeta[]>('/custom-page/store/list')

export const apiGetStorePage = (id: string) =>
  get<CustomPageSource>(`/custom-page/store/detail/${encodeURIComponent(id)}`)

/** create 为真时是新建，id 撞车会被后端拒掉 */
export const apiSaveStorePage = (body: Partial<CustomPageSource> & { id: string; create?: boolean }) =>
  post<CustomPageMeta>('/custom-page/store/save', body, { showSuccess: true })

export const apiRemoveStorePage = (id: string) =>
  del<boolean>(`/custom-page/store/${encodeURIComponent(id)}`, undefined, { showSuccess: true })

/* -------- 运行日志 -------- */

/** 日志级别，与 log4js 一致 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'mark'

export interface LogLine {
  /** 单调递增，前端拿它当增量游标 */
  seq: number
  /** hh:mm:ss.SSS，续行为空 */
  time: string
  level: LogLevel
  text: string
  /** 续行（堆栈之类），级别继承自上一行 */
  cont: boolean
}

export interface LogTail {
  lines: LogLine[]
  /** 下次请求带上它取增量 */
  cursor: number
  /** 本次因超出 limit 被丢掉的行数 */
  truncated: number
  /** 有日志在两次轮询之间被挤出缓冲 */
  missed: boolean
}

export interface LogStatus {
  lines: number
  max: number
  cursor: number
  attached: boolean
  source: string
  logFile: string
}

export const apiTailLog = (params: {
  cursor?: number
  limit?: number
  level?: string
  keyword?: string
}) => get<LogTail>('/log/tail', params, { showError: false })

export const apiLogStatus = () => get<LogStatus>('/log/status', undefined, { showError: false })

export const apiClearLog = () => post<number>('/log/clear', {}, { showSuccess: true })

/* ---------------- 数据浏览（Redis / SQLite） ---------------- */

/** Redis key 的类型，与 `TYPE` 命令返回值一致 */
export type RedisKeyType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'none'

export interface RedisKeyItem {
  key: string
  type: RedisKeyType
  /** -1 永不过期，-2 已过期/不存在 */
  ttl: number
}

export interface RedisScanResult {
  /** 下一轮扫描用的游标，0 表示已扫完 */
  cursor: number
  items: RedisKeyItem[]
}

export interface RedisValue {
  key: string
  type: RedisKeyType
  ttl: number
  value: any
  /** 集合过大时只返回了前若干条 */
  truncated: boolean
}

export const apiRedisInfo = () =>
  get<{ dbSize: number; memory: string }>('/data/redis/info', undefined, { showError: false })

export const apiRedisScan = (params: { cursor?: number; match?: string; count?: number }) =>
  get<RedisScanResult>('/data/redis/scan', params)

export const apiRedisGet = (key: string) => get<RedisValue>('/data/redis/get', { key })

export const apiRedisSet = (body: {
  key: string
  type?: string
  value: any
  ttl?: number
}) => post<RedisValue>('/data/redis/set', body, { showSuccess: true })

export const apiRedisExpire = (key: string, ttl: number) =>
  post<RedisValue>('/data/redis/expire', { key, ttl }, { showSuccess: true })

export const apiRedisCommand = (command: string) =>
  post<{ command: string; reply: any }>('/data/redis/command', { command })

export const apiRedisDel = (keys: string[]) =>
  del<{ deleted: number }>('/data/redis/keys', { keys }, { showSuccess: true })

export interface DbFile {
  /** 绝对路径，后续接口都用它定位 */
  path: string
  /** 相对 Yunzai 根目录的展示名 */
  name: string
  /** 是否为 db.yaml 里配置的主库 */
  primary: boolean
  size: number
  mtime: number
}

export interface DbTable {
  name: string
  type: 'table' | 'view'
  count: number
}

export interface DbColumn {
  name: string
  type: string
  notnull: boolean
  pk: boolean
  defaultValue: any
}

export interface DbRows {
  columns: string[]
  rows: Record<string, any>[]
  total: number
  page: number
  pageSize: number
}

export const apiDbList = () => get<DbFile[]>('/data/db/list')

export const apiDbTables = (path: string) => get<DbTable[]>('/data/db/tables', { path })

export const apiDbColumns = (path: string, table: string) =>
  get<DbColumn[]>('/data/db/columns', { path, table })

export const apiDbRows = (params: {
  path: string
  table: string
  page?: number
  pageSize?: number
  keyword?: string
}) => get<DbRows>('/data/db/rows', params)

/** 执行任意 SQL。SELECT 返回结果集，其余返回受影响行数 */
export const apiDbSql = (path: string, sql: string) =>
  post<{
    type: 'select' | 'exec'
    columns?: string[]
    rows?: Record<string, any>[]
    total?: number
    truncated?: boolean
    affected?: number | null
    elapsed: number
  }>('/data/db/sql', { path, sql })

export const apiDbUpdateRow = (body: {
  path: string
  table: string
  rowid: number
  data: Record<string, any>
}) => post('/data/db/row', body, { showSuccess: true })

export const apiDbDeleteRow = (body: { path: string; table: string; rowid: number }) =>
  del('/data/db/row', body, { showSuccess: true })

/* ---------------- 沙盒 ---------------- */

/**
 * 模拟的目标平台。
 * default 是普通适配器（OneBot 等），按钮与 markdown 段会被忽略；
 * qqbot 假装成 QQ 官方 Bot，这两类段会渲染出来，插件里判断 QQBot 的分支也会走通。
 */
export type SandboxPlatform = 'default' | 'qqbot'

/** 沙盒会话场景。id 全用字符串存，适配器不一定是数字 QQ 号 */
export interface SandboxScene {
  /** 用哪个账号的身份收这条消息，空则取第一个在线账号 */
  selfId: string
  isGroup: boolean
  userId: string
  nickname: string
  groupId: string
  groupName: string
  /** 群名片，空则用昵称 */
  card: string
  isMaster: boolean
  isOwner: boolean
  isAdmin: boolean
  /** 群聊里是否在消息前加一个 at 机器人 */
  atBot: boolean
  platform: SandboxPlatform
}

export interface SandboxBot {
  uin: string
  nickname: string
  adapter: string
}

/** 回复里的一个按钮 */
export interface SandboxButton {
  text: string
  /** 点击即以该文本触发指令 */
  callback?: string
  /** 点击只填进输入框，等用户补完参数再发 */
  input?: string
  link?: string
  /** 官方按钮限定了可点用户，沙盒里不校验，只做标注 */
  limited?: boolean
}

/** 回复里的一个消息段，字段见 server/service/both/SandboxService.js 的 #normalizeMsg */
export interface SandboxSegment {
  type: string
  text?: string
  /** at 的目标 QQ */
  qq?: string
  name?: string
  /** reply 段引用的消息 id */
  id?: string
  /** 图片等资源的取用 id，走 sandboxAssetUrl */
  assetId?: string
  mime?: string
  /** http 直链资源不落服务端，直接给 url */
  url?: string
  size?: number
  /** 超过大小上限，只报尺寸不留内容 */
  tooLarge?: boolean
  error?: string
  /** 转发消息的子消息 */
  nodes?: Array<{
    nickname: string
    userId: string
    time: number | null
    segments: SandboxSegment[]
  }>
  /** 转发层数超限，未继续展开 */
  truncated?: boolean
  /** 按钮段，一个元素是一行 */
  rows?: SandboxButton[][]
  /** markdown 段的正文 */
  content?: string
  /** 当前模拟的平台不渲染这个段（按钮/markdown 发到 OneBot 那边就是被丢掉的） */
  ignored?: boolean
  /** 无法还原的段的原始 JSON */
  raw?: string
}

export interface SandboxReply {
  id: string
  /** 回复是从哪条通道发出来的：reply / friend / group / member */
  via: string
  time: number
  segments: SandboxSegment[]
}

/** 没有回复时的原因 */
export type SandboxBlocked = 'blacklist' | 'onlyReplyAt' | 'noRule' | 'noReply' | null

export interface SandboxResult {
  /** 经预处理后的文本，插件正则匹配的就是这个 */
  msg: string
  /** 命中的插件与方法，形如 `插件名(方法名)` */
  hit: string
  isMaster: boolean
  game: string
  elapsed: number
  blocked: SandboxBlocked
  error: string | null
  replies: SandboxReply[]
}

export interface SandboxRule {
  fnc: string
  reg: string
  event: string
  permission: string
  log: boolean
}

export interface SandboxPlugin {
  /** 插件文件，形如 `example/test.js` */
  key: string
  name: string
  dsc: string
  priority: number
  event: string
  rules: SandboxRule[]
}

export interface SandboxMatch {
  key: string
  name: string
  priority: number
  fnc: string
  reg: string
  permission: string
}

export const apiSandboxDefaults = () =>
  get<{ bots: SandboxBot[]; masterQQ: string[]; scene: SandboxScene }>('/sandbox/defaults')

export const apiSandboxRules = () => get<SandboxPlugin[]>('/sandbox/rules')

/** 只做匹配预览，不执行插件 */
export const apiSandboxMatch = (text: string, isGroup: boolean) =>
  post<{ msg: string; game: string; matched: SandboxMatch[] }>(
    '/sandbox/match',
    { text, isGroup },
    { showError: false },
  )

/** 发一条沙盒消息，images 为 dataURL */
export const apiSandboxSend = (body: {
  scene: SandboxScene
  text: string
  images?: string[]
}) => post<SandboxResult>('/sandbox/send', body)

/** 回复里图片/文件的取用地址，token 走 query 以便 <img> 直接引用 */
export function sandboxAssetUrl(assetId: string, token: string) {
  return `${API_BASE}/sandbox/asset/${encodeURIComponent(assetId)}?token=${encodeURIComponent(token)}`
}

/* ---------------- 消息记录 ---------------- */

/**
 * 段结构与沙盒共用一份（server/service/both/model/msgSegment.js），
 * 这里给两个中性别名，公用的 MsgSegment.vue 用它们，读起来不像只服务沙盒。
 */
export type MsgSeg = SandboxSegment
export type MsgBtn = SandboxButton

export type ChatType = 'friend' | 'group'

/** 活跃摘要：会话 key -> 最后一条 + 未读 */
export interface ChatActiveItem {
  /** 秒 */
  lastTime: number
  lastText: string
  unread: number
}

export interface ChatSession extends ChatActiveItem {
  key: string
  botId: string
  type: ChatType
  id: string
  name: string
}

export interface ChatMsg {
  /** 实时缓冲里的序号，历史消息没有 */
  seq?: number
  key: string
  botId: string
  type: ChatType
  id: string
  messageId: string
  /** 向上翻页的游标 */
  messageSeq: string
  /** 秒 */
  time: number
  /** bot 自己发的 */
  self: boolean
  /** title 是群头衔，role 是群主 / 管理，二者都可能没有 */
  sender: { userId: string; nickname: string; card: string; role: string; title: string }
  segments: MsgSeg[]
  /** 在面板里撤回过 */
  recalled?: boolean
}

export interface ChatTail {
  messages: ChatMsg[]
  /** 下次带上它取增量 */
  cursor: number
  /** 活跃表版本，变了才会带回 sessions */
  rev: number
  sessions: Record<string, ChatActiveItem> | null
  /** 有消息在两次轮询之间被挤出缓冲 */
  missed: boolean
  unread: number
}

export interface ChatStatus {
  /** 在线账号，多账号时得选一个来发 */
  bots: SandboxBot[]
  messages: number
  max: number
  cursor: number
  rev: number
  /** 消息监听是否挂上了 */
  attached: boolean
  maxImages: number
}

export const apiChatStatus = () => get<ChatStatus>('/chat/status', undefined, { showError: false })

export const apiChatSessions = (params: {
  type: ChatType
  botId?: string
  keyword?: string
  pageNo?: number
  pageSize?: number
}) =>
  get<{
    list: ChatSession[]
    total: number
    pageNo: number
    pageSize: number
    rev: number
    sessions: Record<string, ChatActiveItem>
  }>('/chat/sessions', params)

/** 拉历史消息。seq 为向上翻页的游标，0 取最新 */
export const apiChatHistory = (params: {
  botId: string
  type: ChatType
  id: string
  seq?: string | number
  count?: number
}) =>
  get<{
    /** 适配器不支持拉历史时为 false，只能看面板运行期间的消息 */
    supported: boolean
    messages: ChatMsg[]
    hasMore: boolean
    cursor: number
  }>('/chat/history', params)

/** 实时增量，轮询调用，失败不弹提示 */
export const apiChatTail = (params: { key: string; cursor: number; rev?: number }) =>
  get<ChatTail>('/chat/tail', params, { showError: false })

/**
 * 发消息，**会真的发到 QQ 上**。
 *
 * 图片走 multipart 上传（FormData 的 files 字段）。之前是把 base64 塞进 JSON body，
 * 共享 TRSS 端口时 body 解析器是宿主的 express.json（默认 100kb 上限），一张图就 413 了。
 */
export const apiChatSend = (fd: FormData) =>
  post<{ messageId: string; message: ChatMsg | null; cursor: number }>('/chat/send', fd)

/** 发原始消息段数组（JSON 文本） */
export const apiChatSendRaw = (body: {
  botId: string
  type: ChatType
  id: string
  raw: string
}) => post<{ messageId: string; message: ChatMsg | null; cursor: number }>('/chat/send-raw', body)

/** 撤回，只能撤 bot 自己发的且有时限 */
export const apiChatRecall = (body: {
  botId: string
  type: ChatType
  id: string
  messageId: string
}) => post<{ messageId: string }>('/chat/recall', body)

export const apiChatRead = (key: string) =>
  post<{ key: string; rev: number }>('/chat/read', { key }, { showError: false })

/** 戳一戳：群里 pokeMember、私聊 poke，适配器不支持会报错 */
export const apiChatPoke = (body: {
  botId: string
  type: ChatType
  id: string
  userId: string
}) => post<{ ok: boolean }>('/chat/poke', body)

/** 复读：后端按段原样重发（图片/表情不会被降级成文字占位） */
export const apiChatResend = (body: {
  botId: string
  type: ChatType
  id: string
  messageId: string
}) => post<{ messageId: string; message: ChatMsg | null; cursor: number }>('/chat/resend', body)

/** 展开合并转发，内容在 QQ 服务端 */
export const apiChatForward = (body: {
  botId: string
  type: ChatType
  id: string
  messageId: string
}) =>
  post<{
    nodes: Array<{ nickname: string; userId: string; time: number | null; segments: MsgSeg[] }>
  }>('/chat/forward', body)

/** 自己发出去的图片的取用地址 */
export function chatAssetUrl(assetId: string, token: string) {
  return `${API_BASE}/chat/asset/${encodeURIComponent(assetId)}?token=${encodeURIComponent(token)}`
}

/** QQ 直链的 rkey 过期后的兜底：交给服务端代拉一次 */
export function chatProxyUrl(url: string, token: string) {
  const q = new URLSearchParams({ url, token })
  return `${API_BASE}/chat/proxy?${q.toString()}`
}

/* ---------------- 文件管理 ---------------- */

/** 目录里的一项。path 用相对 Yunzai 根的路径，根本身是空串 */
export interface FsFile {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

/** 列目录 */
export const apiFileList = (path: string) =>
  get<FsFile[]>('/file/list', { path }, { showError: false })

/** 读文本文件内容 */
export const apiFileRead = (path: string) =>
  get<{ content: string; size: number }>('/file/read', { path })

/** 保存文本文件 */
export const apiFileSave = (body: { path: string; content: string }) =>
  post<{ ok: boolean }>('/file/save', body)

/** 新建文件夹 */
export const apiFileMkdir = (path: string) => post<{ ok: boolean }>('/file/mkdir', { path })

/** 新建文件 */
export const apiFileCreate = (body: { path: string; content?: string }) =>
  post<{ ok: boolean }>('/file/create', body)

/** 重命名 */
export const apiFileRename = (body: { path: string; newName: string }) =>
  post<{ ok: boolean }>('/file/rename', body)

/** 删除（递归） */
export const apiFileDelete = (path: string) => post<{ ok: boolean }>('/file/delete', { path })

/** 上传：FormData 带 path 字段 + 文件，走 multipart（同消息记录发图） */
export const apiFileUpload = (fd: FormData) =>
  post<{ ok: boolean; saved: string[] }>('/file/upload', fd)

/** 下载地址，token 走 query 才能直接写进 <a href> */
export function fileDownloadUrl(path: string, token: string) {
  const q = new URLSearchParams({ path, token })
  return `${API_BASE}/file/download?${q.toString()}`
}

export * from './miao'
export { request, get, post, put, del } from './request'
