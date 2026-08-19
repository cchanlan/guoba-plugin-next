/**
 * 条目选择器的输入形状。
 *
 * 新建备份用的是扫描结果（带 kind / recommended），还原用的是包里 manifest 的条目
 * （只有 key / rel / size / files）—— 两边都折成这个形状喂给 EntryPicker，
 * 选择器本身不用关心数据是哪来的。
 */
export interface PickerEntry {
  key: string
  rel: string
  size: number
  files: number
  /** 来源标记，还原时没有 */
  kind?: string
  /** 体积统计触顶，size 是下限 */
  truncated?: boolean
  /** 默认勾选 */
  recommended?: boolean
}

export interface PickerGroup {
  /** `root` 或 `plugin:<name>` */
  key: string
  title: string
  /** 标题右边的小字，插件放 分支@提交 */
  subtitle?: string
  /** 醒目提示，如「本地未安装」 */
  warn?: string
  /** 可克隆的远程仓库（地址已脱敏），新建备份页显示 */
  remotes?: Array<{ name: string; url: string }>
  /** 一个条目都没有时显示的说明，替代笼统的「没有需要备份的内容」 */
  emptyHint?: string
  entries: PickerEntry[]
}

/**
 * 树节点。条目的 rel 是 `data/memes/result` 这样的多级路径，平铺成一长条列表很难看，
 * 所以按 `/` 拆成目录树：目录节点只是分组（勾它等于勾整棵子树），叶子才是真条目。
 */
export interface TreeNode {
  /** 叶子用条目自己的 key，目录用 `dir:<组>|<路径前缀>` —— 两者不会撞 */
  key: string
  /** 这一层显示的名字，单子目录会被压成 `a/b` 省一次点击 */
  name: string
  /** 只有叶子有 */
  entry?: PickerEntry
  children?: TreeNode[]
  /** 目录是子树合计 */
  size: number
  files: number
  truncated: boolean
  /** 子树里的条目数，目录节点显示「N 项」用 */
  leaves: number
}

/** 来源标记 → 中文说明。跟 backupDiscover.js 的 kind 一一对应 */
export const KIND_TEXT: Record<string, string> = {
  ignored: '已忽略',
  untracked: '未跟踪',
  modified: '已改动',
  mixed: '混合',
  plain: '整目录',
  tracked: '仓库自带',
  gitdir: 'Git 仓库',
}

/** 来源标记 → 标签颜色 */
export const KIND_COLOR: Record<string, string> = {
  ignored: 'blue',
  untracked: 'green',
  modified: 'orange',
  mixed: 'purple',
  plain: 'default',
  tracked: 'default',
  // 醒目一点：勾不勾它决定还原后的插件还能不能更新
  gitdir: 'red',
}

/** 任务阶段 → 中文 */
export const PHASE_TEXT: Record<string, string> = {
  collecting: '收集文件',
  packing: '打包中',
  cloning: '安装插件',
  extracting: '写入文件',
  installing: '安装依赖',
  done: '已完成',
  error: '出错了',
  canceled: '已取消',
}
