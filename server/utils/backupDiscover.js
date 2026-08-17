import fs from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'

/**
 * 备份条目发现。
 *
 * 核心思路：**「用户资产」和「仓库自带」的边界，git 自己就知道**。Yunzai 根和几乎所有插件
 * 都是 git 仓库，用户的配置、数据、自备素材一律落在 `.gitignore` 里（实测 miao-plugin 的
 * `/config/cfg/`、xhh-TL 的 `config/config.yaml`、Yunzai 根的 `/config/*` `/resources`
 * 全都是），所以跑一遍 `git status --porcelain --ignored` 就能把它们全捞出来 —— 不需要
 * 针对每个插件写死目录名，没装过的插件也照样适配。
 *
 * 四类状态都算用户资产：
 * - `!!` 被 ignore：主要来源
 * - `??` 未跟踪：用户手放的文件（Yunzai 根的 `data/` 就是这类，TRSS 的 .gitignore 没写它）
 * - `M`  跟踪文件被改过：**必须二次过滤**，见 {@link filterRealModified}
 * - `D`  跟踪文件被删：只记账，不占备份体积
 */

/** 名字命中就整个跳过：缓存、依赖、编辑器杂物、core dump */
const SKIP_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'logs', 'log', 'temp', 'tmp', '.cache',
  '.DS_Store', 'Thumbs.db', '.idea', '.vscode',
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'core', 'dump.core',
])

/** 后缀命中就跳过 */
const SKIP_EXT = new Set(['.log', '.swp', '.pyc', '.pid', '.sock'])

/** 目录名像缓存的：仍然列出来（用户也许真想备份），但默认不勾 */
const CACHE_RE = /(^|[-_.])(temp|tmp|cache|caches|puppeteer|screenshot|screenshots|thumb|thumbs)([-_.]|$)|cache|temp/i

/** 默认勾选的体积 / 文件数上限 —— 超过就只列出不勾，让用户自己决定 */
const RECOMMEND_MAX_SIZE = 20 * 1024 * 1024
const RECOMMEND_MAX_FILES = 2000

/** 条目超过这个体积就展开一层子项，让用户能按子目录挑（`data/` 3.3G 就靠这个拆开） */
const DRILL_SIZE = 20 * 1024 * 1024
/** 最多下钻几层 */
const MAX_DRILL_DEPTH = 2
/** 子项太多就别拆了，UI 上一屏几百个复选框没法用 */
const MAX_DRILL_CHILDREN = 60

/** git 地址里的 `user:token@` —— 备份包会被下载甚至转发，绝不能带出去 */
const CREDENTIAL_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i
/** GitHub 反代前缀：`https://<代理域名>/https://github.com/...` */
const PROXY_PREFIX_RE = /^https?:\/\/[^/]+\/(?=https?:\/\/)/i

/** 体积统计的上限：到这就停下并标 truncated，不然 `resources/bf`（3.3G）能把 scan 拖死 */
const STAT_MAX_FILES = 5000
const STAT_MAX_BYTES = 200 * 1024 * 1024

/** git 命令超时，仓库再大也该够了 */
const GIT_TIMEOUT = 60 * 1000

/**
 * 跑 git。
 *
 * 不复用 `GitTools.exec` —— 那个是给「带 name / repository 的仓库对象」用的实例方法，走
 * shell 拼字符串且 maxBuffer 是默认值；这里要的是不过 shell（路径里有空格和中文）、指定
 * cwd、输出可能上万行。
 *
 * @return {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout: GIT_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo'},
    }, (error, stdout, stderr) => {
      resolve({ok: !error, stdout: stdout || '', stderr: stderr || ''})
    })
  })
}

/**
 * 两个 `-c` 都不能省：
 *
 * - `core.quotepath=false`：默认 git 会把中文路径转成八进制转义再加引号
 *   （`plugins/example/` 下几十个中文名 js 全是那个形态），不关掉就得自己反转义。
 * - `core.fileMode=false`：让 git 忽略权限位差异。解压安装会把整个仓库的 100644 变成
 *   100755，不关掉的话 git 把每个文件都报成 modified —— 实测 xiaoyao-cvs-plugin 有
 *   2007 个这种假 modified（750M 的 resources 全在里面），Yunzai 根有 71 个。
 *   而且这些多半是二进制图片，`diff --numstat` 只给 `-  -`，事后没法区分真假。
 */
