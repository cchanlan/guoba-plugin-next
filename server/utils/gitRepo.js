import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'

/**
 * git 仓库操作（插件更新用）。
 *
 * 全部走 `spawn` + 参数数组，不拼 shell 字符串 —— 插件目录名是用户可控的（`plugins/` 下随便
 * 叫什么），拼进 shell 就是命令注入。
 *
 * 另一个必须做的事是**掐掉 git 的交互提示**：私有仓库或链接失效时，git 会停在那儿等用户名密码，
 * 面板上就表现为「更新卡死」。所以每条命令都带 `GIT_TERMINAL_PROMPT=0` 等环境变量，让它直接失败。
 */

/** 单条 git 命令的默认超时（毫秒）。fetch 慢，但不能无限等 */
const DEFAULT_TIMEOUT = 120000

/** 记录里最多带回多少条提交，够看更新了什么就行 */
const MAX_LOG = 30

/** 日志字段分隔符：用不可打印字符，提交信息里出现不了 */
const SEP = '\x1f'

/** 让 git 绝不弹交互提示的环境变量 */
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GCM_INTERACTIVE: 'never',
    // 输出不要按语言变，解析时才稳
    LC_ALL: 'C',
    LANG: 'C',
  }
}

/**
 * 跑一条 git 命令。
 * @param {string[]} args 参数数组，不含 `git`
 * @param {object} opts
 * @param {string} opts.cwd 仓库目录
 * @param {number} [opts.timeout] 毫秒，超时会杀掉进程
 * @param {(line: string) => void} [opts.onLine] 有输出就回调一行，给任务日志用
 * @param {(child: import('node:child_process').ChildProcess) => void} [opts.onSpawn] 进程起来时回调，
 *   调用方要能在「取消任务」时把它杀掉
 * @return {Promise<{ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runGit(args, {cwd, timeout = DEFAULT_TIMEOUT, onLine, onSpawn} = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {cwd, windowsHide: true, env: gitEnv()})
    onSpawn?.(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)

    const feed = (buf, isErr) => {
      const text = String(buf)
      if (isErr) stderr += text
      else stdout += text
      if (!onLine) return
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (t) onLine(t)
      }
    }
    child.stdout?.on('data', (b) => feed(b, false))
    child.stderr?.on('data', (b) => feed(b, true))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ok: false, code: -1, stdout, stderr: stderr || err.message, timedOut})
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        code: code ?? -1,
        stdout,
        stderr: timedOut ? `${stderr}\n命令超时（${timeout / 1000}s）已终止` : stderr,
        timedOut,
      })
    })
  })
}

/** 是不是一个 git 工作区（`.git` 可能是文件 —— worktree / submodule 的指针） */
export function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/** `git log` 的一条。解析单独抽出来是为了能不建仓库就测 */
export function parseLogLines(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const [hash, author, date, ...rest] = line.split(SEP)
    if (!hash) continue
    out.push({hash, author: author ?? '', date: date ?? '', subject: rest.join(SEP) ?? ''})
  }
  return out
}

/** `git rev-list --left-right --count A...B` 的输出：`ahead\tbehind` */
export function parseAheadBehind(stdout) {
  const m = String(stdout ?? '').trim().match(/^(\d+)\s+(\d+)$/)
  if (!m) return {ahead: 0, behind: 0}
  return {ahead: Number(m[1]), behind: Number(m[2])}
}

/**
 * `git status --porcelain` → 本地改动摘要。
 * 未跟踪文件（`??`）单独记：插件目录里常有用户自己塞的资源、日志，它们不影响 ff-only 更新，
 * 不该因为这些就把插件判成「有改动、不能更新」。
 */
export function parseStatus(stdout) {
  const changed = []
  const untracked = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const file = line.slice(3).trim()
    if (code === '??') untracked.push(file)
    else changed.push({code: code.trim(), file})
  }
  return {changed, untracked, dirty: changed.length > 0}
}

/**
 * 读一个仓库的本地状态。**不联网**，behind 是拿本地已有的远端引用算的 ——
 * 想要准数得先 {@link fetchRepo}，页面上因此要显示「上次检查时间」。
 *
 * @param {string} dir 仓库目录
 * @return {Promise<object>} 见下面的字段；`updatable` 为 false 时 `reason` 说明原因
 */
