import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {GuobaError, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import {
  addFetchUrl as gitAddFetchUrl, addPushUrl as gitAddPushUrl, addRemote as gitAddRemote, fetchRepo,
  firstLine, isAncestor, isGitRepo, maskUrlCredential, pendingCommits, readRemotes, readRepoInfo,
  recentCommits, removeFetchUrl as gitRemoveFetchUrl, removePushUrl as gitRemovePushUrl,
  removeRemote as gitRemoveRemote, resetTo, resolveCommit, setRemoteUrl as gitSetRemoteUrl,
} from '../../utils/gitRepo.js'
import {UPDATE_MODES, updateRepo} from '../../utils/pluginUpdateFlow.js'
import {installPluginDeps, PLUGIN_NAME_RE} from '../../utils/pluginDeps.js'

/**
 * 插件更新。
 *
 * 面板上原来只能装 / 卸插件，更新得去命令行或者发指令，而更新恰恰是最频繁的操作。这里把
 * 「看落后多少 → 更新 → 出问题回滚」串成一条能在网页上走完的路。
 *
 * 三个设计取向：
 * - **检查和更新分开**。检查要联网 fetch（几十个仓库很慢、还可能被限流），所以只在用户点的
 *   时候做；平时列表只读本地 git 状态，快到可以随页面一起加载。
 * - **默认不碰用户的改动**。插件目录里常有自己改的代码，默认遇到本地改动就跳过，要动得由用户
 *   明确选「暂存」或「丢弃」。
 * - **更新完不自动重启**。改完代码要重启才生效，但重启时机得用户自己定 —— 正在聊天的群不该
 *   因为面板上点了个更新就断一下。
 */

/**
 * `plugins/` 下不是插件的目录。
 *
 * 前四个是 Miao-Yunzai 自带的功能目录，后两个是 TRSS-Yunzai 的适配器与可执行文件目录
 * —— 实测环境里它们都会被列出来，而它们既不是 git 仓库也没有更新的概念。
 */
const BUILTIN = new Set(['example', 'genshin', 'other', 'system', 'adapter', 'bin'])

/** 检查更新时并发 fetch 几个仓库。再多容易被 GitHub 限流，也把带宽吃满 */
const FETCH_CONCURRENCY = 3

/** 任务日志最多留这么多行 */
const MAX_LOGS = 800

/** 模式的中文说法，写进任务日志给用户看 */
const MODE_TEXT = {
  safe: '跳过有改动的插件',
  stash: '暂存本地改动后更新',
  force: '丢弃本地改动强制更新',
}


export class PluginUpdateService extends Service {

  /** 当前任务，只允许一个在跑（更新会动 git 工作区，并发就是互相踩） */
  #task = null
  #logs = []
  #seq = 0
  #canceled = false
  /** 正在跑的子进程，取消时要把它们杀掉 */
  #running = new Set()
  /**
   * 每个插件最近一次由面板改动位置（更新或回滚）之前的 commit，用来一键退回。
   * 只在内存里 —— 重启就没了，但那不影响回滚本身：翻更新日志挑一个提交同样能回。
   */
  #history = new Map()

  constructor(app, root) {
    super(app)
    this.root = root || _paths.root
    this.pluginsPath = path.join(this.root, 'plugins')
  }

  /** 插件目录 → 绝对路径，顺手挡住 `../` 之类的名字 */
  #dirOf(name) {
    const clean = String(name ?? '').trim()
    if (!clean || !PLUGIN_NAME_RE.test(clean)) throw new GuobaError(`插件名不合法：${name}`)
    const abs = path.join(this.pluginsPath, clean)
    if (path.dirname(abs) !== this.pluginsPath) throw new GuobaError(`插件名不合法：${name}`)
    return abs
  }

  /**
   * 上次 fetch 的时间。`git fetch` 会写 `.git/FETCH_HEAD`，拿它的 mtime 就行 ——
   * 比在内存里记一份好：锅巴重启后这个时间还在。
   */
  #lastFetchAt(dir) {
    try {
      return Math.floor(fs.statSync(path.join(dir, '.git', 'FETCH_HEAD')).mtimeMs)
    } catch {
      return 0
    }
  }

  /**
   * 列出所有插件及其 git 状态。**不联网**，所以 behind 是上次 fetch 时的数据，
   * 页面要连 `lastFetchAt` 一起显示，不然用户会以为 0 就是最新。
   */
  async list() {
    let names = []
    try {
      names = fs.readdirSync(this.pluginsPath, {withFileTypes: true})
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !BUILTIN.has(d.name))
        .map((d) => d.name)
    } catch (err) {
      throw new GuobaError(`读不到 plugins 目录：${err.message}`)
    }
    // 本地 git 操作很快（实测单个仓库 30ms 上下），并发读一遍就够
    const items = await Promise.all(names.map(async (name) => {
      const dir = this.#dirOf(name)
      const info = await readRepoInfo(dir)
      return {
        name,
        ...info,
        lastFetchAt: this.#lastFetchAt(dir),
        canRollback: this.#history.has(name),
      }
    }))
    return items.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ------------------------------------------------------------------ 检查更新

  /**
   * 检查更新：联网 fetch 后重算落后了几个提交。后台跑，进度靠 {@link taskStatus} 轮询。
   * @param {string[]} [names] 只查这几个，不传就查全部 git 仓库
   */
  check(names) {
    this.#startTask('check')
    const picked = Array.isArray(names) && names.length ? names.map((n) => String(n).trim()) : null
    this.#runCheck(picked).catch((err) => this.#failTask(err))
    return this.taskStatus()
  }

  async #runCheck(names) {
    const all = await this.list()
    const targets = all.filter((it) => it.isRepo && (!names || names.includes(it.name)))
    if (!targets.length) throw new GuobaError('没有可检查的 git 插件')
    this.#task.total = targets.length
    this.#log(`开始检查 ${targets.length} 个插件`)

    const queue = [...targets]
    const items = []
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        this.#throwIfCanceled()
        items.push(await this.#checkOne(it))
        this.#task.current++
      }
    }
    await Promise.all(
      Array.from({length: Math.min(FETCH_CONCURRENCY, queue.length)}, () => worker()),
    )
    const behind = items.filter((it) => it.behind > 0)
    // 单查一个时上面已经有「某某：已是最新」，再来一句总结只会重复
    if (behind.length) this.#log(`${behind.length} 个插件有更新`)
    else if (targets.length > 1) this.#log('所有插件都是最新的')
    this.#finishTask({items, checkedAt: Date.now()})
  }

  /** 查一个插件：fetch 完重读状态，落后了就把新提交也带回来 */
  async #checkOne(item) {
    const dir = this.#dirOf(item.name)
    if (!item.updatable) {
      this.#log(`${item.name}：${item.reason}`, 'warn')
      return {...item, checked: false}
    }
    this.#log(`${item.name}：拉取 ${item.remote} 的最新引用`)
    const res = await fetchRepo(dir, item.remote, {
      onSpawn: (child) => this.#track(child),
      onLine: (line) => this.#log(`  ${line}`, 'cmd'),
    })
    if (!res.ok) {
      const reason = firstLine(res.stderr) || `git fetch 退出码 ${res.code}`
      this.#log(`${item.name}：拉取失败 —— ${reason}`, 'error')
      return {...item, checked: false, error: reason}
    }
    const info = await readRepoInfo(dir)
    const commits = info.behind > 0 ? await pendingCommits(dir, info.upstream) : []
    this.#log(info.behind > 0
      ? `${item.name}：落后 ${info.behind} 个提交`
      : `${item.name}：已是最新`)
    return {
      name: item.name,
      ...info,
      commits,
      lastFetchAt: this.#lastFetchAt(dir),
      canRollback: this.#history.has(item.name),
      checked: true,
    }
  }

  // ------------------------------------------------------------------ 更新

  /**
   * 更新插件。串行做 —— 更新会动 git 工作区、还可能跑 pnpm，并发只会互相踩。
   *
   * @param {object} opts
   * @param {string[]} opts.names 要更新的插件目录名
   * @param {'safe'|'stash'|'force'} [opts.mode] 遇到本地改动怎么办，默认 safe（跳过）
   * @param {boolean} [opts.npmInstall] package.json 变了要不要装依赖，默认要
   * @param {boolean} [opts.restart] 全部完成后是否重启 Bot，默认不重启
   */
  update({names, mode = 'safe', npmInstall = true, restart = false} = {}) {
    const picked = (Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim()).filter(Boolean)
    if (!picked.length) throw new GuobaError('没有选择要更新的插件')
    if (!UPDATE_MODES.has(mode)) throw new GuobaError(`未知的更新模式：${mode}`)
    // 名字先全校验一遍，别更新到一半才发现有个名字不合法
    for (const name of picked) this.#dirOf(name)
    this.#startTask('update')
    this.#task.mode = mode
    this.#runUpdate(picked, {mode, npmInstall, restart}).catch((err) => this.#failTask(err))
    return this.taskStatus()
  }

  async #runUpdate(names, {mode, npmInstall, restart}) {
    this.#task.total = names.length
    this.#log(`开始更新 ${names.length} 个插件（模式：${MODE_TEXT[mode]}）`)
    const items = []
    for (const name of names) {
      this.#throwIfCanceled()
      items.push(await this.#updateOne(name, {mode, npmInstall}))
      this.#task.current++
    }

    const updated = items.filter((it) => it.status === 'updated')
    const failed = items.filter((it) => it.status === 'failed')
    this.#log(`完成：更新 ${updated.length} 个`
      + `，跳过 ${items.length - updated.length - failed.length} 个`
      + `，失败 ${failed.length} 个`)
    // 依赖没装上就别重启：那样只会满屏缺模块报错，还不如让用户先看日志
    const depsFailed = items.some((it) => it.deps && !it.deps.ok)
    const restartSkipped = restart && (!updated.length || depsFailed)
    if (restartSkipped) {
      this.#log(depsFailed
        ? '有插件的依赖没装上，已跳过自动重启 —— 先手动装好依赖再重启'
        : '没有插件真的更新，不用重启', 'warn')
    }
    let doRestart
    if (restart && !restartSkipped) {
      // 先把重启模块加载好再结束任务：前端拿到 done 就停轮询，之后的报错就看不见了
      ({doRestart} = await import('../../../utils/botActions.js'))
      this.#log('即将重启 Bot')
    }
    this.#finishTask({items, restarted: !!doRestart, restartSkipped})
    if (doRestart) setTimeout(() => doRestart(), 1000)
  }

  /**
   * 更新一个插件：git 那一套交给 {@link updateRepo}，这里只管日志前缀、装依赖和回滚记录。
   */
  async #updateOne(name, {mode, npmInstall}) {
    const dir = this.#dirOf(name)
    const res = await updateRepo(dir, {
      mode,
      log: (text, level) => this.#log(text.startsWith('  ') ? text : `${name}：${text}`, level),
      onSpawn: (child) => this.#track(child),
    })
    const out = {
      name,
      status: res.status,
      reason: res.reason,
      from: res.from,
      to: res.to,
      commits: res.commits,
      stash: res.stash,
      deps: null,
    }
    if (res.status !== 'updated') return out

    if (npmInstall && res.depsChanged) {
      this.#log(`${name}：依赖文件有变化，开始装依赖`)
      out.deps = await installPluginDeps(this.root, name, {
        spawnLogged: (cmd, args, opts) => this.#spawnLogged(cmd, args, opts),
        log: (text, level) => this.#log(text, level),
      })
      if (!out.deps.ok) this.#log(`${name}：依赖没装上 —— ${out.deps.reason}`, 'error')
    }

    this.#history.set(name, {before: res.before, after: res.after, at: Date.now(), via: 'update'})
    return out
  }

  // ------------------------------------------------------------------ 更新日志

  /**
   * 一个插件的更新日志：本地的提交历史 + 上次检查时拉到的待更新提交。
   *
   * **不联网**，所以待更新那段是上次 fetch 的结果，页面上要连 `lastFetchAt` 一起显示。
   * 历史是选版本回滚的选项来源，所以每条都带完整信息（作者、时间、标题）。
   *
   * @param {string} name 插件目录名
   * @param {number} [limit] 要几条历史
   */
  async history(name, limit = 50) {
    const dir = this.#dirOf(name)
    const info = await readRepoInfo(dir)
    if (!info.isRepo) throw new GuobaError(info.reason || '不是 git 仓库，没有更新日志')
    const commits = await recentCommits(dir, limit)
    if (!commits.length) throw new GuobaError(info.reason || 'git 读不出提交历史')
    const pending = info.behind > 0 && info.upstream ? await pendingCommits(dir, info.upstream) : []
    const rec = this.#history.get(String(name ?? '').trim())
    return {
      name,
      ...info,
      commits,
      pending,
      lastFetchAt: this.#lastFetchAt(dir),
      canRollback: !!rec,
      // 一键退回的目标：上次更新（或上次回滚）之前待在哪个提交上
      rollbackTo: rec ? {commit: rec.before, short: rec.before.slice(0, 7), at: rec.at, via: rec.via} : null,
    }
  }

  // ------------------------------------------------------------------ 回滚

  /**
   * 回滚：把插件的代码 `reset --hard` 到某个提交。
   *
   * 两种用法 —— 不传 `commit` 就退回「上次由面板改动之前」的位置（更新完发现有问题时最顺手），
   * 传了就去指定的那个提交，也就是用户在更新日志里挑的版本。
   *
   * 依赖不回滚：装上的包留着不影响旧代码跑，而卸依赖比装依赖更容易把环境弄坏。
   *
   * @param {string} name 插件目录名
   * @param {object} [opts]
   * @param {string} [opts.commit] 目标提交的 hash，不传就退回上次改动前
   * @param {boolean} [opts.discardLocal] 有本地改动时是否照样回滚（会丢掉那些改动）
   */
  async rollback(name, {commit, discardLocal = false} = {}) {
    if (this.#task && !this.#task.done) throw new GuobaError('有任务在跑，等它结束再回滚')
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    const info = await readRepoInfo(dir)
    if (!info.isRepo || !info.commit) throw new GuobaError('不是 git 仓库，回滚不了')
    // detached 时 reset 只挪 HEAD 不挪分支，回滚完插件还在游离状态，越弄越乱
    if (info.detached) throw new GuobaError('HEAD 处于游离状态（没在任何分支上），先手动切回分支')

    let target
    if (commit) {
      target = await resolveCommit(dir, commit)
      if (!target) throw new GuobaError(`这个仓库里找不到提交 ${commit}`)
    } else {
      const rec = this.#history.get(key)
      if (!rec) throw new GuobaError('没有本次运行内的更新记录，请在更新日志里挑一个版本')
      target = rec.before
    }
    if (target === info.commit) throw new GuobaError('已经在这个版本上了')
    if (info.dirty && !discardLocal) {
      throw new GuobaError(
        `有 ${info.changed.length} 个文件被改过，回滚会把这些改动丢掉 —— 确认要丢就勾上「丢弃本地改动」`,
      )
    }

    // 目标在当前提交的历史里才叫「回滚」；反过来是往前跳（比如挑了条待更新的提交）
    const back = await isAncestor(dir, target, info.commit)
    const res = await resetTo(dir, target)
    if (!res.ok) {
      throw new GuobaError(`回滚失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    // 记下这次的起点：挑错版本了还能一键退回来
    this.#history.set(key, {before: info.commit, after: target, at: Date.now(), via: 'rollback'})
    const short = target.slice(0, 7)
    logger.mark(`[Guoba] 插件 ${key} 已${back ? '回滚' : '切换'}到 ${short}`)
    return {name: key, commit: short, from: info.shortCommit, back, needRestart: true}
  }

  // ------------------------------------------------------------------ remote

  /**
   * 一个插件配的 remote 列表，用来在面板上改仓库地址（原来只能进终端 `git remote set-url`）。
   * 不联网，纯读 `.git/config`。
   *
   * @param {string} name 插件目录名
   */
  async remotes(name) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可改')
    const info = await readRepoInfo(dir)
    return {
      name: key,
      branch: info.branch,
      detached: info.detached,
      // 当前分支的上游挂在哪个 remote 上 —— 改它的地址会直接影响「检查更新」
      remote: info.remote,
      remotes: await readRemotes(dir),
    }
  }

  /**
   * 改一个 remote 的仓库地址。只动 `.git/config`，不 fetch、不碰工作区。
   *
   * @param {string} name 插件目录名
   * @param {string} remote remote 名（origin / gitee / gitcode…）
   * @param {string} url 新地址
   */
  async setRemoteUrl(name, remote, url) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可改')
    const remoteName = String(remote ?? '').trim()
    const cleanUrl = String(url ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    if (!cleanUrl) throw new GuobaError('仓库地址不能为空')
    // 空白和控制字符会被 git config 原样写进去，下次 fetch 就因为一个看不见的换行报错
    if (/[\s\u0000-\u001f]/.test(cleanUrl)) throw new GuobaError('仓库地址里不能有空白字符')
    const list = await readRemotes(dir)
    if (!list.some((r) => r.name === remoteName)) {
      throw new GuobaError(`没有名为 ${remoteName} 的 remote`)
    }
    const res = await gitSetRemoteUrl(dir, remoteName, cleanUrl)
    if (!res.ok) {
      throw new GuobaError(`保存失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    logger.mark(`[Guoba] 插件 ${key} 的 remote ${remoteName} 已改为 ${cleanUrl}`)
    return {name: key, remote: remoteName, url: cleanUrl}
  }

  /** remote 名的合法字符：git 允许的更宽，但面板里只放行这套，省得建出奇怪的 section 名 */
  static REMOTE_NAME_RE = /^[A-Za-z0-9._-]+$/

  /**
   * 新增一个 remote（`git remote add`）。fetch refspec 由 git 自动配好，
   * 之后它就能被「检查更新」当作上游的候选。
   *
   * @param {string} name 插件目录名
   * @param {string} remote 新 remote 的名字（gitee / gitcode…）
   * @param {string} url 仓库地址
   */
  async addRemote(name, remote, url) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，不能加 remote')
    const remoteName = String(remote ?? '').trim()
    const cleanUrl = String(url ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    if (!PluginUpdateService.REMOTE_NAME_RE.test(remoteName)) {
      throw new GuobaError('remote 名只能用字母、数字、点、下划线和短横线')
    }
    if (!cleanUrl) throw new GuobaError('仓库地址不能为空')
    if (/[\s\u0000-\u001f]/.test(cleanUrl)) throw new GuobaError('仓库地址里不能有空白字符')
    const list = await readRemotes(dir)
    if (list.some((r) => r.name === remoteName)) {
      throw new GuobaError(`已经有名为 ${remoteName} 的 remote 了`)
    }
    const res = await gitAddRemote(dir, remoteName, cleanUrl)
    if (!res.ok) {
      throw new GuobaError(`添加失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    logger.mark(`[Guoba] 插件 ${key} 新增 remote ${remoteName} → ${cleanUrl}`)
    return {name: key, remote: remoteName, url: cleanUrl}
  }

  /**
   * 删掉一个 remote（`git remote remove`），它的 pushurl 配置一起走。
   * 只动 `.git/config`，已经拉下来的代码和远端引用不受影响。
   *
   * @param {string} name 插件目录名
   * @param {string} remote 要删的 remote 名
   */
  async removeRemote(name, remote) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可删')
    const remoteName = String(remote ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    const list = await readRemotes(dir)
    if (!list.some((r) => r.name === remoteName)) {
      throw new GuobaError(`没有名为 ${remoteName} 的 remote`)
    }
    const info = await readRepoInfo(dir)
    const res = await gitRemoveRemote(dir, remoteName)
    if (!res.ok) {
      throw new GuobaError(`删除失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    const wasUpstream = info.remote === remoteName
    logger.mark(`[Guoba] 插件 ${key} 已删除 remote ${remoteName}${wasUpstream ? '（它是当前分支的上游）' : ''}`)
    return {name: key, remote: remoteName, wasUpstream}
  }

  /**
   * 给 remote 追加一条推送地址（`remote set-url --add --push`）。
   *
   * 配了 pushurl 之后 `git push` 只走这些地址、`url` 只用于 fetch ——
   * 主人那种「origin 挂 gitcode/github/gitee 三条一次推三平台」就是这么配的。
   *
   * @param {string} name 插件目录名
   * @param {string} remote remote 名
   * @param {string} url 推送地址，可以带账号令牌
   */
  async addPushUrl(name, remote, url) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可改')
    const remoteName = String(remote ?? '').trim()
    const cleanUrl = String(url ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    if (!cleanUrl) throw new GuobaError('推送地址不能为空')
    if (/[\s\u0000-\u001f]/.test(cleanUrl)) throw new GuobaError('推送地址里不能有空白字符')
    // 比对要用原始地址：展示层给的是打码后的，拿它比对永远不相等
    const list = await readRemotes(dir, {mask: false})
    const target = list.find((r) => r.name === remoteName)
    if (!target) throw new GuobaError(`没有名为 ${remoteName} 的 remote`)
    if (target.pushurl.includes(cleanUrl)) throw new GuobaError('这条地址已经在推送列表里了')
    const res = await gitAddPushUrl(dir, remoteName, cleanUrl)
    if (!res.ok) {
      throw new GuobaError(`添加失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    logger.mark(`[Guoba] 插件 ${key} 的 remote ${remoteName} 新增推送地址 ${maskUrlCredential(cleanUrl)}`)
    return {name: key, remote: remoteName, url: maskUrlCredential(cleanUrl)}
  }

  /**
   * 按序号删掉一条推送地址。
   *
   * 不按地址删：前端拿到的是打码值（`https://user:***@…`），`git remote set-url --delete`
   * 又要求精确匹配原始地址，所以这里按索引回原始列表取真值再删。
   *
   * @param {string} name 插件目录名
   * @param {string} remote remote 名
   * @param {number} index 第几条（从 0 开始，按 `.git/config` 里的顺序）
   */
  async removePushUrl(name, remote, index) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可改')
    const remoteName = String(remote ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    const list = await readRemotes(dir, {mask: false})
    const target = list.find((r) => r.name === remoteName)
    if (!target) throw new GuobaError(`没有名为 ${remoteName} 的 remote`)
    const idx = Number(index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= target.pushurl.length) {
      throw new GuobaError('推送地址序号不对，刷新后再试')
    }
    const url = target.pushurl[idx]
    const res = await gitRemovePushUrl(dir, remoteName, url)
    if (!res.ok) {
      throw new GuobaError(`删除失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    logger.mark(`[Guoba] 插件 ${key} 的 remote ${remoteName} 删除了推送地址 ${maskUrlCredential(url)}`)
    return {name: key, remote: remoteName, removed: maskUrlCredential(url)}
  }

  /**
   * 给 remote 追加一条备用拉取地址（`remote set-url --add`，不带 --push）。
   *
   * 必须知道：**git fetch 只会用第一条 url**，追加的这些不会自动顶上，
   * 它的真实作用是记在配置里备查（没配 pushurl 时 push 会用到全部 url，这是 git 的老规则）。
   *
   * @param {string} name 插件目录名
   * @param {string} remote remote 名
   * @param {string} url 备用地址
   */
  async addFetchUrl(name, remote, url) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可改')
    const remoteName = String(remote ?? '').trim()
    const cleanUrl = String(url ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    if (!cleanUrl) throw new GuobaError('拉取地址不能为空')
    if (/[\s\u0000-\u001f]/.test(cleanUrl)) throw new GuobaError('拉取地址里不能有空白字符')
    const list = await readRemotes(dir, {mask: false})
    const target = list.find((r) => r.name === remoteName)
    if (!target) throw new GuobaError(`没有名为 ${remoteName} 的 remote`)
    if (target.urls.includes(cleanUrl)) throw new GuobaError('这条地址已经在拉取列表里了')
    const res = await gitAddFetchUrl(dir, remoteName, cleanUrl)
    if (!res.ok) {
      throw new GuobaError(`添加失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    logger.mark(`[Guoba] 插件 ${key} 的 remote ${remoteName} 新增备用拉取地址 ${maskUrlCredential(cleanUrl)}`)
    return {name: key, remote: remoteName, url: maskUrlCredential(cleanUrl)}
  }

  /**
   * 删掉一条备用拉取地址。第一条是实际在用的，不给删 —— 想换拉取源就编辑它。
   *
   * @param {string} name 插件目录名
   * @param {string} remote remote 名
   * @param {number} index 第几条（从 0 开始，1 以上才允许删）
   */
  async removeFetchUrl(name, remote, index) {
    const key = String(name ?? '').trim()
    const dir = this.#dirOf(key)
    if (!isGitRepo(dir)) throw new GuobaError('不是 git 仓库，没有 remote 可改')
    const remoteName = String(remote ?? '').trim()
    if (!remoteName) throw new GuobaError('remote 名不能为空')
    const list = await readRemotes(dir, {mask: false})
    const target = list.find((r) => r.name === remoteName)
    if (!target) throw new GuobaError(`没有名为 ${remoteName} 的 remote`)
    const idx = Number(index)
    if (!Number.isInteger(idx) || idx < 1 || idx >= target.urls.length) {
      throw new GuobaError('备用地址序号不对，刷新后再试')
    }
    const url = target.urls[idx]
    const res = await gitRemoveFetchUrl(dir, remoteName, url)
    if (!res.ok) {
      throw new GuobaError(`删除失败：${firstLine(res.stderr) || `git 退出码 ${res.code}`}`)
    }
    logger.mark(`[Guoba] 插件 ${key} 的 remote ${remoteName} 删除了备用拉取地址 ${maskUrlCredential(url)}`)
    return {name: key, remote: remoteName, removed: maskUrlCredential(url)}
  }

  // ------------------------------------------------------------------ 任务

  #startTask(type) {
    if (this.#task && !this.#task.done) throw new GuobaError('已有任务在跑，请等它结束')
    this.#canceled = false
    this.#logs = []
    this.#seq = 0
    this.#task = {
      id: `${type}-${Date.now()}`,
      type,
      mode: '',
      current: 0,
      total: 0,
      done: false,
      error: '',
      result: null,
      startAt: Date.now(),
      endAt: 0,
    }
  }

  #finishTask(result) {
    if (!this.#task) return
    Object.assign(this.#task, {done: true, result, endAt: Date.now()})
  }

  #failTask(err) {
    const msg = err?.message || String(err)
    this.#log(msg, 'error')
    if (!this.#task) return
    Object.assign(this.#task, {
      done: true,
      canceled: this.#canceled,
      error: this.#canceled ? '已取消' : msg,
      endAt: Date.now(),
    })
  }

  #throwIfCanceled() {
    if (this.#canceled) throw new GuobaError('已取消')
  }

  #log(text, level = 'info') {
    this.#logs.push({seq: this.#seq++, level, text: String(text)})
    if (this.#logs.length > MAX_LOGS) this.#logs.shift()
  }

  /**
   * 任务状态 + 增量日志。
   * @param {number} [cursor] 上次拿到的 cursor，只返回它之后的日志
   */
  taskStatus(cursor) {
    const from = Number(cursor)
    const logs = Number.isFinite(from) ? this.#logs.filter((l) => l.seq > from) : this.#logs
    return {
      task: this.#task,
      logs,
      cursor: this.#logs.length ? this.#logs[this.#logs.length - 1].seq : (Number.isFinite(from) ? from : -1),
    }
  }

  /** 取消：标记 + 把正在跑的 git / pnpm 杀掉，不然 fetch 能挂好几分钟 */
  cancel() {
    if (!this.#task || this.#task.done) throw new GuobaError('没有正在跑的任务')
    this.#canceled = true
    this.#log('收到取消请求', 'warn')
    for (const proc of this.#running) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // 已经退了
      }
    }
    return this.taskStatus()
  }

  /** 记下子进程，退出时自动摘掉 */
  #track(child) {
    this.#running.add(child)
    const off = () => this.#running.delete(child)
    child.on('close', off)
    child.on('error', off)
    if (this.#canceled) child.kill('SIGKILL')
  }

  /** 跑一条命令并把输出写进任务日志（给装依赖用） */
  #spawnLogged(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      if (this.#canceled) {
        resolve({code: -1, tail: '已取消'})
        return
      }
      let proc
      try {
        proc = spawn(cmd, args, {...opts, windowsHide: true})
      } catch (err) {
        resolve({code: -1, tail: err.message})
        return
      }
      this.#track(proc)
      let settled = false
      const tail = []
      const done = (res) => {
        if (settled) return
        settled = true
        resolve(res)
      }
      const feed = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          const text = line.trim()
          if (!text) continue
          tail.push(text)
          if (tail.length > 5) tail.shift()
          this.#log(`  ${text}`, 'cmd')
        }
      }
      proc.stdout?.on('data', feed)
      proc.stderr?.on('data', feed)
      proc.on('error', (err) => done({code: -1, tail: err.message}))
      // 被杀掉时 close 可能迟迟不来（孤儿子进程还占着管道），exit 先兜一下
      proc.on('exit', (code) => {
        if (this.#canceled) done({code: code ?? -1, tail: '已取消'})
      })
      proc.on('close', (code) => done({code: code ?? -1, tail: tail.join('; ')}))
    })
  }
}
