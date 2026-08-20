import path from 'node:path'
import fs from 'node:fs'

/**
 * 目录递归遍历。文件管理里「算文件夹大小」和「打包下载文件夹」都要把一棵子树走完，
 * 遍历规则必须一致，所以抽在这里。
 *
 * 两条硬规则：
 * 1. **不跟随符号链接**（用 readdir 的 dirent 判断，不 stat 目标）。跟随了既可能绕出
 *    Yunzai 根，也可能在 `node_modules/.bin` 这种自指链接上转圈。
 * 2. 全程异步 + 显式栈。node_modules 动辄十万文件，同步递归会把 express 卡死，
 *    深递归还会爆栈。
 */

/** 算大小的兜底：最多走这么多条目 */
const DEFAULT_ENTRY_LIMIT = 500000
/** 算大小的兜底：最多走这么久（毫秒） */
const DEFAULT_TIME_LIMIT = 20000

/**
 * 遍历目录，逐个产出条目（深度优先，同目录内文件夹和文件按 readdir 顺序）。
 *
 * @param {string} root 起点绝对路径
 * @param {object} [opts]
 * @param {number} [opts.entryLimit] 条目上限，超了就停（配 onTruncate 用）
 * @param {number} [opts.timeLimit] 时间上限（毫秒），超了就停
 * @param {() => void} [opts.onTruncate] 因为超限提前收尾时调一次
 * @returns {AsyncGenerator<{rel: string, abs: string, isDir: boolean, size: number, mtimeMs: number, mode: number}>}
 *   rel 是相对 root 的 posix 风格路径（root 自身不产出）
 */
export async function* walkDir(root, opts = {}) {
  const entryLimit = opts.entryLimit ?? Infinity
  const timeLimit = opts.timeLimit ?? Infinity
  const deadline = Number.isFinite(timeLimit) ? Date.now() + timeLimit : Infinity

  let count = 0
  /** 待处理目录栈，元素是 {abs, rel} */
  const stack = [{abs: root, rel: ''}]

  while (stack.length) {
    const dir = stack.pop()
    let dirents
    try {
      dirents = await fs.promises.readdir(dir.abs, {withFileTypes: true})
    } catch {
      // 没权限 / 遍历途中被删，跳过整个目录
      continue
    }
    // 反着入栈，出栈顺序才跟 readdir 一致
    const subDirs = []
    for (const dirent of dirents) {
      if (count >= entryLimit || Date.now() > deadline) {
        opts.onTruncate?.()
        return
      }
      // 符号链接（含指向目录的）一概跳过，理由见文件头
      if (dirent.isSymbolicLink()) continue
      const isDir = dirent.isDirectory()
      // 设备文件 / 管道 / socket 不是要备份的东西，也没有有意义的大小
      if (!isDir && !dirent.isFile()) continue

      const abs = path.join(dir.abs, dirent.name)
      const rel = dir.rel ? `${dir.rel}/${dirent.name}` : dirent.name
      let stat
      try {
        stat = await fs.promises.lstat(abs)
      } catch {
        continue
      }
      count++
      yield {
        rel,
        abs,
        isDir,
        size: isDir ? 0 : stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
      }
      if (isDir) subDirs.push({abs, rel})
    }
    for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i])
  }
}

/**
 * 统计目录占用。
 *
 * @param {string} abs 目录绝对路径
 * @param {object} [opts] entryLimit / timeLimit，见 walkDir
 * @returns {Promise<{size: number, files: number, dirs: number, partial: boolean}>}
 *   partial = true 说明撞上了上限，数字是不完整的（前端要标出来，别当准数）
 */
export async function dirStats(abs, opts = {}) {
  let size = 0
  let files = 0
  let dirs = 0
  let partial = false
  const walkOpts = {
    entryLimit: opts.entryLimit ?? DEFAULT_ENTRY_LIMIT,
    timeLimit: opts.timeLimit ?? DEFAULT_TIME_LIMIT,
    onTruncate: () => {
      partial = true
    },
  }
  for await (const entry of walkDir(abs, walkOpts)) {
    if (entry.isDir) {
      dirs++
    } else {
      files++
      size += entry.size
    }
  }
  return {size, files, dirs, partial}
}
