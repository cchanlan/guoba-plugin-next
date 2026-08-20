import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import YAML from 'yaml'
import {GuobaError, Service} from '#guoba.framework'
import {_paths, cfg} from '#guoba.platform'
import {ZipWriter, readEntries, readEntryBuffer, extractEntry, safeJoin} from '../../utils/zip.js'
import {installPluginDeps, NEED_SHELL, PLUGIN_NAME_RE, PNPM} from '../../utils/pluginDeps.js'
import {
  discoverTarget, discoverPlain, repoInfo, sanitizeRemote, shouldSkipName,
  gitArgs, DISCOVER_LIMITS, GIT_DIR_REL, GIT_SKIP_RE, sanitizeGitConfig,
} from '../../utils/backupDiscover.js'

/** 备份包放这儿（Yunzai 根的相对路径） */
const BACKUP_DIR = 'data/guoba/backups'
/** 还原前把被覆盖的原文件挪到这里，出事了还能捞回来 */
const RESTORE_BAK_PREFIX = '.restore-bak-'
/** 插件没装成功时，它的文件先存这儿等插件装好 */
const PENDING_DIR = '.pending-restore'
/** 包内所有备份文件的前缀，其后就是相对 Yunzai 根的原始路径 */
const FILES_PREFIX = 'files/'
/** manifest 在包里的名字 */
const MANIFEST_NAME = 'manifest.json'
/** manifest 格式版本，以后改结构了靠它拒绝不认识的包 */
const MANIFEST_VERSION = 1

/** scan 结果缓存多久（毫秒）。实测全量扫一遍 2 秒，够用了 */
const SCAN_TTL = 60 * 1000
/** 扫插件时的并发 */
const SCAN_CONCURRENCY = 5
/** 任务日志上限，超了从头挤（同日志页 / 终端页） */
const MAX_LOGS = 2000
/** 上传的备份包大小上限 */
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024

/** 备份包文件名规则，用它兜住路径穿越和乱七八糟的名字 */
const PACK_NAME_RE = /^[\w.-]+\.zip$/i
/**
 * `.git` 里存 remote 地址（也就是可能存凭证）的文件名。
 *
 * 除了 `.git/config` 本身，子模块的 `.git/modules/<名字>/config` 和多 worktree 的
 * `config.worktree` 也是同一种文件。宁可多过一遍 —— {@link sanitizeGitConfig} 只动
 * `url = ` 行，对不含这种行的文件是空操作。
 */
const GIT_CONFIG_NAME_RE = /^config(?:\.worktree)?$/
/**
 * npm 包名规则（普通包 / @scope/pkg）。
 *
 * 每段必须以字母或数字开头，不能让 `--filter` / `-w` / `..` 这种名字混进给用户复制的
 * `pnpm add ... -w` —— 不然 pnpm 会把它当命令行选项，而不是包名。
 */
const DEP_NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
/** README 安装命令只认这些包管理器和动作，绝不执行原始 shell */
const SAFE_INSTALL_MANAGERS = new Set(['pnpm', 'npm', 'cnpm', 'yarn'])
const SAFE_INSTALL_ACTIONS = new Set(['install', 'i', 'add'])

/**
 * GitHub 反代候选（还原前会连直连一起测速，挑最快的）。
 *
 * 都是前缀式用法：`https://<反代>/https://github.com/user/repo.git`。用户可以在
 * `config/application.yaml` 的 `backup.githubProxies` 里改这份名单。
 */
const DEFAULT_PROXIES = [
  'https://ghproxy.1888866.xyz/',
  'https://gh-proxy.com/',
  'https://ui.ghproxy.cc/',
  'https://gitwarp.com/',
  'https://gh.jasonzeng.dev/',
  'https://github.akams.cn/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://github.moeyy.xyz/',
  'https://hub.gitmirror.com/',
]
/** 测速探针：拿 `git ls-remote` 探一个极小的仓库，走的就是真实 clone 的那条路 */
const PROXY_PROBE_REPO = 'https://github.com/octocat/Hello-World.git'
/** 单条线路的测速超时 */
const PROXY_TIMEOUT = 6000
/** 测速结果缓存多久，免得连续还原每次都花几秒重测 */
const PROXY_TTL = 5 * 60 * 1000

/**
 * **还原时**这些字段保持本机原样，其它一切照常覆盖。
 *
 * 注意只管还原，不管备份 —— 包里内容是完整的（Redis 配置、各账号 ck、黑白名单全都在），
 * 换台机器照样能整包搬走。只有这么几项「一换就坏」的例外：
 *
 * - `masterQQ` / `master`：主人绑定。新机器的 bot 号跟备份来源不同的话，盖过去就不认主人了
 * - `chromium_path` / `puppeteer_ws`：Windows 的 `C:\...` 盖到 Linux 上，渲染直接崩
 * - `server.yaml` 的 `url`：对外访问地址，IP 变了图片链接就全失效
 * - `pm2.yaml` 的 `apps`：通篇是这台机器的路径和进程名
 *
 * 键是相对 Yunzai 根的路径，值是 yaml 字段路径。清单里多余的字段名匹配不上也无害，
 * 所以不同 Yunzai 分支都兼容。锅巴自己那份在构造时按实际目录名补进去。
 */
const KEEP_LOCAL_BASE = [
  ['config/config/other.yaml', ['masterQQ', 'master']],
  ['config/config/bot.yaml', ['chromium_path', 'puppeteer_ws']],
  ['config/config/server.yaml', ['url']],
  ['config/pm2.yaml', ['apps']],
]

/**
 * 锅巴自己的配置里要留在本机的。
 *
 * `jwt.secret` 一换，浏览器手上的 token 立刻失效 —— 还原到一半页面就跳登录页了（用户实测
 * 踩到）；`auth.*` 一换，账号密码变成备份来源那台机器的。而能点到「还原」的人必然已经
 * 登录过、也就必然设过账号，所以锅巴的账号体系压根不该跟着备份走。
 */
const GUOBA_KEEP_FIELDS = [
  'jwt.secret',
  'auth.username',
  'auth.passwordHash',
  'auth.trustedIps',
  'auth.trustedDevices',
]

/**
 * 热重载键：锅巴热重载时本模块被重新 import，实例是新的，但上一代的定时任务还挂在
 * node-schedule 里。把 job 挂到 process 上，新实例构造时看到旧的先取消。同 TermService。
 */
const JOB_KEY = Symbol.for('guoba.backup.job')
/** 跨热重载实例共享的注册代次，防止旧实例动态 import 晚回来又挂一个 job */
const JOB_GENERATION_KEY = Symbol.for('guoba.backup.job-generation')

/**
 * 备份与还原。
 *
 * 搬家场景：把 Bot 的配置、数据、各插件的配置打成一个 zip 带走，到新机器上传同一个包就能
 * 复原 —— 包括**按清单把插件重新 clone 下来**。
 *
 * 四个设计要点：
 *
 * 1. **备份什么由 git 决定，不写死目录名**。`.git` 本身不打包（本机 22 个插件的 .git 合计
 *    1.9 G），只记仓库清单（remote / branch / commit），还原时按清单 clone。仓库自带的素材
 *    同理 —— clone 就有，不该占备份体积。详见 {@link ../../utils/backupDiscover.js}。
 * 2. **包内路径就是相对 Yunzai 根的原始路径**（统一放在 `files/` 下）。还原时原路写回，
 *    不需要任何映射表，手工用解压软件打开也能看懂。
 * 3. **还原前先备份**。被覆盖的原文件挪进 `data/guoba/backups/.restore-bak-<时间戳>/`，
 *    还原错了能捞回来。插件 clone 失败时它的文件也不丢，暂存到 `.pending-restore/`。
 * 4. **还原完要装依赖**。包里带的是 `package.json`，不是 `node_modules` —— 少了这一步，
 *    重启后 Yunzai 会满屏报 `Cannot find package`。见 {@link #installDeps}。
 */
export default class BackupService extends Service {