function gitArgs(...args) {
  return ['-c', 'core.quotepath=false', '-c', 'core.fileMode=false', '--no-optional-locks', ...args]
}

/**
 * 清洗 git 远程地址，让它能安全写进备份包。
 *
 * 两件事：
 * 1. **摘掉嵌在 URL 里的凭证**。实测本机就有 `https://user:token@gitcode.com/...` 这种
 *    remote —— 备份包是要下载、可能转发给别人的，token 跟着走出去就等于泄露。
 * 2. **剥掉 GitHub 反代前缀**（`https://api.fate.vip/https://github.com/...`）。代理是
 *    本机网络环境的产物，换台机器该用那台机器自己配的代理，所以清单里只存原始地址，
 *    还原时再按 `base.githubReverseProxy` 重新拼。顺带让白名单校验能正常工作 ——
 *    代理域名本来不在白名单里。
 */
export function sanitizeRemote(url) {
  let out = String(url || '').trim()
  if (!out) return ''
  out = out.replace(PROXY_PREFIX_RE, '')
  out = out.replace(CREDENTIAL_RE, '$1')
  return out
}

/** 是不是 git 仓库 */
export function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'))
}

/** 路径的任一段命中黑名单就跳过 */
function isSkipped(rel) {
  const parts = rel.split('/').filter(Boolean)
  for (const seg of parts) {
    if (shouldSkipName(seg)) return true
  }
  return false
}

/**
 * 单个文件/目录名要不要跳过。
 *
 * 打包时也用这一套，否则勾了 `plugins/example` 就会把它 56 M 的 node_modules 打进去 ——
 * 扫描说「这条 510 K」，打包却塞了 56 M，两边必须同一个判断。
 */
export function shouldSkipName(name) {
  if (SKIP_NAMES.has(name)) return true
  return SKIP_EXT.has(path.extname(name).toLowerCase())
}

/**
 * 递归量体积。
 *
 * 带上限：文件数或字节数触顶就返回 `truncated`，页面上显示成「> 200 MB」。备份目录本身
 * （`data/guoba/backups`）通过 excludes 排除，否则备份会把上一次的包卷进来。
 *
 * @param {string} abs 目标绝对路径
 * @param {Set<string>} [excludes] 要跳过的绝对路径
 * @return {{size: number, files: number, truncated: boolean}}
 */
export function measure(abs, excludes = new Set()) {
  let size = 0
  let files = 0
  let truncated = false
  let st
  try {
    st = fs.lstatSync(abs)
  } catch {
    return {size: 0, files: 0, truncated: false}
  }
  if (st.isSymbolicLink()) return {size: 0, files: 0, truncated: false}
  if (st.isFile()) return {size: st.size, files: 1, truncated: false}
  if (!st.isDirectory()) return {size: 0, files: 0, truncated: false}

  const stack = [abs]
  while (stack.length) {
    if (files >= STAT_MAX_FILES || size >= STAT_MAX_BYTES) {
      truncated = true
      break
    }
    const dir = stack.pop()
    let items
    try {
      items = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      continue
    }
    for (const it of items) {
      const child = path.join(dir, it.name)
      if (excludes.has(child)) continue
      if (shouldSkipName(it.name)) continue
      // symlink 不跟随，免得转圈
      if (it.isSymbolicLink()) continue
      if (it.isDirectory()) {
        stack.push(child)
      } else if (it.isFile()) {
        files++
        try {
          size += fs.statSync(child).size
        } catch {
          // 读不到就算 0
        }
      }
    }
  }
  return {size, files, truncated}
}

/**
 * 从 `M` 里挑出真有内容改动的。
 *
 * 实测 Yunzai 根有 79 个 `M`，其中 71 个是假的 —— `core.fileMode=true` 加上解压安装，
 * 整个 Bot 本体的权限位从 100644 变成了 100755，git 报 modified 但 `git diff --stat`
 * 是 `0 insertions(+), 0 deletions(-)`。不过滤的话备份包里会多出整个 Yunzai 源码。
 *
 * `--numstat` 对纯 mode 变化输出 `0\t0\tpath`，对二进制输出 `-\t-\tpath`（要保留）。
 *
 * @return {Promise<Set<string>>} 真改动的相对路径
 */