export async function readRepoInfo(dir) {
  const base = {
    isRepo: false, branch: '', detached: false, commit: '', shortCommit: '',
    upstream: '', remote: '', remoteUrl: '', ahead: 0, behind: 0,
    dirty: false, changed: [], untracked: [], updatable: false, reason: '',
  }
  if (!isGitRepo(dir)) return {...base, reason: '不是 git 仓库，只能手动覆盖更新'}

  // 分支名。detached 时 git 会输出字面量 "HEAD"
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {cwd: dir, timeout: 15000})
  if (!branchRes.ok) {
    // `.git` 在但读不出 HEAD：刚 init 还没提交、或者仓库损坏。是仓库，只是不能更新
    return {
      ...base,
      isRepo: true,
      reason: `git 读不出状态（可能还没有任何提交）：${firstLine(branchRes.stderr) || '未知错误'}`,
    }
  }
  // 完整 + 短 hash 一次拿：--short 只对它后面那个 rev 生效（--abbrev-ref 相反，是全局开关，
  // 放一起会把三个参数全输出成分支名）
  const hashRes = await runGit(['rev-parse', 'HEAD', '--short', 'HEAD'], {cwd: dir, timeout: 15000})
  const [commit = '', shortCommit = ''] = hashRes.ok ? hashRes.stdout.trim().split(/\r?\n/) : []
  const branchRaw = branchRes.stdout.trim()
  const detached = !branchRaw || branchRaw === 'HEAD'
  const info = {
    ...base,
    isRepo: true,
    branch: detached ? '' : branchRaw,
    detached,
    commit,
    shortCommit,
  }

  const status = await runGit(['status', '--porcelain'], {cwd: dir, timeout: 30000})
  if (status.ok) Object.assign(info, parseStatus(status.stdout))

  if (detached) {
    info.reason = 'HEAD 处于游离状态（没在任何分支上），先手动切回分支'
    return info
  }
  // 上游追踪分支：没配上游就没法知道该跟谁比
  const up = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {cwd: dir, timeout: 15000})
  if (!up.ok) {
    info.reason = `分支 ${info.branch} 没有上游，git pull 也不知道拉哪儿`
    return info
  }
  info.upstream = up.stdout.trim()
  // 上游挂在哪个 remote 上要问 config，不能假设是 origin —— 一个仓库挂多个 remote 时
  // （比如同时推 gitcode 和 github），origin 很可能是别人的上游仓库，fetch 它是白跑
  const remoteRes = await runGit(['config', '--get', `branch.${info.branch}.remote`], {cwd: dir, timeout: 15000})
  info.remote = remoteRes.ok ? remoteRes.stdout.trim() : (info.upstream.split('/')[0] || 'origin')

  const urlRes = await runGit(['remote', 'get-url', info.remote], {cwd: dir, timeout: 15000})
  if (urlRes.ok) info.remoteUrl = urlRes.stdout.trim()

  const count = await runGit(['rev-list', '--left-right', '--count', `HEAD...${info.upstream}`], {cwd: dir, timeout: 30000})
  if (count.ok) Object.assign(info, parseAheadBehind(count.stdout))
  info.updatable = true
  return info
}

/**
 * 取远端最新引用。这是唯一走网络的一步，单独拆出来方便控制并发和超时。
 * @param {string} remote 要拉的 remote 名，务必传 {@link readRepoInfo} 算出来的那个
 */
export async function fetchRepo(dir, remote = 'origin', opts = {}) {
  // --prune 清掉远端已删的分支引用，--no-tags 少传一堆没用的 tag
  return runGit(['fetch', '--prune', '--no-tags', remote], {
    cwd: dir, timeout: opts.timeout ?? 120000, onLine: opts.onLine, onSpawn: opts.onSpawn,
  })
}

/** 本地落后于上游的那些提交（新到的东西），最多 {@link MAX_LOG} 条 */
export async function pendingCommits(dir, upstream) {
  const res = await runGit([
    'log', `-${MAX_LOG}`, `--pretty=format:%h${SEP}%an${SEP}%ad${SEP}%s`, '--date=short',
    `HEAD..${upstream}`,
  ], {cwd: dir, timeout: 30000})
  return res.ok ? parseLogLines(res.stdout) : []
}

/** 两个 commit 之间的提交，用来在更新完之后说清「这次更新了什么」 */
export async function commitsBetween(dir, from, to) {
  const res = await runGit([
    'log', `-${MAX_LOG}`, `--pretty=format:%h${SEP}%an${SEP}%ad${SEP}%s`, '--date=short',
    `${from}..${to}`,
  ], {cwd: dir, timeout: 30000})
  return res.ok ? parseLogLines(res.stdout) : []
}

/**
 * 快进到上游。
 *
 * 用 `merge --ff-only` 而不是 `git pull`：pull 在有分歧时会尝试 merge / rebase，
 * 弄出 merge commit 甚至冲突半途而废，插件目录就成了要人工收拾的烂摊子。ff-only 要么干净
 * 快进，要么原地不动报错，可预期得多。
 */
export async function fastForward(dir, upstream, opts = {}) {
  return runGit(['merge', '--ff-only', upstream], {cwd: dir, timeout: 60000, onLine: opts.onLine, onSpawn: opts.onSpawn})
}

/** 丢弃本地改动，硬对齐上游（强制更新用，会丢东西） */
export async function resetToUpstream(dir, upstream, opts = {}) {
  return runGit(['reset', '--hard', upstream], {cwd: dir, timeout: 60000, onLine: opts.onLine, onSpawn: opts.onSpawn})
}

/** 回到指定 commit（回滚用） */
export async function resetTo(dir, commit, opts = {}) {
  return runGit(['reset', '--hard', commit], {cwd: dir, timeout: 60000, onLine: opts.onLine, onSpawn: opts.onSpawn})
}

/** 把本地改动收进 stash。带 -u 连未跟踪文件一起收，免得它们挡住后面的 checkout */
export async function stashPush(dir, message, opts = {}) {
  return runGit(['stash', 'push', '-u', '-m', message], {cwd: dir, timeout: 60000, onLine: opts.onLine, onSpawn: opts.onSpawn})
}

/** 把最近一条 stash 放回来。冲突时 git 会报错，保留 stash 不动，让用户自己收拾 */
export async function stashPop(dir, opts = {}) {
  return runGit(['stash', 'pop'], {cwd: dir, timeout: 60000, onLine: opts.onLine, onSpawn: opts.onSpawn})
}

/** stderr 里取第一行有内容的，报错给人看时不要糊一大堆 */
export function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

