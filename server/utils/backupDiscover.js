import fs from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'

/**
 * 备份条目发现。
 *
 * 两层职责分开，别搞混：
 *
 * 1. **能勾什么 = 目录里有什么**。每个目标（Yunzai 根 / 每个插件）下的所有顶层目录和文件
 *    都会列出来，仓库自带的也列（标 `tracked`）—— 想整个带走就整个勾，这是用户的决定，
 *    不是 git 的。只有三类东西不列：`node_modules`（重装即得）、`logs`/`temp` 之类的
 *    缓存垃圾、`.git`（1.9 G 且清单里已记了 remote+commit，还原时 clone 回来）。
 * 2. **默认勾什么 = git 说了算**。用户的配置、数据、自备素材一律落在 `.gitignore` 里
 *    （实测 miao-plugin 的 `/config/cfg/`、xhh-TL 的 `config/config.yaml`、Yunzai 根的
 *    `/config/*` `/resources` 全都是），跑一遍 `git status --porcelain --ignored` 就能
 *    把它们全捞出来 —— 不用针对每个插件写死目录名，没装过的插件照样适配。
 *
 * git 的四类状态都算用户资产：
 * - `!!` 被 ignore：主要来源
 * - `??` 未跟踪：用户手放的文件（Yunzai 根的 `data/` 就是这类，TRSS 的 .gitignore 没写它）
 * - `M`  跟踪文件被改过：**必须二次过滤**，见 {@link filterRealModified}
 * - `D`  跟踪文件被删：只记账，不占备份体积
 *
 * 剩下的（clone 就有、也没动过的）标 `tracked`，列出来但不默认勾。
 */

/** 名字命中就整个跳过：缓存、依赖、编辑器杂物、core dump */
const SKIP_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'logs', 'log', 'temp', 'tmp', '.cache',
  '.DS_Store', 'Thumbs.db', '.idea', '.vscode',
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
/**
 * 「里面还有目录、拆开让人看清结构」的子项上限。
 *
 * 比 {@link MAX_DRILL_CHILDREN} 严得多：这条规则是为了让 `config` 这种小而有层次的目录
 * 在页面上点得开（看清里面有 `config` 和 `default_config` 两样东西），而不是把
 * `plugins/example` 那 40 个 js 拆成 40 行。
 */
const MAX_STRUCTURE_CHILDREN = 12

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

/**
 * 跑一遍 git status，得到「哪条路径是什么状态」。
 *
 * 只是**打标签**用的，不决定有哪些条目 —— 条目一律来自文件系统，见 {@link discoverTarget}。
 *
 * @return {Promise<{ok: boolean, marks: Map<string, string>, deleted: string[]}>}
 */
async function gitMarks(dir) {
  const res = await git(dir, gitArgs('status', '--porcelain', '--ignored'))
  if (!res.ok) return {ok: false, marks: new Map(), deleted: []}

  /** @type {Map<string, string>} rel → kind */
  const marks = new Map()
  const modifiedCandidates = []
  const deleted = []

  for (const raw of res.stdout.split('\n')) {
    const it = parseStatusLine(raw)
    if (!it) continue
    const {status, rel} = it
    if (isSkipped(rel)) continue
    if (status === '!!' || status === '??') {
      marks.set(rel, status === '!!' ? 'ignored' : 'untracked')
    } else if (status.includes('D')) {
      deleted.push(rel)
    } else if (status.includes('M') || status.includes('A') || status.includes('R')) {
      modifiedCandidates.push(rel)
    }
  }

  const realModified = await filterRealModified(dir, modifiedCandidates)
  for (const rel of realModified) {
    if (!isSkipped(rel)) marks.set(rel, 'modified')
  }
  return {ok: true, marks, deleted}
}

/**
 * 一个路径该标什么 kind。
 *
 * 四种情形，顺序不能换：
 * 1. git 直接点了这条路径 → 用它的状态
 * 2. 祖先被整体标了（`!! resources/`）→ 继承祖先，里面的东西都是同一类
 * 3. 目录里有被标记的子孙 → 单一种类就用它，多种就是 `mixed`
 * 4. 都没有 → `tracked`，clone 就有的东西
 */
function markOf(rel, marks, isDir) {
  if (!marks.size) return 'plain'
  if (marks.has(rel)) return marks.get(rel)

  const parts = rel.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const anc = parts.slice(0, i).join('/')
    if (marks.has(anc)) return marks.get(anc)
  }

  if (isDir) {
    const prefix = `${rel}/`
    const kinds = new Set()
    for (const [k, v] of marks) {
      if (k.startsWith(prefix)) kinds.add(v)
    }
    if (kinds.size === 1) return [...kinds][0]
    if (kinds.size > 1) return 'mixed'
  }
  return 'tracked'
}

/**
 * 目标目录里能备份的东西。
 *
 * **条目一律来自文件系统，不是来自 git。** 之前反过来干过一次，代价很惨：git 只报它关心
 * 的路径，`GloryOfKings-Plugin` 的 `.gitignore` 写了 `config/config/*`，于是条目名叫
 * `config` 而实际只装了 `config/config`，`config/default_config/` 从来没进过包 —— 用户
 * 勾了「config」，还原完插件却因为缺 `default_config` 起不来。
 *
 * 所以现在：**一个条目就是一个真实路径**（一个文件，或一整个目录，`paths` 永远是 `[rel]`），
 * 勾了就是勾整个，不会漏。git 只负责给条目打 kind、决定要不要默认勾上。
 *
 * @param {string} dir 目标目录绝对路径
 * @param {object} opts
 * @param {string} opts.prefix key 前缀，`root` 或 `plugin:<name>`
 * @param {Set<string>} [opts.excludes] 要跳过的绝对路径
 * @param {boolean} [opts.splitPlugins] 根目录用：把 `plugins/<name>` 挑出来交给插件流程
 * @return {Promise<{isRepo: boolean, entries: object[], pluginDirs: string[], deleted: string[]}>}
 */