async function filterRealModified(dir, candidates) {
  if (!candidates.length) return new Set()
  // 比 HEAD 而不是 index，这样 staged 的改动也算进来
  const res = await git(dir, gitArgs('diff', 'HEAD', '--numstat'))
  if (!res.ok) return new Set(candidates)
  const real = new Set()
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^(\S+)\t(\S+)\t(.+)$/)
    if (!m) continue
    const [, add, del, file] = m
    // 二进制是 `-  -`，一定保留；文本两边都是 0 就是纯 mode 变化
    if (add === '-' || del === '-' || add !== '0' || del !== '0') real.add(file.trim())
  }
  return new Set(candidates.filter((c) => real.has(c)))
}

/**
 * 解析 `git status --porcelain` 的一行。
 * @return {{status: string, rel: string, isDir: boolean}|null}
 */
function parseStatusLine(line) {
  if (line.length < 4) return null
  const status = line.slice(0, 2)
  let rel = line.slice(3).trim()
  if (!rel) return null
  // 重命名是 `old -> new`，只取新名
  const arrow = rel.indexOf(' -> ')
  if (arrow !== -1) rel = rel.slice(arrow + 4)
  // quotepath 关了还带引号的情况（名字里有引号 / 换行），去掉外层引号
  if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1)
  const isDir = rel.endsWith('/')
  return {status, rel: isDir ? rel.slice(0, -1) : rel, isDir}
}

/** 一条候选路径 → 归并用的分组键。`plugins/` 下取两段，其他取一段 */
function groupKey(rel, groupDepth) {
  const parts = rel.split('/')
  return parts.slice(0, groupDepth(parts)).join('/')
}
/**
 * 目标目录里的用户资产。
 *
 * @param {string} dir 目标目录绝对路径
 * @param {object} opts
 * @param {string} opts.prefix key 前缀，`root` 或 `plugin:<name>`
 * @param {Set<string>} [opts.excludes] 要跳过的绝对路径
 * @param {boolean} [opts.splitPlugins] 根目录用：把 `plugins/<name>/` 目录形态的条目单独挑出来
 * @return {Promise<{isRepo: boolean, entries: object[], pluginDirs: string[], deleted: string[]}>}
 */
