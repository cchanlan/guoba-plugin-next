/**
 * 插件页里跟 git 有关的几处文案工具。
 * 抽出来是因为插件卡片和更新日志弹窗要显示同样的东西，两边各写一份很容易改歪。
 */

/** 相对时间，用来显示「上次检查」 */
export function sinceText(ms: number) {
  if (!ms) return '从未检查'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚检查过'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前检查`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前检查`
  return `${Math.floor(diff / 86400_000)} 天前检查`
}

/**
 * 两个 hash 是不是同一个提交。
 * git 各处给的缩写长度不一样（`git log %h` 和 `rev-parse --short` 各算一次，回滚记录里又是完整
 * hash），所以只能比前缀，不能直接 `===`。
 */
export function sameCommit(a?: string, b?: string) {
  if (!a || !b) return false
  return a.startsWith(b) || b.startsWith(a)
}
