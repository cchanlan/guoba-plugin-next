/* ---------------- 表单 Schema ---------------- */

/**
 * 插件通过 guoba.support.js 声明的表单项。
 * 这些对象经 JSON 序列化后送到前端，所以其中不会包含函数。
 * 组件名沿用 Ant Design Vue 的组件名，外加锅巴自定义的 G* 系列。
 */
export interface FormSchema {
  /** 字段路径，支持 a.b.c 形式 */
  field?: string
  /** 标签文字 */
  label?: string
  /** 组件名 */
  component?: string
  /** 传给组件的 props */
  componentProps?: Record<string, any>
  /** 是否必填 */
  required?: boolean
  /** 校验规则（pattern 为字符串形式的正则） */
  rules?: Array<{
    pattern?: string
    message?: string
    required?: boolean
    type?: string
    min?: number
    max?: number
  }>
  /** 标签右侧问号图标的提示 */
  helpMessage?: string | string[]
  /** 字段下方的说明文字 */
  bottomHelpMessage?: string
  /** 默认值 */
  defaultValue?: any
  /** 占据的栅格数（部分插件会传） */
  colProps?: Record<string, any>
  /** 分组标题（SOFT_GROUP_BEGIN 用 label 表示组名） */
  [key: string]: any
}

/** 配置管理里的一张卡片 */
export interface ConfigCard {
  key: string
  title: string
  desc?: string
  schemas: FormSchema[]
  /** 卡片是否可删除（部分动态卡片支持） */
  canRemove?: boolean
  [key: string]: any
}

/** 配置管理里的一个 tab */
export interface ConfigTab {
  key: string
  title: string
  cards: ConfigCard[]
  [key: string]: any
}

/* ---------------- 菜单 ---------------- */

export interface MenuMeta {
  title?: string
  icon?: string
  hideMenu?: boolean
  ignoreRoute?: boolean
  [key: string]: any
}

export interface MenuItem {
  path: string
  name: string
  component?: string
  redirect?: string
  meta?: MenuMeta
  children?: MenuItem[]
  guobaMeta?: {
    plugin?: {
      name: string
      icon?: string
      iconColor?: string
      iconPath?: string
    }
  }
  [key: string]: any
}

/* ---------------- 用户 / 首页 ---------------- */

export interface LoginUser {
  userId: string | number
  username: string | number
  realName?: string
  avatar?: string
  desc?: string
  homePath?: string
  roles?: Array<{ roleName: string; value: string }>
}

export interface LoginStatus {
  configured: boolean
  captchaRequired: boolean
  ip?: string
}

export interface TrustedIp {
  ip: string
  device?: string
}

export interface LoginSecurity {
  configured: boolean
  username: string
  trustedIps: TrustedIp[]
}

export interface HomeData {
  cookieCount?: number
  friendCount?: number
  groupCount?: number
}

/** 单项占用，字节为单位；percent 是 0-100 */
export interface UsageItem {
  total: number
  used: number
  percent: number
}

export interface SystemStatus {
  load: {
    avg1: number
    avg5: number
    avg15: number
    cpuCount: number
    percent: number
    /** Windows 下 loadavg 恒为 0，此项为 false 时前端不展示 */
    supported: boolean
  }
  cpu: {
    percent: number
    count: number
    model: string
  }
  memory: UsageItem
  /** 取不到磁盘信息时为 null */
  disk: (UsageItem & { name: string }) | null
  /** 单位：秒 */
  uptime: {
    process: number
    system: number
  }
  platform: string
  arch: string
  nodeVersion: string
}

export interface MsgTrendItem {
  /** MM-DD */
  date: string
  receive: number
  send: number
}

export interface BotMsgStat {
  uin: string
  nickname: string
  /** 适配器名（如 OneBotv11），多适配器混跑时用来区分 */
  adapter?: string
  today: { receive: number; send: number }
  total: { receive: number; send: number }
}

export interface MsgStat {
  receive: { today: number; month: number; total: number }
  send: { today: number; month: number; total: number }
  trend: MsgTrendItem[]
  bots: BotMsgStat[]
}

/* ---------------- 插件 ---------------- */

export interface PluginItem {
  name: string
  title?: string
  description?: string
  author?: string | string[]
  authorLink?: string | string[]
  link?: string
  installed?: boolean
  isV2?: boolean
  isV3?: boolean
  isDeleted?: boolean
  hasConfig?: boolean
  showInMenu?: boolean
  schemas?: FormSchema[]
  icon?: string
  iconColor?: string
  iconPath?: string
  [key: string]: any
}

/* ---------------- 文件树 ---------------- */

export interface FsTreeNode {
  title: string
  path: string
  isLeaf: boolean
  children?: FsTreeNode[] | null
  [key: string]: any
}

/* ---------------- 喵喵插件 ---------------- */

/** 帮助配置里的样式部分 */
export interface MiaoHelpStyle {
  fontColor?: string
  descColor?: string
  contBgColor?: string
  contBgBlur?: number
  headerBgColor?: string
  rowBgColor1?: string
  rowBgColor2?: string
  [key: string]: any
}

/** 帮助配置本体，见 miao-plugin/config/system/help_system.js */
export interface MiaoHelpCfgBody {
  title?: string
  subTitle?: string
  columnCount?: number
  colWidth?: number
  /** 'all' 或皮肤名数组 */
  theme?: string | string[]
  themeExclude?: string[]
  style?: MiaoHelpStyle
  bgBlur?: boolean
  [key: string]: any
}

/** 帮助列表中的一条命令 */
export interface MiaoHelpItem {
  icon?: number
  title?: string
  desc?: string
  [key: string]: any
}

/** 帮助列表中的一个分组 */
export interface MiaoHelpGroup {
  group?: string
  list?: MiaoHelpItem[]
  [key: string]: any
}

/** GET /plugin/miao/help 的返回 */
export interface MiaoHelpCfg {
  helpCfg?: MiaoHelpCfgBody
  helpList?: MiaoHelpGroup[]
  /** 可用皮肤名 */
  themeNames?: string[]
  miaoVersion?: string
  yunzaiVersion?: string
  [key: string]: any
}

export interface MiaoThemeItem {
  name: string
  style?: Record<string, any>
  [key: string]: any
}

export interface MiaoBackupItem {
  id: string
  remark?: string
  time?: string
  version?: number
  isInit?: boolean
  [key: string]: any
}