export async function discoverTarget(dir, {prefix, excludes = new Set(), splitPlugins = false} = {}) {
  const isRepo = isGitRepo(dir)
  const {ok, marks, deleted} = isRepo ? await gitMarks(dir) : {ok: false, marks: new Map(), deleted: []}
  const entries = []
  const pluginDirs = []
  const ctx = {dir, prefix, marks, excludes}

  for (const name of listChildren(dir, excludes)) {
    if (splitPlugins && name === 'plugins' && isDirectory(path.join(dir, 'plugins'))) {
      for (const sub of listChildren(path.join(dir, 'plugins'), excludes)) {
        const rel = `plugins/${sub}`
        if (isPluginDir(path.join(dir, 'plugins', sub), rel, marks)) {
          pluginDirs.push(sub)
          continue
        }
        // Yunzai 自带的 adapter / system / other 这些属于 Bot 本体，留作根条目
        entries.push(...buildEntries({...ctx, rel}))
      }
      continue
    }
    entries.push(...buildEntries({...ctx, rel: name}))
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  return {isRepo: isRepo && ok, entries, pluginDirs, deleted}
}

/**
 * `plugins/<name>` 是独立安装的插件，还是 Yunzai 自带的目录？
 *
 * 有 `.git` 的一定是插件。没有 `.git` 的看根仓库怎么看它：被 ignore 或未跟踪说明是用户
 * 自己弄进来的（手动解压装的插件，实测 `douyin-sticker-plugin`、`plugins/example` 都是
 * 这种）；被跟踪的就是 Yunzai 自带的（`adapter` / `system` / `other`）。
 */
function isPluginDir(abs, rel, marks) {
  if (isGitRepo(abs)) return true
  const mark = markOf(rel, marks, true)
  return mark === 'ignored' || mark === 'untracked'
}

/**
 * 非 git 的目录（手动解压安装的插件，实测本机 `douyin-sticker-plugin` 就是）。
 *
 * 拿不到 status，分不出「用户资产」和「仓库自带」—— 但这种插件本来也没有仓库能还原，
 * 整个目录都得带走。列出每一项让用户能挑，体积不大的默认勾上。
 */
export function discoverPlain(dir, {prefix, excludes = new Set()} = {}) {
  const entries = []
  const ctx = {dir, prefix, marks: new Map(), excludes}
  for (const name of listChildren(dir, excludes)) {
    entries.push(...buildEntries({...ctx, rel: name}))
  }
  // 空目录也给一条，否则这一组连个能勾的都没有
  if (!entries.length) {
    return [{
      key: `${prefix}|.`, rel: '.', paths: ['.'], kind: 'plain',
      size: 0, files: 0, truncated: false, recommended: false,
    }]
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  return entries
}

/**
 * 一个路径 → 条目。必要时往下拆成子条目。
 *
 * 两种情况会拆：
 * - **太大**：`data` 3.3 G 不拆的话用户只能被迫全选，拆开才能只挑 `data/PlayerData`
 * - **里面还有目录**：这样页面上点开就能看清「这个 config 里到底有 config 和 default_config
 *   两样东西」，不用猜。子项太多的不拆（`plugins/example` 那 40 个 js 拆开只会刷屏）
 *
 * 无论拆不拆，每个条目都是一个完整的真实路径，勾了就是整个拿走。
 */
function buildEntries({dir, prefix, rel, marks, excludes, drilled = 0}) {
  const abs = path.join(dir, rel)
  const isDir = isDirectory(abs)
  const {size, files, truncated} = measure(abs, excludes)

  // 名字像缓存的不拆 —— `data/puppeteer` 是 Chrome 的 profile 目录，拆开是 30 多个
  // 各自只有几百 K 的子目录，每个都能过体积阈值，于是 615M 缓存全被默认勾上
  if (isDir && drilled < MAX_DRILL_DEPTH && !isCacheName(rel)) {
    const children = listChildren(abs, excludes)
    const tooBig = size > DRILL_SIZE || truncated
    const hasSubDirs = children.some((n) => isDirectory(path.join(abs, n)))
    const worthShowing = hasSubDirs && children.length <= MAX_STRUCTURE_CHILDREN
    if (children.length > 1 && children.length <= MAX_DRILL_CHILDREN && (tooBig || worthShowing)) {
      return children.flatMap((name) => buildEntries({
        dir, prefix, rel: `${rel}/${name}`, marks, excludes, drilled: drilled + 1,
      }))
    }
  }

  const kind = markOf(rel, marks, isDir)
  return [{
    key: `${prefix}|${rel}`,
    rel,
    // 永远是单个真实路径：勾了它就是把这个文件 / 这整个目录拿走，不会只拿一部分
    paths: [rel],
    kind,
    size,
    files,
    truncated,
    recommended: recommend({rel, size, files, truncated, kind}),
  }]
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
  // 仓库自带、也没动过的：clone 就有，不默认勾 —— 但列出来了，想整个带走随时能勾
  if (kind === 'tracked') return false
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