export async function discoverTarget(dir, {prefix, excludes = new Set(), splitPlugins = false} = {}) {
  if (!isGitRepo(dir)) {
    return discoverFlat(dir, {prefix, excludes, splitPlugins})
  }
  const res = await git(dir, gitArgs('status', '--porcelain', '--ignored'))
  if (!res.ok) {
    return discoverFlat(dir, {prefix, excludes, splitPlugins})
  }

  /** @type {Map<string, string>} rel → kind */
  const found = new Map()
  const modifiedCandidates = []
  const deleted = []
  const pluginDirs = []

  for (const raw of res.stdout.split('\n')) {
    const it = parseStatusLine(raw)
    if (!it) continue
    const {status, rel, isDir} = it
    if (isSkipped(rel)) continue

    // git 把「整个目录都未跟踪」聚合成最上层一条 `?? plugins/`（根仓库的 .gitignore 里
    // 没有 plugins 相关规则时就是这样，非 TRSS 的分支有这种），这时得自己展开一层，
    // 否则所有插件会被并成一个几 G 的 `plugins` 条目
    if (splitPlugins && isDir && rel === 'plugins') {
      for (const name of listChildren(path.join(dir, 'plugins'), excludes)) {
        if (isDirectory(path.join(dir, 'plugins', name))) pluginDirs.push(name)
        else found.set(`plugins/${name}`, status === '!!' ? 'ignored' : 'untracked')
      }
      continue
    }

    // `plugins/<name>/` 目录形态 = 独立安装的插件，交给插件流程单独处理；
    // `plugins/<name>/<file>` 文件形态 = 用户往 Yunzai 自带目录（other / example）里
    // 加的东西，留在这里当根条目 —— 原先想整个排除 plugins/，那样就会漏掉它们
    if (splitPlugins && isDir && /^plugins\/[^/]+$/.test(rel)) {
      pluginDirs.push(rel.slice('plugins/'.length))
      continue
    }

    if (status === '!!' || status === '??') {
      found.set(rel, status === '!!' ? 'ignored' : 'untracked')
    } else if (status.includes('D')) {
      deleted.push(rel)
    } else if (status.includes('M') || status.includes('A') || status.includes('R')) {
      modifiedCandidates.push(rel)
    }
  }

  const realModified = await filterRealModified(dir, modifiedCandidates)
  for (const rel of realModified) {
    if (!isSkipped(rel)) found.set(rel, 'modified')
  }

  // 归并：git 的粒度靠不住 —— 目录里只要有一个被跟踪的文件，它就展开逐条列
  // （`temp/` 因为 temp/.gitignore 被跟踪展开成 110 多条，`config/` 因为
  //  !/config/default_config 例外散成好几条），所以按顶层路径段自己归并一次
  const groupDepth = splitPlugins
    ? (parts) => (parts[0] === 'plugins' && parts.length > 1 ? 2 : 1)
    : () => 1
  /** @type {Map<string, {paths: string[], kinds: Set<string>}>} */
  const groups = new Map()
  for (const [rel, kind] of found) {
    const key = groupKey(rel, groupDepth)
    let g = groups.get(key)
    if (!g) groups.set(key, (g = {paths: [], kinds: new Set()}))
    g.paths.push(rel)
    g.kinds.add(kind)
  }

  const entries = []
  for (const [rel, g] of groups) {
    // 整个目录就是一个条目时不必再记成员，打包时直接收整个目录
    const paths = g.paths.length === 1 && g.paths[0] === rel ? [rel] : g.paths.sort()
    entries.push(...buildEntries({
      dir, prefix, rel, paths, kinds: g.kinds, excludes,
      depth: rel.split('/').length,
    }))
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  return {isRepo: true, entries, pluginDirs, deleted}
}

/**
 * 非 git 的目录（手动解压安装的插件，实测本机 `douyin-sticker-plugin` 就是）：
 * 拿不到 status，只能整目录当一个条目，靠黑名单去掉 node_modules 之类。
 */
export function discoverPlain(dir, {prefix, rel = '', excludes = new Set()} = {}) {
  const {size, files, truncated} = measure(dir, excludes)
  return [{
    key: `${prefix}|.`,
    rel: rel || '.',
    paths: ['.'],
    kind: 'plain',
    size,
    files,
    truncated,
    recommended: !truncated && size <= RECOMMEND_MAX_SIZE && files <= RECOMMEND_MAX_FILES,
  }]
}

/**
 * 一组路径按下一个路径段再分开。
 *
 * 只要有任何一条路径本身就等于当前条目（`paths = ['data']`），就返回 null —— 那种情况
 * 得读文件系统才知道下一层有什么。
 *
 * @return {Map<string, string[]>|null} 子条目路径 → 归它的成员
 */
function splitByNextSegment(paths, depth) {
  const map = new Map()
  for (const p of paths) {
    const parts = p.split('/')
    if (parts.length <= depth) return null
    const child = parts.slice(0, depth + 1).join('/')
    let list = map.get(child)
    if (!list) map.set(child, (list = []))
    list.push(p)
  }
  return map
}

/**
 * 一组路径 → 条目。体积超标的会继续往下拆，直到够小或到 {@link MAX_DRILL_DEPTH} 层。
 *
 * 拆分有两条路子：git 给的路径本身够细时按路径段分（`data` 那 31 条子路径就是），
 * 只给了一个目录名时读一层目录。前者是主要情形 —— 只要目录里有任何被跟踪的文件，
 * git 就会展开逐条列，反而帮了忙。
 */
function buildEntries({dir, prefix, rel, paths, kinds, excludes, depth = 1, drilled = 0}) {
  let size = 0
  let files = 0
  let truncated = false
  for (const p of paths) {
    const m = measure(path.join(dir, p), excludes)
    size += m.size
    files += m.files
    truncated = truncated || m.truncated
  }

  // 大目录拆成子条目，让用户能只挑 data/PlayerData 而不是被 3.2G 的 data 逼着全选。
  // 名字像缓存的不拆 —— `data/puppeteer` 是 Chrome 的 profile 目录，拆开是 30 多个
  // 各自只有几百 K 的子目录，每个都能过体积阈值，于是 615M 缓存全被默认勾上
  if (drilled < MAX_DRILL_DEPTH && (size > DRILL_SIZE || truncated) && !isCacheName(rel)) {
    let children = splitByNextSegment(paths, depth)
    if (!children && paths.length === 1 && paths[0] === rel && isDirectory(path.join(dir, rel))) {
      children = new Map(listChildren(path.join(dir, rel), excludes)
        .map((name) => [`${rel}/${name}`, [`${rel}/${name}`]]))
    }
    if (children && children.size > 1 && children.size <= MAX_DRILL_CHILDREN) {
      const out = []
      for (const [childRel, childPaths] of children) {
        out.push(...buildEntries({
          dir, prefix, rel: childRel, paths: childPaths, kinds, excludes,
          depth: depth + 1, drilled: drilled + 1,
        }))
      }
      return out
    }
  }

  const kind = kinds.size === 1 ? [...kinds][0] : 'mixed'
  return [{
    key: `${prefix}|${rel}`,
    rel,
    paths: paths.length === 1 && paths[0] === rel ? [rel] : paths,
    kind,
    size,
    files,
    truncated,
    recommended: recommend({rel, size, files, truncated, kind}),
  }]
}

/**
 * 非 git 目录的降级发现：扫一层，剩下的每项按同一套规则做条目。
 *
 * Yunzai 根不是 git 仓库时走这里（下载 zip 解压装的、或者 .git 被删了、仓库损坏）。
 * 没有 git 帮忙区分「用户资产」和「仓库自带」，只能把整层都列出来 —— 会多出 `lib/`、
 * `renderers/` 这类 clone 就有的东西，体积都不大，用户自己取消勾选即可。总比一条都
 * 扫不出来、整个 Bot 本体没法备份要好。大目录照样会自动下钻，缓存名照样不默认勾。
 */
function discoverFlat(dir, {prefix, excludes = new Set(), splitPlugins = false} = {}) {
  const entries = []
  const pluginDirs = []
  const add = (rel, depth) => entries.push(...buildEntries({
    dir, prefix, rel, paths: [rel], kinds: new Set(['plain']), excludes, depth,
  }))

  for (const name of listChildren(dir, excludes)) {
    if (isSkipped(name)) continue
    // plugins/ 下的子目录是插件，交给插件流程；散文件（用户往自带目录里加的）留作根条目
    if (splitPlugins && name === 'plugins' && isDirectory(path.join(dir, 'plugins'))) {
      for (const sub of listChildren(path.join(dir, 'plugins'), excludes)) {
        if (isDirectory(path.join(dir, 'plugins', sub))) pluginDirs.push(sub)
        else add(`plugins/${sub}`, 2)
      }
      continue
    }
    add(name, 1)
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  return {isRepo: false, entries, pluginDirs, deleted: []}
}

function isDirectory(abs) {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/** 目录下的一级子项名（已过黑名单和 excludes） */
function listChildren(abs, excludes) {
  try {
    return fs.readdirSync(abs, {withFileTypes: true})
      .filter((it) => !shouldSkipName(it.name) && !it.isSymbolicLink()
        && !excludes.has(path.join(abs, it.name)))
      .map((it) => it.name)
      .sort()
  } catch {
    return []
  }
}

/** 末段名字像不像缓存 */
function isCacheName(rel) {
  return CACHE_RE.test(rel.split('/').pop() || rel)
}

/**
 * 默认要不要勾。
 *
 * 只看体积 / 文件数 / 名字像不像缓存，不认插件名 —— 这样对没装过的插件一样适用。
 * 真改动的跟踪文件（过滤掉权限位噪声之后）体积必然很小，总是勾上。
 */
function recommend({rel, size, files, truncated, kind}) {
  if (kind === 'modified') return true
  if (isCacheName(rel)) return false
  if (truncated) return false
  return size <= RECOMMEND_MAX_SIZE && files <= RECOMMEND_MAX_FILES
}

export const DISCOVER_LIMITS = {
  RECOMMEND_MAX_SIZE,
  RECOMMEND_MAX_FILES,
  DRILL_SIZE,
  STAT_MAX_FILES,
  STAT_MAX_BYTES,
}

/** 给 BackupService 用：仓库信息（还原时按这个 clone） */
export async function repoInfo(dir) {
  if (!isGitRepo(dir)) return {git: false}
  const [remote, branch, commit, status] = await Promise.all([
    git(dir, gitArgs('remote', 'get-url', 'origin')),
    git(dir, gitArgs('rev-parse', '--abbrev-ref', 'HEAD')),
    git(dir, gitArgs('rev-parse', 'HEAD')),
    git(dir, gitArgs('status', '--porcelain')),
  ])
  return {
    git: true,
    // 一定要过 sanitizeRemote：这个值会写进 manifest，也会显示在页面上
    remote: remote.ok ? sanitizeRemote(remote.stdout) : '',
    branch: branch.ok ? branch.stdout.trim() : '',
    commit: commit.ok ? commit.stdout.trim().slice(0, 12) : '',
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  }
}

export {git as runGit, gitArgs}