  /**
   * @param {object} guobaApp
   * @param {string} [root] Yunzai 根，测试时可传临时目录
   */
  constructor(guobaApp, root) {
    super(guobaApp)
    this.root = root || _paths.root
    this.backupDir = path.join(this.root, BACKUP_DIR)
    /** 扫描和打包都要跳过备份目录自己，否则备份会把上一次的包卷进来 */
    this.excludes = new Set([this.backupDir])

    /** @type {Map<string, string[]>} 相对路径 → 还原时保持本机原样的字段 */
    this.keepLocal = new Map([
      ...KEEP_LOCAL_BASE,
      [this.#guobaCfgRel(), GUOBA_KEEP_FIELDS],
    ])

    // 装上锅巴就把备份目录建出来：文件管理里能直接看见，也方便把别处拿来的包丢进去
    try {
      fs.mkdirSync(this.backupDir, {recursive: true})
    } catch (err) {
      logger.warn(`[Guoba] 创建备份目录失败：${err.message}`)
    }

    /** 热重载后旧实例的 job 还挂在 node-schedule 上，applySchedule 第一步就会撤掉 */
    this.applySchedule().catch((err) => logger.error('[Guoba] 备份定时任务启动失败：', err))
  }

  #scanCache = null
  /** @type {object|null} 同一时刻只允许一个任务，避免两个打包互相写坏 */
  #task = null
  #logs = []
  #seq = 0
  #canceled = false
  /** @type {Set<import('node:child_process').ChildProcess>} 正在跑的子进程，取消时要杀掉 */
  #running = new Set()
  /** @type {{prefix: string, at: number}|null} 上次测速选中的反代，见 {@link PROXY_TTL} */
  #proxyCache = null
  /**
   * 调度注册代次。applySchedule 要动态 import，热重载 / 连点保存时旧调用可能比新调用晚返回；
   * 只允许最后一代真正挂 job。
   */
  #scheduleGeneration = 0

  // ------------------------------------------------------------------ 扫描

  /**
   * 扫出所有可备份的条目。
   *
   * @param {boolean} [force] 忽略缓存重新扫
   * @return {Promise<object>} `{root: {entries}, plugins: [...], limits, scannedAt}`
   */
  async scan(force = false) {
    if (!force && this.#scanCache && Date.now() - this.#scanCache.at < SCAN_TTL) {
      return this.#scanCache.data
    }
    const rootRes = await discoverTarget(this.root, {
      prefix: 'root', excludes: this.excludes, splitPlugins: true,
    })
    const plugins = await this.#scanPlugins(rootRes.pluginDirs)
    const data = {
      root: {
        entries: rootRes.entries,
        deleted: rootRes.deleted,
        isRepo: rootRes.isRepo,
      },
      plugins,
      limits: DISCOVER_LIMITS,
      scannedAt: Date.now(),
    }
    this.#scanCache = {data, at: Date.now()}
    return data
  }

  /** 逐个插件扫，并发 {@link SCAN_CONCURRENCY} —— 串行的话 29 个插件要 7 秒 */
  async #scanPlugins(names) {
    const queue = [...names].sort((a, b) => a.localeCompare(b))
    const out = []
    const worker = async () => {
      for (;;) {
        const name = queue.shift()
        if (!name) return
        const dir = path.join(this.root, 'plugins', name)
        const prefix = `plugin:${name}`
        try {
          const info = await repoInfo(dir)
          // 只把当前锅巴安装白名单内的地址交给前端 / manifest；其它 HTTP remote 虽然语法
          // 正确，但还原时一定会被拒绝，不应冒充「可克隆地址」。origin 不在白名单而镜像在时，
          // 镜像会成为首选；全部都不允许则按无地址处理，避免还原时才发现。
          const remotes = (info.remotes ?? []).filter((it) => this.#remoteAllowed(it.url).ok)
          const entries = info.git
            ? (await discoverTarget(dir, {prefix, excludes: this.excludes, includeGitDir: true})).entries
            : discoverPlain(dir, {prefix, excludes: this.excludes})
          out.push({
            name, ...info, remote: remotes[0]?.url || '', remotes, noGit: !info.git, entries,
          })
        } catch (err) {
          logger.warn(`[Guoba] 扫描插件 ${name} 失败：${err.message}`)
          out.push({name, git: false, noGit: true, entries: [], error: err.message})
        }
      }
    }
    await Promise.all(Array.from({length: SCAN_CONCURRENCY}, worker))
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  // ------------------------------------------------------------------ 备份包管理

  /** 备份目录里的包，新的在前 */
  list() {
    if (!fs.existsSync(this.backupDir)) return []
    const out = []
    for (const name of fs.readdirSync(this.backupDir)) {
      if (!PACK_NAME_RE.test(name)) continue
      const abs = path.join(this.backupDir, name)
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      out.push({name, size: st.size, mtime: st.mtimeMs, summary: this.#quickSummary(abs)})
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  /** 列表里显示的一行摘要，读不出来就算了（包可能是坏的 / 别人的） */
  #quickSummary(abs) {
    try {
      const m = this.#readManifest(abs)
      return {
        note: m.note || '',
        createdAt: m.createdAt || '',
        entries: m.entries?.length ?? 0,
        plugins: m.plugins?.length ?? 0,
        totalSize: m.totalSize ?? 0,
      }
    } catch {
      return null
    }
  }

  /**
   * 包名 → 绝对路径。
   *
   * 名字必须是纯文件名，不能带路径分隔符 —— 否则 `../../config/config.yaml` 之类的名字
   * 就能让删除接口删到备份目录外面去。
   */
  absOf(name) {
    const clean = String(name ?? '').trim()
    if (!PACK_NAME_RE.test(clean)) throw new GuobaError('备份包名不合法')
    const abs = path.join(this.backupDir, clean)
    if (path.dirname(abs) !== this.backupDir) throw new GuobaError('备份包名不合法')
    if (!fs.existsSync(abs)) throw new GuobaError('备份包不存在')
    return abs
  }

  remove(name) {
    const clean = String(name ?? '').trim()
    if (this.#task && !this.#task.done && path.basename(this.#task.file) === clean) {
      throw new GuobaError('这个备份包正在使用，任务结束后再删除')
    }
    fs.rmSync(this.absOf(clean), {force: true})
    return true
  }

  /**
   * 上传外部备份包。multer 已经把文件落到 data/upload_tmp/。
   * 多文件上传按事务处理：任意一个包无效就回滚本批已经移入备份目录的包，避免接口报错但
   * 实际留下半批结果；无论失败发生在 rename 前后，都尽力清理临时文件。
   */
  async saveUpload(files) {
    const list = Array.isArray(files) ? files : (files ? [files] : [])
    if (!list.length) throw new GuobaError('没有收到文件')
    fs.mkdirSync(this.backupDir, {recursive: true})
    const saved = []
    const tempPaths = list.map((file) => file.path || file.filepath).filter(Boolean)
    try {
      for (const file of list) {
        const origin = file.originalname || file.name || 'backup.zip'
        if (!/\.zip$/i.test(origin)) throw new GuobaError('只支持 .zip 备份包')
        if (file.size > MAX_UPLOAD_SIZE) throw new GuobaError('备份包过大')
        const name = this.#uniqueName(this.#safePackName(origin))
        const dest = path.join(this.backupDir, name)
        const tmp = file.path || file.filepath
        try {
          fs.renameSync(tmp, dest)
        } catch {
          // 跨设备 rename 会失败（upload_tmp 和备份目录可能不在一个挂载点）
          fs.copyFileSync(tmp, dest)
          fs.rmSync(tmp, {force: true})
        }
        // 上传的包必须能读出 manifest，不然还原时才发现就晚了
        try {
          this.#readManifest(dest)
        } catch (err) {
          fs.rmSync(dest, {force: true})
          throw new GuobaError(`不是有效的锅巴备份包：${err.message}`)
        }
        saved.push(name)
      }
      return saved
    } catch (err) {
      for (const name of saved) fs.rmSync(path.join(this.backupDir, name), {force: true})
      for (const tmp of tempPaths) fs.rmSync(tmp, {force: true})
      throw err
    }
  }

  /** 上传文件名里可能有中文、空格、路径 —— 一律洗成安全形态 */
  #safePackName(origin) {
    const base = path.basename(String(origin)).replace(/\.zip$/i, '')
    const clean = base.replace(/[^\w.-]+/g, '_').replace(/^[.]+/, '').slice(0, 80)
    return `${clean || 'backup'}.zip`
  }

  #uniqueName(name) {
    let out = name
    let i = 1
    while (fs.existsSync(path.join(this.backupDir, out))) {
      out = name.replace(/\.zip$/i, `-${i++}.zip`)
    }
    return out
  }

  /** 读包里的 manifest */
  #readManifest(abs) {
    const {entries} = readEntries(abs)
    const entry = entries.find((e) => e.name === MANIFEST_NAME)
    if (!entry) throw new GuobaError('包里没有 manifest.json')
    let manifest
    try {
      manifest = JSON.parse(readEntryBuffer(abs, entry).toString('utf8'))
    } catch (err) {
      throw new GuobaError(`manifest.json 解析失败：${err.message}`)
    }
    if (manifest?.version > MANIFEST_VERSION) {
      throw new GuobaError(`备份包版本（v${manifest.version}）比当前锅巴新，请先升级锅巴`)
    }
    return manifest
  }

  /**
   * 还原前的预览：包里有什么、跟本地比缺哪些插件。
   *
   * @param {string} name 备份包名
   */
  async inspect(name) {
    const abs = this.absOf(name)
    const manifest = this.#readManifest(abs)
    const installed = this.#installedPlugins()
    const plugins = (manifest.plugins ?? []).map((p) => {
      const remotes = this.#remoteCandidates(p).map((it) => ({
        ...it, allowed: this.#remoteAllowed(it.url).ok,
      }))
      return {
        ...p,
        remotes,
        installed: installed.has(p.name),
        // 候选里有一个过白名单就装得上；只有非 git 插件没有地址时才算可按文件还原
        allowed: (!p.git && !p.remote) || remotes.some((it) => it.allowed),
      }
    })
    return {
      name,
      manifest: {...manifest, plugins},
      installed: [...installed].sort(),
    }
  }

  /** 本地已装的插件目录名 */
  #installedPlugins() {
    const dir = path.join(this.root, 'plugins')
    if (!fs.existsSync(dir)) return new Set()
    return new Set(fs.readdirSync(dir, {withFileTypes: true})
      .filter((it) => it.isDirectory())
      .map((it) => it.name))
  }

  // ------------------------------------------------------------------ 打包

  /**
   * 新建备份。后台跑，进度靠 {@link taskStatus} 轮询。
   *
   * @param {object} opts
   * @param {string[]} opts.keys 勾选的条目 key（`root|data/PlayerData` 这种）
   * @param {string} [opts.note] 备注，写进 manifest
   * @return {Promise<object>} 任务初始状态
   */
  async create({keys, note = ''} = {}) {
    const picked = this.#normalizeKeys(keys)
    if (!picked.length) throw new GuobaError('没有勾选任何要备份的内容')
    this.#startTask('create')
    const fileName = this.#uniqueName(`guoba-backup-${stamp()}.zip`)
    this.#task.file = fileName
    // 不 await：接口立刻返回，前端轮询 /backup/task 看进度
    this.#runCreate(picked, note, fileName).catch((err) => this.#failTask(err))
    return this.taskStatus()
  }

  async #runCreate(keys, note, fileName) {
    const scanned = await this.scan()
    const plan = this.#buildPlan(keys, scanned)
    if (!plan.items.length) throw new GuobaError('勾选的条目在当前目录下都不存在了，请重新扫描')

    this.#log(`共 ${plan.items.length} 个条目，开始收集文件`)
    const files = []
    /** 条目之间可能有嵌套（`resources` 和 `resources/profile`），同一个文件只收一次 */
    const seenNames = new Set()
    let totalBytes = 0
    for (const item of plan.items) {
      for (const rel of item.paths) {
        const abs = path.join(this.root, item.base, rel)
        const entryBase = item.base ? `${item.base}/${rel}` : rel
        // `.git` 是唯一走 raw 的条目：通用黑名单会把它挖残，见 #walk
        for (const f of this.#walk(abs, entryBase, {raw: rel === GIT_DIR_REL})) {
          if (seenNames.has(f.entryName)) continue
          seenNames.add(f.entryName)
          files.push(f)
          totalBytes += f.size
        }
      }
      this.#throwIfCanceled()
    }
    if (!files.length) throw new GuobaError('勾选的条目里没有可备份的文件')

    this.#task.total = files.length
    this.#task.totalBytes = totalBytes
    this.#log(`收集到 ${files.length} 个文件，共 ${fmtSize(totalBytes)}`)

    fs.mkdirSync(this.backupDir, {recursive: true})
    const dest = path.join(this.backupDir, fileName)
    const zip = new ZipWriter(dest)
    await zip.open()
    let ok = false
    try {
      // manifest 放最前面：只读摘要时不用扫整个中央目录
      const manifest = {
        version: MANIFEST_VERSION,
        createdAt: new Date().toISOString(),
        note: String(note ?? '').slice(0, 500),
        bot: this.#botInfo(),
        totalFiles: files.length,
        totalSize: totalBytes,
        entries: plan.items.map((it) => ({
          key: it.key, target: it.target, rel: it.rel, paths: it.paths,
          size: it.size, files: it.files,
        })),
        plugins: plan.plugins,
        deleted: scanned.root.deleted ?? [],
      }
      await zip.addBuffer(MANIFEST_NAME, JSON.stringify(manifest, null, 2))

      this.#task.phase = 'packing'
      const failedFiles = []
      for (const f of files) {
        this.#throwIfCanceled()
        if (f.isDir) {
          await zip.addDirectory(FILES_PREFIX + f.entryName)
        } else {
          try {
            if (f.sanitize === 'git-config') {
              await zip.addBuffer(FILES_PREFIX + f.entryName, this.#gitConfigBuffer(f.abs),
                {mtime: f.stat?.mtime, mode: 0o644})
            } else {
              await zip.addFile(FILES_PREFIX + f.entryName, f.abs, {stat: f.stat})
            }
          } catch (err) {
            failedFiles.push({name: f.entryName, reason: err.message})
            this.#log(`打包 ${f.entryName} 失败：${err.message}`, 'error')
          }
        }
        this.#task.current++
        this.#task.bytes += f.size
      }
      // 用户勾选的是备份承诺，不允许少文件的 ZIP 冒充成功；不完整包由 finally 删除
      if (failedFiles.length) {
        throw new GuobaError(`有 ${failedFiles.length} 个文件打包失败，已取消生成不完整备份`)
      }
      const res = await zip.finalize()
      ok = true
      this.#task.packSize = res.bytes
      this.#log(`备份完成：${fileName}（${fmtSize(res.bytes)}）`)
      // 清理日志也属于这次任务：先清理再标 done，否则前端看到 done 就停轮询，日志永远看不到；
      // 也避免下一次任务在旧包还没删完时就进来
      await this.#applyRetention()
      this.#finishTask({file: fileName, size: res.bytes, files: files.length})
    } finally {
      if (!ok) {
        await zip.abort().catch(() => {})
        fs.rmSync(dest, {force: true})
      }
    }
  }

  /**
   * 勾选的 key → 实际要打包的条目 + 插件清单。
   *
   * 插件清单收的是**所有**已装插件，不只是勾了条目的那些 —— 搬家时最想要的就是「新机器上
   * 把插件全拉回来」，而多数插件本来就没有用户配置（本机 29 个里有 2 个一个条目都没有）。
   */
  #buildPlan(keys, scanned) {
    const wanted = new Set(keys)
    const items = []
    const seen = new Set()

    /**
     * 勾了 `resources` 又勾了 `resources/profile`：父目录已经把子目录整个收进去了，
     * 子条目再打一遍就是重复文件、重复体积。条目全量列出后这种嵌套是常态，必须挡。
     */
    const coveredByParent = (target, rel) => {
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        if (wanted.has(`${target}|${parts.slice(0, i).join('/')}`)) return true
      }
      return false
    }

    const take = (entry, target, base) => {
      if (!wanted.has(entry.key) || seen.has(entry.key)) return
      seen.add(entry.key)
      if (coveredByParent(target, entry.rel)) return
      items.push({
        key: entry.key, target, base, rel: entry.rel, paths: entry.paths,
        size: entry.size, files: entry.files,
      })
    }
    for (const entry of scanned.root.entries) take(entry, 'root', '')
    for (const p of scanned.plugins) {
      for (const entry of p.entries) take(entry, `plugin:${p.name}`, `plugins/${p.name}`)
    }

    const plugins = scanned.plugins.map((p) => {
      const keys = p.entries.filter((e) => wanted.has(e.key)).map((e) => e.key)
      return {
        name: p.name,
        git: !!p.git,
        noGit: !!p.noGit,
        remote: sanitizeRemote(p.remote || ''),
        // 新包记录所有可 clone remote；保留上面的 remote 单值兼容旧锅巴
        remotes: (p.remotes ?? []).map((it) => ({
          name: String(it.name || ''), url: sanitizeRemote(it.url || ''),
        })).filter((it) => it.url),
        branch: p.branch || '',
        commit: p.commit || '',
        dirty: !!p.dirty,
        keys,
        // 必须明确记账，不能靠包里出现 package.json 猜：用户完全可以只手动勾这一个文件
        whole: p.entries.length > 0 && keys.length === p.entries.length,
        /**
         * 包里带着这个插件的 `.git` 吗。
         *
         * 还原侧靠它决定「能不能跳过 clone」：没有 `.git` 的整份还原会铺出一个不是仓库的
         * 插件目录，git 命令会往上找到云崽本体 —— 更新插件变成更新云崽。见 #runRestore。
         */
        hasGitDir: keys.includes(`plugin:${p.name}|${GIT_DIR_REL}`),
      }
    })
    return {items, plugins}
  }

  /** Yunzai / 锅巴版本，还原时能看出包是哪个版本生成的 */
  #botInfo() {
    const read = (rel) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.root, rel), 'utf8'))
      } catch {
        return {}
      }
    }
    const bot = read('package.json')
    const guoba = read(path.relative(this.root, path.join(_paths.pluginRoot, 'package.json')))
    return {
      name: bot.name || '',
      version: bot.version || '',
      guobaVersion: guoba.version || '',
      node: process.version,
      platform: process.platform,
    }
  }

  /**
   * 收集一个路径下要打包的文件。
   *
   * 黑名单和 excludes 跟扫描时用的是同一套（`node_modules` / `logs` / 备份目录自己），
   * 不然勾了 `plugins/example` 就会把它 56 M 的 node_modules 一起打进去。
   *
   * @param {string} abs 绝对路径
   * @param {string} entryName 包内路径（不含 {@link FILES_PREFIX}）
   * @param {object} [opts]
   * @param {boolean} [opts.raw] `.git` 专用：不套通用黑名单，换成 {@link GIT_SKIP_RE}。
   *   通用黑名单会挖掉 `.git/logs/`（`logs` 在 SKIP_NAMES 里）和 `.git/**\/*.pid`
   *   （`.pid` 在 SKIP_EXT 里），残缺的仓库还原出来是坏的
   */
  * #walk(abs, entryName, {raw = false} = {}) {
    let st
    try {
      st = fs.lstatSync(abs)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    if (this.excludes.has(abs)) return
    if (st.isFile()) {
      // git 的 config 文件里存着明文凭证，不能原样进包。`.git/modules/<子模块>/config`
      // 也是同一种文件，同样要过一遍，见 #gitConfigBuffer
      const sanitize = raw && GIT_CONFIG_NAME_RE.test(path.basename(entryName)) ? 'git-config' : ''
      yield {abs, entryName, size: st.size, stat: st, isDir: false, sanitize}
      return
    }
    if (!st.isDirectory()) return
    let items
    try {
      items = fs.readdirSync(abs, {withFileTypes: true})
    } catch {
      return
    }
    if (!items.length) {
      // 空目录也要留痕，否则还原后目录不存在，有些插件会报错
      yield {abs, entryName: `${entryName}/`, size: 0, isDir: true}
      return
    }
    for (const it of items) {
      if (raw ? GIT_SKIP_RE.test(it.name) : shouldSkipName(it.name)) continue
      yield * this.#walk(path.join(abs, it.name), `${entryName}/${it.name}`, {raw})
    }
  }

  /**
   * `.git/config` 的脱敏版本，见 {@link sanitizeGitConfig}。
   *
   * 备份包会被下载、可能转发给别人，仓库 config 里的 `user:token@` 绝不能跟着走出去。
   */
  #gitConfigBuffer(abs) {
    return sanitizeGitConfig(fs.readFileSync(abs, 'utf8'))
  }

  #normalizeKeys(keys) {
    if (!Array.isArray(keys)) return []
    return [...new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean))]
  }

  /**
   * 还原请求里的逐插件手选 URL。这里只做形状 / 插件名过滤；URL 是否真属于该插件的 manifest
   * 在读包后由 {@link #validateCloneRemotes} 校验，不能信任前端。
   */
  #normalizeCloneRemotes(value, plugins) {
    const out = new Map()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out
    const wanted = new Set(plugins)
    for (const [name, raw] of Object.entries(value)) {
      const url = sanitizeRemote(raw)
      if (PLUGIN_NAME_RE.test(name) && wanted.has(name) && url) out.set(name, url)
    }
    return out
  }

  /** 手选 URL 必须是该插件清单内、且当前白名单允许的精确候选 */
  #validateCloneRemotes(selected, byName) {
    for (const [name, url] of selected) {
      const candidates = this.#remoteCandidates(byName.get(name))
      if (!candidates.some((it) => it.url === url)) {
        throw new GuobaError(`${name}：手动指定的仓库地址不在备份清单里`)
      }
      const check = this.#remoteAllowed(url)
      if (!check.ok) throw new GuobaError(`${name}：${check.reason}`)
    }
  }

  // ------------------------------------------------------------------ 还原

  /**
   * 还原。后台跑，进度靠 {@link taskStatus} 轮询。
   *
   * 三个阶段，顺序都有讲究：
   *
   * 1. **clone 缺的插件**。得在解文件之前 —— 插件目录已经有文件了，`git clone` 到非空目录
   *    会直接失败。
   * 2. **解文件**，原路写回。
   * 3. **装依赖**（`autoNpmInstall`）。必须在解文件之后：`package.json` 是这一步才落地的，
   *    早装等于按本机旧的那份装，白装。见 {@link #installDeps}。
   *
   * @param {object} opts
   * @param {string} opts.file 备份包名
   * @param {string[]} opts.keys 要还原的条目 key
   * @param {string[]} [opts.plugins] 要 clone 的插件名（本地没装的那些）
   * @param {Record<string, string>} [opts.cloneRemotes] 插件名 → 手动指定的 manifest 候选 URL
   * @param {boolean} [opts.autoNpmInstall] 还原完是否在 Yunzai 根跑一次 `pnpm install`
   * @param {boolean} [opts.autoRestart] 全部完成后是否重启 Bot（依赖没装上时会跳过）
   */
  async restore({file, keys, plugins = [], cloneRemotes = {}, autoNpmInstall = false, autoRestart = false} = {}) {
    const abs = this.absOf(file)
    const picked = this.#normalizeKeys(keys)
    const wantPlugins = this.#normalizeKeys(plugins)
    const selectedRemotes = this.#normalizeCloneRemotes(cloneRemotes, wantPlugins)
    if (!picked.length && !wantPlugins.length) throw new GuobaError('没有勾选任何要还原的内容')
    this.#startTask('restore')
    this.#task.file = path.basename(abs)
    this.#runRestore({
      abs, keys: picked, plugins: wantPlugins, cloneRemotes: selectedRemotes,
      autoNpmInstall, autoRestart,
    })
      .catch((err) => this.#failTask(err))
    return this.taskStatus()
  }

  async #runRestore({abs, keys, plugins, cloneRemotes, autoNpmInstall, autoRestart}) {
    const manifest = this.#readManifest(abs)
    const result = {
      cloned: [], cloneSources: {}, copied: [], skipped: [], failed: [], fileFailures: [],
      pending: [], restored: 0, backupDir: '',
      /** @type {string[]} 还原完仍然没有 `.git` 的 git 插件 —— 它们更新不了，见 #runRestore 末尾 */
      noGit: [],
      /** @type {object|null} 阶段三的结果，见 {@link #installDeps} */
      deps: null,
      /** 每个插件 clone / 解文件后立刻执行的依赖安装结果 */
      pluginDeps: [],
      /** 依赖没装上时不重启，见 {@link #runRestore} 末尾 */
      restartSkipped: false,
    }

    // 先把「要解哪些文件」算出来 —— 阶段一要靠它判断哪些插件压根不用 clone
    const prefixes = this.#restorePrefixes(manifest, keys)
    const {entries} = readEntries(abs)
    const targets = entries.filter((e) =>
      e.name !== MANIFEST_NAME && matchAnyPrefix(e.name, prefixes))

    // ---- 阶段一 / 二 / 插件依赖：每个插件按 clone → 解文件 → 安装依赖顺序处理 ----
    const byName = new Map((manifest.plugins ?? []).map((p) => [p.name, p]))
    this.#validateCloneRemotes(cloneRemotes, byName)
    const unavailable = new Set()
    const installedNow = this.#installedPlugins()
    /** 包里够完整、可以直接按文件还原、不用 clone 的插件 */
    const byFiles = new Set()
    /**
     * 文件够完整但缺 `.git` 的插件：先试 clone（为了拿回仓库），clone 不通就退回按文件还原。
     * 全是改动前的旧包会落到这里 —— 离线环境下不能因为「拿不到 .git」就干脆不装。
     */
    const fileFallback = new Set()
    const requestedPlugins = new Set(plugins)
    const pluginTargets = new Map()
    const rootTargets = []
    for (const entry of targets) {
      const rel = entry.name.slice(FILES_PREFIX.length)
      const m = rel.match(/^plugins\/([^/]+)\//)
      // `plugins/adapter` / `system` / `other` 是 Bot 根条目，不在 manifest.plugins 里，
      // 不能误当成待安装插件分组，否则会被改道进 pending
      if (m && byName.has(m[1])) {
        const list = pluginTargets.get(m[1]) ?? []
        list.push(entry)
        pluginTargets.set(m[1], list)
      } else {
        rootTargets.push(entry)
      }
    }
    const selectedKeys = new Set(keys)
    for (const name of plugins) {
      const info = byName.get(name)
      // 包里完整还不够：本次还原也得把备份时的全部插件条目都勾上。否则用户只还原 config，
      // 却因 manifest.whole 跳过 clone，最终仍会得到残缺插件
      if (info?.whole !== true || !Array.isArray(info.keys) || !info.keys.length) continue
      if (!info.keys.every((key) => selectedKeys.has(key))) continue
      // 「文件齐全」不等于「能当仓库用」：git 插件还得带着 `.git`。少了它，铺出来的目录不是
      // 仓库，git 会一路往上找到云崽本体 —— 更新插件就变成了更新云崽。
      // 这种包（含所有改动前生成的旧包，`.git` 压根不进包）先去 clone 把仓库拿回来，clone
      // 不通再退回按文件还原 —— 离线搬家至少还能把插件装上，见 fileFallback。
      if (info.git === true && info.hasGitDir !== true) {
        this.#log(`${name}：包里没有 .git，先尝试 clone 把仓库拿回来（否则插件没法更新）`, 'warn')
        fileFallback.add(name)
        continue
      }
      byFiles.add(name)
    }

    this.#task.phase = 'extracting'
    this.#task.current = 0
    this.#task.total = targets.length
    this.#task.bytes = 0
    this.#task.totalBytes = targets.reduce((s, e) => s + e.size, 0)
    this.#log(`待还原 ${targets.length} 个文件，共 ${fmtSize(this.#task.totalBytes)}`)
    const bakDir = path.join(this.backupDir, `${RESTORE_BAK_PREFIX}${stamp()}`)
    result.backupDir = path.relative(this.root, bakDir)

    // 根配置 / 数据先落地，插件逐个处理时 package.json 才是包里的最终版本
    await this.#extractEntries(abs, rootTargets, bakDir, unavailable, result)
    const orderedPlugins = [...new Set([...plugins, ...pluginTargets.keys()])]
    // 只有「请求安装、本地没装、包里也不是整份」的插件才会真 clone。拿全部插件去测速的话，
    // 一台插件都装齐的机器只还原 config 也要白等几秒线路探测
    const willClone = orderedPlugins.filter((name) =>
      requestedPlugins.has(name) && !installedNow.has(name) && !byFiles.has(name))
    // 只拿本次真会尝试的 URL 测速：手选一个就别拿其它候选干扰线路判断
    const cloneUrls = willClone.flatMap((name) => {
      const selected = cloneRemotes.get(name)
      return selected ? [selected] : this.#remoteCandidates(byName.get(name)).map((it) => it.url)
    })
    const proxy = cloneUrls.length ? await this.#pickProxy(cloneUrls) : ''
    for (const name of orderedPlugins) {
      this.#throwIfCanceled()
      const info = byName.get(name)
      let available = installedNow.has(name) || byFiles.has(name)
      // 只对「请求安装」的插件记跳过原因：勾了配置的已装插件全列出来只会刷屏
      if (installedNow.has(name)) {
        if (requestedPlugins.has(name)) result.skipped.push({name, reason: '已安装，跳过 clone'})
      } else if (byFiles.has(name)) {
        available = true
        this.#log(`${name}：备份时明确勾选了全部条目（含 .git），按文件还原，不 clone`)
        result.copied.push(name)
      } else if (requestedPlugins.has(name)) {
        this.#task.phase = 'cloning'
        const selected = cloneRemotes.get(name) || ''
        const res = await this.#clonePlugin(name, info, proxy, selected)
        if (res.ok) {
          available = true
          result.cloned.push(name)
          if (res.source) result.cloneSources[name] = res.source
        } else if (res.skipped) {
          available = true
          result.skipped.push({name, reason: res.reason})
        } else if (fileFallback.has(name)) {
          // 包里的文件是整份的，clone 只是为了把 .git 拿回来。拿不到就先让插件能用 ——
          // 但必须说清代价：目录里没有仓库，它更新不了，得手动 clone 一份或重新备份。
          available = true
          result.copied.push(name)
          result.skipped.push({
            name,
            reason: `clone 失败（${res.reason}），已按包内文件还原；目录里没有 .git，该插件无法 git 更新`,
          })
          this.#log(`${name}：clone 失败，退回按文件还原 —— 没有 .git，这个插件更新不了`, 'warn')
        } else {
          result.failed.push({name, reason: res.reason})
          unavailable.add(name)
          available = false
        }
      } else {
        unavailable.add(name)
        available = false
      }
      const entriesForPlugin = pluginTargets.get(name) ?? []
      await this.#extractEntries(abs, entriesForPlugin, bakDir, unavailable, result)
      if (available && autoNpmInstall) {
        this.#task.phase = 'installing'
        const dep = await this.#installPluginDeps(name)
        result.pluginDeps.push(dep)
      }
    }

    if (unavailable.size) {
      result.pending = [...unavailable]
      this.#log(
        `${[...unavailable].join('、')} 没能装上，它们的文件暂存在 ${BACKUP_DIR}/${PENDING_DIR}/，`
        + '装好插件后再还原一次即可', 'warn')
    }
    // 不管走的哪条路，最后再照一遍：备份包里记着是 git 仓库、现在目录里却没有 `.git` 的
    // 插件必须点名。它们看着装好了，实际一更新就会去动云崽本体的仓库。
    result.noGit = orderedPlugins.filter((name) => byName.get(name)?.git === true
      && !unavailable.has(name)
      && fs.existsSync(path.join(this.root, 'plugins', name))
      && !fs.existsSync(path.join(this.root, 'plugins', name, GIT_DIR_REL)))
    if (result.noGit.length) {
      this.#log(
        `${result.noGit.join('、')} 目录里没有 .git，这些插件无法 git 更新（更新命令会误伤云崽本体，`
        + '锅巴已在更新入口挡住）。请手动 clone 一份，或备份时把插件的 .git 条目一起勾上', 'warn')
    }
    if (fs.existsSync(bakDir)) {
      this.#log(`被覆盖的原文件已存进 ${result.backupDir}`)
    } else {
      result.backupDir = ''
    }
    this.#log(`还原完成：${result.restored} 个文件`
      + (result.cloned.length ? `，新装插件 ${result.cloned.length} 个` : ''))

    // ---- 阶段三：装依赖 ----
    // 必须在阶段二之后：package.json 是刚才解出来的，现在才是备份里那份
    if (autoNpmInstall) {
      this.#task.phase = 'installing'
      result.deps = await this.#installDeps()
      this.#throwIfCanceled()
    }

    // 某个插件安装失败、根 pnpm 失败或体检仍有缺包，都不该重启
    const pluginDepsFailed = result.pluginDeps.some((it) => !it.ok)
    result.restartSkipped = autoRestart && (result.fileFailures.length > 0 || pluginDepsFailed || (!!result.deps
      && (!result.deps.ok || result.deps.missing.length > 0)))
    if (result.restartSkipped) {
      const cmd = result.deps?.addCmd || 'pnpm install'
      this.#log('依赖没装齐，已跳过自动重启 —— 现在重启插件会大面积报缺依赖。'
        + `请手动执行 ${cmd}，成功后再重启 Bot`, 'error')
    }
    // 重启模块先加载成功，再结束任务：前端拿到 done 就停轮询，之后的导入错误看不见
    let doRestart
    if (autoRestart && !result.restartSkipped) {
      ({doRestart} = await import('../../../utils/botActions.js'))
      this.#log('即将重启 Bot')
    }
    this.#finishTask(result)

    if (doRestart) setTimeout(() => doRestart(), 1000)
  }

  /** 解一组条目。插件不可用时通过 unavailable 自动改道进 `.pending-restore`。 */
  async #extractEntries(abs, entries, bakDir, unavailable, result) {
    for (const entry of entries) {
      this.#throwIfCanceled()
      const rel = entry.name.slice(FILES_PREFIX.length)
      const redirect = redirectFor(rel, unavailable)
      const destRoot = redirect ? path.join(this.backupDir, PENDING_DIR) : this.root
      const destRel = redirect || rel
      const dest = safeJoin(destRoot, destRel)
      if (!dest) {
        this.#log(`跳过越界路径：${entry.name}`, 'warn')
        continue
      }
      let backup = ''
      try {
        if (entry.name.endsWith('/')) {
          fs.mkdirSync(dest, {recursive: true})
        } else {
          if (!redirect) backup = this.#backupExisting(dest, rel, bakDir)
          await extractEntry(abs, entry, dest)
          if (!redirect && this.keepLocal.has(rel)) this.#keepLocalFields(dest, bakDir, rel)
          result.restored++
        }
      } catch (err) {
        // 旧文件已经挪走、但新文件解压/CRC 校验失败时必须立刻放回去；不然虽然
        // .restore-bak 里还能手工救，Bot 当前配置已经凭空消失了
        if (backup) this.#restoreExisting(backup, dest, rel)
        result.fileFailures.push({name: rel, reason: err.message})
        this.#log(`还原 ${rel} 失败：${err.message}`, 'warn')
      }
      this.#task.current++
      this.#task.bytes += entry.size
    }
  }

  /**
   * 选中的条目 key → 包内路径前缀。
   *
   * manifest 里每个条目都记了它当初打包的 `paths`，所以这里不用猜 —— 把 target 换算成
   * 目录前缀（`root` → 空，`plugin:xxx` → `plugins/xxx/`）拼上就是包内路径。
   */
  #restorePrefixes(manifest, keys) {
    const wanted = new Set(keys)
    const out = []
    for (const entry of manifest.entries ?? []) {
      if (!wanted.has(entry.key)) continue
      const base = baseOfTarget(entry.target)
      for (const rel of entry.paths ?? [entry.rel]) {
        // paths 里的 '.' 表示整个插件目录（非 git 插件就是这种）
        const joined = rel === '.' ? base : (base ? `${base}/${rel}` : rel)
        if (joined) out.push(FILES_PREFIX + joined)
      }
    }
    return out
  }

  /** 锅巴自己的用户配置在包里 / 磁盘上的相对路径 */
  #guobaCfgRel() {
    return `plugins/${path.basename(_paths.pluginRoot)}/config/application.yaml`
  }

  /**
   * 还原完这个 yaml 之后，把「换了机器就会坏」的那几项填回本机的值。
   *
   * 备份包里这些字段是完整的（备份不做任何删减），只是还原时不拿它们盖本机的 ——
   * 盖了的话：bot 不认主人（`masterQQ`）、渲染崩（`chromium_path` 指向另一个系统的路径）、
   * 图片链接失效（`server.yaml` 的 url 是旧 IP）、锅巴把你踢回登录页（`jwt.secret`）。
   *
   * 本机原样在 `.restore-bak-*` 里有完整一份，从那儿取。
   */
  #keepLocalFields(dest, bakDir, rel) {
    const fields = this.keepLocal.get(rel)
    const localFile = path.join(bakDir, rel)
    // 本机压根没这个文件（全新装的机器）就不用管，包里那份直接生效
    if (!fields || !fs.existsSync(localFile)) return
    try {
      const local = YAML.parse(fs.readFileSync(localFile, 'utf8')) ?? {}
      const doc = YAML.parseDocument(fs.readFileSync(dest, 'utf8'))
      const kept = []
      for (const f of fields) {
        const parts = f.split('.')
        const value = parts.reduce((o, k) => (o == null ? o : o[k]), local)
        if (value === undefined) continue
        doc.setIn(parts, value)
        kept.push(f)
      }
      if (!kept.length) return
      fs.writeFileSync(dest, doc.toString())
      this.#log(`${rel}：${kept.join('、')} 保持本机原样`)
    } catch (err) {
      // 合并不了就把本机那份整个放回去 —— 宁可这个文件不还原，也不能让 bot 不认主人
      try {
        fs.copyFileSync(localFile, dest)
        this.#log(`${rel} 合并失败（${err.message}），已保留本机原样`, 'warn')
      } catch {
        this.#log(`${rel} 合并失败：${err.message}`, 'error')
      }
    }
  }

  /** 覆盖之前把原文件挪走。同一个相对路径在 bakDir 里保持原样，方便手工找回 */
  #backupExisting(dest, rel, bakDir) {
    let st
    try {
      st = fs.lstatSync(dest)
    } catch {
      return ''
    }
    if (!st.isFile()) return ''
    const bak = path.join(bakDir, rel)
    fs.mkdirSync(path.dirname(bak), {recursive: true})
    try {
      fs.renameSync(dest, bak)
    } catch {
      fs.copyFileSync(dest, bak)
    }
    return bak
  }

  /** 新文件写失败时把刚才挪走的旧文件放回原位 */
  #restoreExisting(bak, dest, rel) {
    try {
      fs.mkdirSync(path.dirname(dest), {recursive: true})
      fs.rmSync(dest, {force: true})
      try {
        fs.renameSync(bak, dest)
      } catch {
        fs.copyFileSync(bak, dest)
      }
      this.#log(`${rel}：新文件写入失败，已恢复原文件`, 'warn')
    } catch (err) {
      this.#log(`${rel}：原文件自动恢复失败，请从 ${path.relative(this.root, bak)} 手动取回：${err.message}`, 'error')
    }
  }

  /**
   * 挑一个最快的 GitHub 反代。
   *
   * 直连也参与比较（`''`），谁快用谁 —— 服务器在国外或者本来就通的话，套反代反而更慢。
   * 探的是 git 自己的 refs 接口（`/info/refs?service=git-upload-pack`），能同时验证
   * 「这个反代到底能不能用来 clone」，光 ping 首页是测不出来的。
   *
   * @param {string[]} remotes 待 clone 的仓库地址，用来判断有没有 GitHub 的
   * @return {Promise<string>} 反代前缀，直连是空串
   */
  async #pickProxy(remotes = []) {
    const urls = remotes.filter(Boolean)
    // 一个 GitHub 的都没有就别测了（gitee / gitcode 用不上反代）
    if (!urls.some((u) => /(^|\/\/)([^/]*\.)?github\.com\//i.test(u))) return ''
    const now = Date.now()
    if (this.#proxyCache && now - this.#proxyCache.at < PROXY_TTL) {
      const {prefix} = this.#proxyCache
      this.#log(`沿用刚测过的线路：${prefix || '直连'}`)
      return prefix
    }

    const configured = cfg.get('base.githubReverseProxy') ? cfg.get('base.githubProxyUrl') : ''
    const list = [
      '',
      ...(cfg.get('backup.githubProxies') || DEFAULT_PROXIES),
      configured,
    ]
    // 去重 + 统一带上结尾斜杠
    const candidates = [...new Set(list.map((p) => {
      const s = String(p ?? '').trim()
      if (!s) return ''
      return s.endsWith('/') ? s : `${s}/`
    }))]

    this.#log(`测试 ${candidates.length} 条线路的速度`)
    const probes = await Promise.all(candidates.map((prefix) => this.#probeProxy(prefix)))
    probes.sort((a, b) => a.ms - b.ms)
    for (const p of probes) {
      this.#log(`  ${p.prefix || '直连'}：${p.ok ? `${p.ms} ms` : p.reason}`, p.ok ? 'cmd' : 'warn')
    }
    const best = probes.find((p) => p.ok)
    if (!best) {
      this.#log('所有线路都不通，仍然按直连试一次', 'warn')
      return ''
    }
    this.#log(`选用线路：${best.prefix || '直连'}（${best.ms} ms）`)
    this.#proxyCache = {prefix: best.prefix, at: now}
    return best.prefix
  }

  /**
   * 探一条线路。
   *
   * **必须用 git 自己去探**，不能用 fetch —— 实测这台机器上 fetch 直连 github 超时，而
   * `git ls-remote` 1.1 秒就回来了（git 的代理/SSL 栈跟 Node 的不是一套），拿 fetch 测出来
   * 的结论会把最快的线路判成不可用。用 `ls-remote` 还顺带筛掉「只代理 raw/release、不支持
   * git 智能 HTTP」的反代（实测 github.akams.cn 和 hub.gitmirror.com 就是这种，几十毫秒
   * 就回一句「仓库不存在」，用 fetch 探则是一个看起来很快的 404）。
   */
  #probeProxy(prefix) {
    const url = `${prefix}${PROXY_PROBE_REPO}`
    return new Promise((resolve) => {
      const started = Date.now()
      let proc
      try {
        proc = spawn('git', gitArgs('ls-remote', '--heads', url), {
          cwd: this.root,
          windowsHide: true,
          env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo'},
        })
      } catch (err) {
        resolve({prefix, ok: false, ms: Infinity, reason: err.message})
        return
      }
      this.#running.add(proc)
      let out = ''
      let err = ''
      let settled = false
      let timedOut = false
      const done = (res) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#running.delete(proc)
        resolve(res)
      }
      proc.stdout?.on('data', (b) => {
        if (out.length < 4096) out += b
      })
      proc.stderr?.on('data', (b) => {
        if (err.length < 512) err += b
      })
      const timer = setTimeout(() => {
        timedOut = true
        this.#killTree(proc)
      }, PROXY_TIMEOUT)
      proc.on('error', (e) => done({prefix, ok: false, ms: Infinity, reason: e.message}))
      // 超时后只能等 exit：git 被杀掉后它 fork 出来的 git-remote-https 还攥着 stdout，
      // 管道不关 `close` 就不触发，实测有线路能因此卡两分钟
      proc.on('exit', () => {
        if (timedOut) done({prefix, ok: false, ms: Infinity, reason: `超时（>${PROXY_TIMEOUT / 1000}s）`})
      })
      proc.on('close', (code) => {
        if (code === 0 && out.includes('refs/heads/')) {
          done({prefix, ok: true, ms: Date.now() - started})
          return
        }
        const reason = timedOut
          ? `超时（>${PROXY_TIMEOUT / 1000}s）`
          : (err.trim().split('\n').pop() || `退出码 ${code}`).slice(0, 90)
        done({prefix, ok: false, ms: Infinity, reason})
      })
    })
  }

  /**
   * 结束一个子进程连带它拉起来的那些。
   *
   * `git` 只是个外壳，真正干网络活的是它 fork 出来的 `git-remote-https`。直接 SIGKILL
   * 外壳会把里面那个变成孤儿：继续占着网络，还攥着 stdout 让 `close` 事件发不出来。
   * 所以先 SIGTERM（git 会把信号传给子进程并自己清理），赖着不走的再 SIGKILL。
   */
  #killTree(proc) {
    if (!proc?.pid || proc.killed) return
    try {
      if (process.platform === 'win32') {
        // Windows 没有信号，taskkill /T 才能带走整棵进程树
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {windowsHide: true})
        return
      }
      proc.kill('SIGTERM')
      const {pid} = proc
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已经退了
        }
      }, 2000)
    } catch (err) {
      logger.warn(`[Guoba] 终止子进程失败：${err.message}`)
    }
  }

  /**
   * 包里的 remote 候选。新包有 `remotes[]`，旧包只有 `remote`，这里统一成同一个形状。
   * 所有值都再次 sanitize —— 上传的 manifest 是外部输入，不能相信它已经由本机生成过。
   */
  #remoteCandidates(info) {
    if (!info) return []
    const raw = Array.isArray(info.remotes) ? [...info.remotes] : []
    if (info.remote && !raw.some((it) => it?.url === info.remote)) {
      raw.unshift({name: 'origin', url: info.remote})
    }
    const seen = new Set()
    const out = []
    for (const it of raw) {
      const url = sanitizeRemote(typeof it === 'string' ? it : it?.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push({name: String(it?.name || ''), url})
    }
    return out
  }

  /**
   * clone 一个插件。一个仓库可能配了 origin / upstream / 镜像，按清单顺序逐个尝试；
   * 用户手选时只尝试该地址，失败不偷偷换源。
   *
   * @param {string} name
   * @param {object} info 包里的插件清单
   * @param {string} [proxy] {@link #pickProxy} 选出来的反代前缀
   * @param {string} [selectedUrl] 已通过清单校验的手选 URL
   * @return {Promise<{ok: boolean, skipped?: boolean, reason?: string, source?: object}>}
   */
  async #clonePlugin(name, info, proxy = '', selectedUrl = '') {
    if (!PLUGIN_NAME_RE.test(name)) return {ok: false, reason: '插件名不合法'}
    if (!info) return {ok: false, reason: '备份包里没有这个插件'}
    const dir = path.join(this.root, 'plugins', name)
    if (fs.existsSync(dir)) {
      return {ok: false, skipped: true, reason: '已安装，跳过'}
    }
    let candidates = this.#remoteCandidates(info)
    if (selectedUrl) {
      const selected = candidates.find((it) => it.url === selectedUrl)
      // 正常入口在 #normalizeCloneRemotes 已经验证过；这里再挡一层，防以后有别的调用绕过
      if (!selected) return {ok: false, reason: '手动指定的仓库地址不在备份清单里'}
      candidates = [selected]
      this.#log(`${name}：使用手动指定的 ${selected.name || 'remote'} ${selected.url}`)
    } else if (candidates.length > 1) {
      this.#log(`${name}：按清单自动尝试 ${candidates.length} 个仓库地址`)
    }
    if (!candidates.length) {
      // 非 git 插件没有 remote，包里的文件就是完整插件；git 仓库没地址则没法凭空安装
      if (!info.noGit) return {ok: false, reason: '备份里没记下可克隆的仓库地址，请手动安装'}
      fs.mkdirSync(dir, {recursive: true})
      this.#log(`${name}：备份里没有仓库地址，按文件直接还原`)
      return {ok: true}
    }

    const reasons = []
    for (const remote of candidates) {
      this.#throwIfCanceled()
      const check = this.#remoteAllowed(remote.url)
      if (!check.ok) {
        reasons.push(`${remote.name || remote.url}：${check.reason}`)
        this.#log(`${name}：跳过 ${remote.name || remote.url}（${check.reason}）`, 'warn')
        continue
      }
      const url = this.#proxyUrl(remote.url, proxy)
      const args = ['clone', '--depth', '1', '--single-branch']
      if (info.branch && /^[\w./-]+$/.test(info.branch)) args.push('-b', info.branch)
      args.push(url, dir)
      this.#log(`${name}：clone ${remote.name ? `${remote.name} ` : ''}${url}`
        + (info.branch ? ` (${info.branch})` : ''))
      const res = await this.#spawnLogged('git', args, {cwd: this.root})
      if (res.code === 0) {
        this.#log(`${name}：安装成功`)
        return {ok: true, source: {name: remote.name || '', url: remote.url}}
      }
      const reason = res.tail || `git clone 退出码 ${res.code}`
      reasons.push(`${remote.name || remote.url}：${reason}`)
      this.#log(selectedUrl
        ? `${name}：指定地址失败，不自动换源（${reason}）`
        : `${name}：这条地址失败，尝试下一个（${reason}）`, 'warn')
      // clone 失败会留下半个目录，不清掉的话下一条不能往同一个路径 clone
      fs.rmSync(dir, {recursive: true, force: true})
    }
    return {ok: false, reason: reasons.join('；') || '没有可用的仓库地址'}
  }

  /**
   * 远程地址白名单校验。
   *
   * 备份包可能来自别人，`remote` 是包里写的字符串 —— 不校验就等于「上传一个 zip 就能让
   * 服务器 clone 任意仓库」。校验规则跟插件安装那边一致（`base.gitInstallWhitelist`）。
   */
  #remoteAllowed(remote) {
    const url = String(remote || '').trim()
    if (!url) return {ok: false, reason: '没有仓库地址'}
    if (/[;&|`$(){}#!<>\s]/.test(url)) return {ok: false, reason: '仓库地址含非法字符'}
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return {ok: false, reason: `仓库地址无法解析：${url}`}
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {ok: false, reason: '只支持 http/https 仓库地址'}
    }
    const whitelist = cfg.get('base.gitInstallWhitelist')
      || ['github.com', 'gitee.com', 'gitlab.com', 'gitcode.com']
    const host = parsed.hostname.toLowerCase()
    const hit = whitelist.some((d) => host === d || host.endsWith(`.${d}`))
    if (!hit) {
      return {ok: false, reason: `${host} 不在 Git 安装白名单里，可在锅巴设置中添加`}
    }
    return {ok: true}
  }

  /**
   * 套上测速选出来的反代。只对 GitHub 生效 —— gitee / gitcode 本来就在国内。
   *
   * @param {string} repoUrl 原始地址（manifest 里存的一定是脱敏后的原始地址）
   * @param {string} [proxy] 反代前缀，空串表示直连
   */
  #proxyUrl(repoUrl, proxy = '') {
    if (!proxy || !/github\.com/.test(repoUrl)) return repoUrl
    return `${proxy}${repoUrl}`
  }

  /**
   * 给刚还原好的单个插件安装依赖。规则跟插件更新那边共用一套，见 utils/pluginDeps.js ——
   * 两处各有自己的子进程管理和任务日志，所以把这两件事注入进去。
   */
  async #installPluginDeps(name) {
    return installPluginDeps(this.root, name, {
      spawnLogged: (cmd, args, opts) => this.#spawnLogged(cmd, args, opts),
      log: (text, level) => this.#log(text, level),
    })
  }

  /**
   * 装依赖：在 **Yunzai 根**跑一次 `pnpm install`。
   *
   * 为什么是根目录、而不是逐个插件目录：Yunzai 是 pnpm workspace（`pnpm-workspace.yaml`
   * 里 `packages: ['plugins/**']`），根跑一次就把根和所有插件的依赖一次装齐。逐个插件跑
   * 反而是错的 —— pnpm 在 workspace 子目录里执行 install 装的还是整个 workspace，N 个插件
   * 就把整个 workspace 装 N 遍。
   *
   * 为什么非要装：还原写回的是 `package.json`（用户加过依赖，所以它一定是 modified、
   * 一定在包里），声明有了但 `node_modules` 里没有。不装就重启，Yunzai 加载插件时会满屏
   * 报 `Cannot find package 'cheerio'` 之类 —— 这个功能就是为了修那份日志。
   *
   * @return {Promise<{ran: boolean, ok: boolean, reason: string, missing: object[], addCmd: string}>}
   */
  async #installDeps() {
    const out = {ran: false, ok: false, reason: '', missing: [], addCmd: ''}
    if (this.#canceled) {
      out.reason = '已取消'
      return out
    }
    // 找不到 pnpm 就明确报出来，**不回落 npm**：根 package.json 里有 `link:lib/modules/...`
    // 这类 pnpm 专有协议的依赖，还有 pnpm.patchedDependencies（log4js / streamroller 两个
    // 补丁）—— npm 不认，装出来的 node_modules 是坏的，帮倒忙比不帮更糟
    const probe = await this.#spawnLogged(PNPM, ['--version'], {cwd: this.root, shell: NEED_SHELL})
    if (probe.code !== 0) {
      out.reason = '没找到 pnpm'
      this.#log('没找到 pnpm，依赖装不了。请先装上（npm i -g pnpm）再手动执行 pnpm install。'
        + 'Yunzai 用了 pnpm 专有的 link: 依赖和依赖补丁，换 npm 装会装坏，所以这里不代劳', 'error')
      return out
    }

    out.ran = true
    this.#log('在 Yunzai 根执行 pnpm install（workspace 会把所有插件的依赖一起装上）')
    // --no-frozen-lockfile 不能省：pnpm 在 CI=true 的环境里默认 frozen，而还原进来的
    // package.json 跟本机 lockfile 常常不匹配（跨平台还原时 sharp / canvas 那些带二进制的
    // optional 依赖也不一样），不加这个 flag 会直接失败
    const res = await this.#spawnLogged(PNPM, ['install', '--no-frozen-lockfile'], {
      cwd: this.root, shell: NEED_SHELL,
    })
    if (res.code !== 0) {
      out.reason = res.tail || `pnpm install 退出码 ${res.code}`
      this.#log(`依赖安装失败：${out.reason}`, 'error')
      this.#log('请到 Yunzai 根目录手动执行 pnpm install，成功后再重启 Bot', 'warn')
      return out
    }
    out.ok = true
    this.#log('依赖安装完成')

    // 装完体检一遍：install 成功也可能有漏网的（谁的 package.json 都没声明、原先靠
    // node_modules 里现成的包在用），这些只能靠用户自己 pnpm add
    const missing = this.#checkDeps()
    if (missing.length) {
      out.missing = missing
      out.addCmd = `pnpm add ${[...new Set(missing.map((m) => m.name))].join(' ')} -w`
      this.#log(`还有 ${missing.length} 个声明过的依赖找不到：`
        + missing.map((m) => `${m.name}（${m.from}）`).join('、'), 'warn')
      this.#log(`到 Yunzai 根目录执行：${out.addCmd}`, 'warn')
    } else {
      this.#log('依赖体检通过，没有缺失')
    }
    return out
  }

  /**
   * 依赖体检：谁的 `package.json` 声明了、`node_modules` 里却找不到。
   *
   * **用目录存在性判断，不用 `require.resolve`** —— ESM-only 的包（node-fetch v3、chalk 5）
   * `exports` 里只有 import 条件，`require.resolve` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，
   * 把装好的包误判成缺失。查目录对 pnpm 的布局同样有效：pnpm 会在每个 workspace 包下建
   * `node_modules/<dep>` 符号链接，`link:` 协议的依赖也是这么落地的。
   *
   * @return {object[]} `[{name, from}]`，from 是声明它的地方（`根` 或插件名）
   */
  #checkDeps() {
    const targets = [{from: '根', dir: this.root}]
    const pluginsDir = path.join(this.root, 'plugins')
    try {
      for (const it of fs.readdirSync(pluginsDir, {withFileTypes: true})) {
        if (!it.isDirectory() || !PLUGIN_NAME_RE.test(it.name)) continue
        targets.push({from: it.name, dir: path.join(pluginsDir, it.name)})
      }
    } catch {
      // 没有 plugins 目录就只查根
    }

    const missing = []
    for (const {from, dir} of targets) {
      let pkg
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      } catch {
        // 没有 package.json（大多数单文件插件）或者读不出来 —— 没声明就没什么可查的
        continue
      }
      for (const name of Object.keys(pkg?.dependencies ?? {})) {
        // package.json 正常情况下不会有非法包名；外部包可能手改过，体检不能把它拼进命令
        if (!DEP_NAME_RE.test(name)) continue
        if (!this.#hasModule(dir, name)) missing.push({name, from})
      }
    }
    return missing
  }

  /** 从 dir 往上逐级找 `node_modules/<name>`，找到 Yunzai 根为止（就是 Node 的解析算法） */
  #hasModule(dir, name) {
    let cur = dir
    for (;;) {
      if (fs.existsSync(path.join(cur, 'node_modules', name))) return true
      if (cur === this.root) return false
      const up = path.dirname(cur)
      // 已经到文件系统根、或者走出 Yunzai 了就停
      if (up === cur || !up.startsWith(this.root)) return false
      cur = up
    }
  }

  /**
   * 起个子进程，输出实时进日志。
   *
   * 进程会登记到 {@link #running}，取消时能被 {@link #killRunning} 杀掉 —— 不然一个大仓库
   * 的 clone 会把取消请求晾在那儿好几分钟。
   *
   * `opts` 直接透给 `spawn`，所以 `shell: true` 也是从这儿传（Windows 上跑 pnpm 必须过
   * shell，见 {@link NEED_SHELL}）。过 shell 时参数会被 shell 再解析一遍，只能传常量。
   *
   * @return {Promise<{code: number, tail: string}>}
   */
  #spawnLogged(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      // 已经取消了就别再起新进程，否则「取消」之后还会冒出下一个 clone
      if (this.#canceled) {
        resolve({code: -1, tail: '已取消'})
        return
      }
      let proc
      try {
        proc = spawn(cmd, args, {
          ...opts,
          windowsHide: true,
          env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo'},
        })
      } catch (err) {
        resolve({code: -1, tail: err.message})
        return
      }
      this.#running.add(proc)
      let settled = false
      const done = (res) => {
        if (settled) return
        settled = true
        this.#running.delete(proc)
        resolve(res)
      }
      const tail = []
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
      // 被取消杀掉时同样只能靠 exit：孤儿的 git-remote-https 会让 close 迟迟不来
      proc.on('exit', (code) => {
        if (this.#canceled) done({code: code ?? -1, tail: '已取消'})
      })
      proc.on('close', (code) => done({code: code ?? -1, tail: tail.join('; ')}))
    })
  }

  // ------------------------------------------------------------------ 任务

  #startTask(type) {
    if (this.#task && !this.#task.done) throw new GuobaError('已有备份任务在跑，请等它结束')
    this.#canceled = false
    this.#logs = []
    this.#seq = 0
    this.#task = {
      id: `${type}-${Date.now()}`,
      type,
      phase: 'collecting',
      file: '',
      current: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      done: false,
      error: '',
      result: null,
      startAt: Date.now(),
      endAt: 0,
    }
  }

  #finishTask(result) {
    if (!this.#task) return
    Object.assign(this.#task, {phase: 'done', done: true, result, endAt: Date.now()})
  }

  #failTask(err) {
    const msg = err?.message || String(err)
    this.#log(msg, 'error')
    if (!this.#task) return
    Object.assign(this.#task, {
      phase: this.#canceled ? 'canceled' : 'error',
      done: true,
      error: msg,
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
      task: this.#task ? {...this.#task} : null,
      logs,
      cursor: this.#seq - 1,
    }
  }

  /**
   * 取消。
   *
   * 只置标志位是不够的 —— 还原时最耗时的是 `git clone`，一个 745 M 的仓库能跑好几分钟，
   * 期间标志位没人看，用户点十次取消也「没反应」（日志里刷十行「正在收尾」）。所以这里
   * 直接把正在跑的子进程杀掉，让 `#spawnLogged` 立刻返回。
   */
  cancel() {
    if (!this.#task || this.#task.done) return false
    // 幂等：已经在取消了就别再刷日志，用户多点几下不该多出几行
    if (this.#canceled) {
      this.#killRunning()
      return true
    }
    this.#canceled = true
    this.#log('收到取消请求，正在收尾', 'warn')
    this.#killRunning()
    return true
  }

  /** 杀掉当前所有子进程（git clone / pnpm install / 测速用的 ls-remote） */
  #killRunning() {
    for (const proc of this.#running) {
      if (!proc.pid || proc.killed) continue
      this.#killTree(proc)
      this.#log('已终止正在执行的命令', 'warn')
    }
    this.#running.clear()
  }

  // ------------------------------------------------------------------ 设置 / 定时

  getSettings() {
    const job = process[JOB_KEY]
    return {
      enable: !!cfg.get('backup.enable'),
      cron: cfg.get('backup.cron') || '0 0 4 * * ?',
      keep: Number(cfg.get('backup.keep') ?? 5),
      keys: cfg.get('backup.keys') || [],
      /** 配置开着不等于真挂上了（node-schedule 缺失 / cron 无效都会失败） */
      active: !!job,
      nextAt: job?.nextInvocation?.()?.toISOString?.() || '',
    }
  }

  async saveSettings(data = {}) {
    const keep = Number(data.keep)
    const cron = String(data.cron ?? '').trim()
    const enable = !!data.enable
    const segments = cron ? cron.split(/\s+/) : []
    if (enable && !cron) throw new GuobaError('启用定时备份时必须填写 cron 表达式')
    if (cron && (segments.length < 5 || segments.length > 6)) {
      throw new GuobaError('cron 表达式需为 5 段或 6 段')
    }
    if (!Number.isFinite(keep) || keep < 1 || keep > 100) {
      throw new GuobaError('保留份数需要在 1 ~ 100 之间')
    }

    // 先验证、尝试挂新 job；成功以后再落配置。原先反过来写，cron 无效时接口仍返回
    // 「已启用」，但 scheduleJob 实际返回 null，重启也永远不会跑
    const scheduled = await this.applySchedule({enable, cron})
    if (enable && !scheduled) {
      // 新配置挂不上时恢复原配置对应的 job，避免一次输错 cron 把原本正常的定时也关掉
      await this.applySchedule()
      throw new GuobaError('定时任务注册失败，请检查 cron 或服务日志')
    }

    cfg.set('backup.enable', enable)
    if (cron) cfg.set('backup.cron', cron)
    cfg.set('backup.keep', Math.floor(keep))
    cfg.set('backup.keys', this.#normalizeKeys(data.keys))
    return this.getSettings()
  }

  /**
   * 按设置挂 / 撤定时任务。
   *
   * `node-schedule` 是 Yunzai 自己的依赖，动态 import 是为了「锅巴不新增 npm 依赖」——
   * 依赖检查不过会让锅巴整个起不来，定时备份不值得冒这个风险。拿不到就只关掉这个功能。
   */
  async applySchedule(override) {
    const generation = (process[JOB_GENERATION_KEY] || 0) + 1
    process[JOB_GENERATION_KEY] = generation
    this.#scheduleGeneration = generation
    // 无论新设置最终能否注册，先撤掉旧 job；否则无效 cron 时旧 job 会残留，
    // 下一次恢复/热重载又可能再挂一个，造成重复备份
    this.#cancelJob()
    const settings = override || this.getSettings()
    const {enable, cron} = settings
    if (!enable) {
      this.#cancelJob()
      return false
    }
    let schedule
    try {
      schedule = (await import('node-schedule')).default ?? await import('node-schedule')
    } catch {
      logger.warn('[Guoba] 没找到 node-schedule，定时备份不可用')
      return false
    }
    try {
      // import 完成时可能已经有更新的一代设置了。旧调用不得再挂 job；跨热重载实例也靠
      // process 上的 generation 判断，不然两个实例各自的私有计数挡不住
      if (generation !== process[JOB_GENERATION_KEY] || generation !== this.#scheduleGeneration) return false
      const job = schedule.scheduleJob(cron, () => {
        this.#autoBackup().catch((err) => logger.error('[Guoba] 定时备份失败：', err))
      })
      if (!job) throw new Error(`cron 表达式无效：${cron}`)
      // scheduleJob 本身虽同步，但保守再核对一次，失去代次的 job 立即取消
      if (generation !== process[JOB_GENERATION_KEY]) {
        job.cancel()
        return false
      }
      process[JOB_KEY] = job
      logger.info(`[Guoba] 定时备份已启用：${cron}`)
      return true
    } catch (err) {
      logger.error('[Guoba] 定时备份注册失败：', err)
      return false
    }
  }

  /** 撤掉当前挂着的 job（可能是热重载前那个实例挂的） */
  #cancelJob() {
    const old = process[JOB_KEY]
    if (old) {
      try {
        old.cancel()
      } catch {
        // 撤不掉就算了，至少不会有两个
      }
      delete process[JOB_KEY]
    }
  }

  /**
   * 定时备份。
   *
   * 没配 keys 就备份「推荐勾选」的那批 —— 用户开了定时却没选内容，多半就是想要默认的。
   */
  async #autoBackup() {
    if (this.#task && !this.#task.done) {
      logger.warn('[Guoba] 上一个备份任务还没结束，跳过这次定时备份')
      return
    }
    const {keys} = this.getSettings()
    let picked = keys
    if (!picked?.length) {
      const scanned = await this.scan(true)
      picked = [
        ...scanned.root.entries.filter((e) => e.recommended).map((e) => e.key),
        ...scanned.plugins.flatMap((p) => p.entries.filter((e) => e.recommended).map((e) => e.key)),
      ]
    }
    if (!picked.length) {
      logger.warn('[Guoba] 定时备份没有可备份的条目')
      return
    }
    this.#startTask('create')
    const fileName = this.#uniqueName(`guoba-backup-auto-${stamp()}.zip`)
    this.#task.file = fileName
    this.#task.auto = true
    try {
      await this.#runCreate(picked, '定时备份', fileName)
    } catch (err) {
      this.#failTask(err)
      throw err
    }
  }

  /**
   * 按保留份数清理。
   *
   * 只清 `guoba-backup-auto-*`：手动点出来的包和上传进来的包是用户明确想留的，
   * 不该被定时任务顺手删掉。
   */
  async #applyRetention() {
    const {keep} = this.getSettings()
    if (!Number.isFinite(keep) || keep < 1) return
    const autos = this.list().filter((f) => f.name.startsWith('guoba-backup-auto-'))
    const extra = autos.slice(keep)
    for (const f of extra) {
      try {
        fs.rmSync(path.join(this.backupDir, f.name), {force: true})
        this.#log(`清理旧的自动备份：${f.name}`)
      } catch (err) {
        logger.warn(`[Guoba] 清理旧备份 ${f.name} 失败：${err.message}`)
      }
    }
  }
}

/** 黑名单之外还要跳过的：`plugins/<name>` 是不是当前不可用的插件 */
function redirectFor(rel, unavailable) {
  if (!unavailable.size) return ''
  const m = rel.match(/^plugins\/([^/]+)\/(.*)$/)
  if (!m || !unavailable.has(m[1])) return ''
  return `${m[1]}/${m[2]}`
}

/** `root` → 空前缀；`plugin:miao-plugin` → `plugins/miao-plugin` */
function baseOfTarget(target) {
  const t = String(target ?? '')
  if (!t || t === 'root') return ''
  if (t.startsWith('plugin:')) {
    const name = t.slice('plugin:'.length)
    return PLUGIN_NAME_RE.test(name) ? `plugins/${name}` : ''
  }
  return ''
}

function matchAnyPrefix(name, prefixes) {
  for (const p of prefixes) {
    if (name === p || name.startsWith(`${p}/`)) return true
  }
  return false
}

/** 文件名里的时间戳：20260817-043000 */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function fmtSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = Number(bytes) || 0
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}
