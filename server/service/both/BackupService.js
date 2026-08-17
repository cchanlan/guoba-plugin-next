import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {GuobaError, Service} from '#guoba.framework'
import {_paths, cfg} from '#guoba.platform'
import {ZipWriter, readEntries, readEntryBuffer, extractEntry, safeJoin} from '../../utils/zip.js'
import {
  discoverTarget, discoverPlain, repoInfo, sanitizeRemote, shouldSkipName,
  DISCOVER_LIMITS,
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
/** 插件目录名规则：不许有分隔符和相对路径 */
const PLUGIN_NAME_RE = /^[\w.-]+$/

/**
 * 热重载键：锅巴热重载时本模块被重新 import，实例是新的，但上一代的定时任务还挂在
 * node-schedule 里。把 job 挂到 process 上，新实例构造时看到旧的先取消。同 TermService。
 */
const JOB_KEY = Symbol.for('guoba.backup.job')

/**
 * 备份与还原。
 *
 * 搬家场景：把 Bot 的配置、数据、各插件的配置打成一个 zip 带走，到新机器上传同一个包就能
 * 复原 —— 包括**按清单把插件重新 clone 下来**。
 *
 * 三个设计要点：
 *
 * 1. **备份什么由 git 决定，不写死目录名**。`.git` 本身不打包（本机 22 个插件的 .git 合计
 *    1.9 G），只记仓库清单（remote / branch / commit），还原时按清单 clone。仓库自带的素材
 *    同理 —— clone 就有，不该占备份体积。详见 {@link ../../utils/backupDiscover.js}。
 * 2. **包内路径就是相对 Yunzai 根的原始路径**（统一放在 `files/` 下）。还原时原路写回，
 *    不需要任何映射表，手工用解压软件打开也能看懂。
 * 3. **还原前先备份**。被覆盖的原文件挪进 `data/guoba/backups/.restore-bak-<时间戳>/`，
 *    还原错了能捞回来。插件 clone 失败时它的文件也不丢，暂存到 `.pending-restore/`。
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

    /** 热重载后旧实例的 job 还挂在 node-schedule 上，applySchedule 第一步就会撤掉 */
    this.applySchedule().catch((err) => logger.error('[Guoba] 备份定时任务启动失败：', err))
  }

  #scanCache = null
  /** @type {object|null} 同一时刻只允许一个任务，避免两个打包互相写坏 */
  #task = null
  #logs = []
  #seq = 0
  #canceled = false

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
          const entries = info.git
            ? (await discoverTarget(dir, {prefix, excludes: this.excludes})).entries
            : discoverPlain(dir, {prefix, excludes: this.excludes})
          out.push({name, ...info, noGit: !info.git, entries})
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
    fs.rmSync(this.absOf(name), {force: true})
    return true
  }

  /** 上传外部备份包。multer 已经把文件落到 data/upload_tmp/，这里搬过去 */
  async saveUpload(files) {
    const list = Array.isArray(files) ? files : (files ? [files] : [])
    if (!list.length) throw new GuobaError('没有收到文件')
    fs.mkdirSync(this.backupDir, {recursive: true})
    const saved = []
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
    const plugins = (manifest.plugins ?? []).map((p) => ({
      ...p,
      installed: installed.has(p.name),
      // clone 地址不在白名单里的话，还原时装不了，提前告诉用户
      allowed: !p.remote || this.#remoteAllowed(p.remote).ok,
    }))
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
    const fileName = `guoba-backup-${stamp()}.zip`
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
    let totalBytes = 0
    for (const item of plan.items) {
      for (const rel of item.paths) {
        const abs = path.join(this.root, item.base, rel)
        const entryBase = item.base ? `${item.base}/${rel}` : rel
        for (const f of this.#walk(abs, entryBase)) {
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
      for (const f of files) {
        this.#throwIfCanceled()
        if (f.isDir) {
          await zip.addDirectory(FILES_PREFIX + f.entryName)
        } else {
          try {
            await zip.addFile(FILES_PREFIX + f.entryName, f.abs, {stat: f.stat})
          } catch (err) {
            // 单个文件读失败（权限 / 正被写）不该毁掉整个备份
            this.#log(`跳过 ${f.entryName}：${err.message}`, 'warn')
          }
        }
        this.#task.current++
        this.#task.bytes += f.size
      }
      const res = await zip.finalize()
      ok = true
      this.#task.packSize = res.bytes
      this.#log(`备份完成：${fileName}（${fmtSize(res.bytes)}）`)
      this.#finishTask({file: fileName, size: res.bytes, files: files.length})
      await this.#applyRetention()
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

    const take = (entry, target, base) => {
      if (!wanted.has(entry.key) || seen.has(entry.key)) return
      seen.add(entry.key)
      items.push({
        key: entry.key, target, base, rel: entry.rel, paths: entry.paths,
        size: entry.size, files: entry.files,
      })
    }
    for (const entry of scanned.root.entries) take(entry, 'root', '')
    for (const p of scanned.plugins) {
      for (const entry of p.entries) take(entry, `plugin:${p.name}`, `plugins/${p.name}`)
    }

    const plugins = scanned.plugins.map((p) => ({
      name: p.name,
      git: !!p.git,
      noGit: !!p.noGit,
      remote: sanitizeRemote(p.remote || ''),
      branch: p.branch || '',
      commit: p.commit || '',
      dirty: !!p.dirty,
      keys: p.entries.filter((e) => wanted.has(e.key)).map((e) => e.key),
    }))
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
   */
  * #walk(abs, entryName) {
    let st
    try {
      st = fs.lstatSync(abs)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    if (this.excludes.has(abs)) return
    if (st.isFile()) {
      yield {abs, entryName, size: st.size, stat: st, isDir: false}
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
      if (shouldSkipName(it.name)) continue
      yield * this.#walk(path.join(abs, it.name), `${entryName}/${it.name}`)
    }
  }

  #normalizeKeys(keys) {
    if (!Array.isArray(keys)) return []
    return [...new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean))]
  }

  // ------------------------------------------------------------------ 还原

  /**
   * 还原。后台跑，进度靠 {@link taskStatus} 轮询。
   *
   * 顺序很重要：**先 clone 插件，再解文件**。反过来的话插件目录已经有文件了，
   * `git clone` 到非空目录会直接失败。
   *
   * @param {object} opts
   * @param {string} opts.file 备份包名
   * @param {string[]} opts.keys 要还原的条目 key
   * @param {string[]} [opts.plugins] 要 clone 的插件名（本地没装的那些）
   * @param {boolean} [opts.autoNpmInstall] clone 完是否顺手装依赖
   * @param {boolean} [opts.autoRestart] 全部完成后是否重启 Bot
   */
  async restore({file, keys, plugins = [], autoNpmInstall = false, autoRestart = false} = {}) {
    const abs = this.absOf(file)
    const picked = this.#normalizeKeys(keys)
    const wantPlugins = this.#normalizeKeys(plugins)
    if (!picked.length && !wantPlugins.length) throw new GuobaError('没有勾选任何要还原的内容')
    this.#startTask('restore')
    this.#task.file = path.basename(abs)
    this.#runRestore({abs, keys: picked, plugins: wantPlugins, autoNpmInstall, autoRestart})
      .catch((err) => this.#failTask(err))
    return this.taskStatus()
  }

  async #runRestore({abs, keys, plugins, autoNpmInstall, autoRestart}) {
    const manifest = this.#readManifest(abs)
    const result = {cloned: [], skipped: [], failed: [], pending: [], restored: 0, backupDir: ''}

    // ---- 阶段一：把缺的插件拉回来 ----
    this.#task.phase = 'cloning'
    const byName = new Map((manifest.plugins ?? []).map((p) => [p.name, p]))
    /** clone 失败 / 没装的插件，它们的文件改道去 .pending-restore，不能直接丢 */
    const unavailable = new Set()
    if (plugins.length) this.#log(`需要安装 ${plugins.length} 个插件`)
    this.#task.total = plugins.length
    for (const name of plugins) {
      this.#throwIfCanceled()
      const info = byName.get(name)
      const res = await this.#clonePlugin(name, info)
      if (res.ok) {
        result.cloned.push(name)
        if (autoNpmInstall) await this.#npmInstall(name)
      } else if (res.skipped) {
        result.skipped.push({name, reason: res.reason})
      } else {
        result.failed.push({name, reason: res.reason})
        unavailable.add(name)
      }
      this.#task.current++
    }

    // 勾了条目但插件既没装也没 clone 成功的，一样得改道
    const installed = this.#installedPlugins()
    for (const key of keys) {
      const target = key.split('|')[0]
      if (!target.startsWith('plugin:')) continue
      const name = target.slice('plugin:'.length)
      if (!installed.has(name)) unavailable.add(name)
    }

    // ---- 阶段二：解文件 ----
    this.#task.phase = 'extracting'
    const prefixes = this.#restorePrefixes(manifest, keys)
    const {entries} = readEntries(abs)
    const targets = entries.filter((e) =>
      e.name !== MANIFEST_NAME && matchAnyPrefix(e.name, prefixes))
    this.#task.current = 0
    this.#task.total = targets.length
    this.#task.bytes = 0
    this.#task.totalBytes = targets.reduce((s, e) => s + e.size, 0)
    this.#log(`待还原 ${targets.length} 个文件，共 ${fmtSize(this.#task.totalBytes)}`)

    const bakDir = path.join(this.backupDir, `${RESTORE_BAK_PREFIX}${stamp()}`)
    result.backupDir = path.relative(this.root, bakDir)
    for (const entry of targets) {
      this.#throwIfCanceled()
      const rel = entry.name.slice(FILES_PREFIX.length)
      const redirect = redirectFor(rel, unavailable)
      const destRoot = redirect ? path.join(this.backupDir, PENDING_DIR) : this.root
      const destRel = redirect || rel
      const dest = safeJoin(destRoot, destRel)
      if (!dest) {
        // 包里的路径想跑到根目录外面去 —— 恶意包或者坏包，跳过
        this.#log(`跳过越界路径：${entry.name}`, 'warn')
        continue
      }
      try {
        if (entry.name.endsWith('/')) {
          fs.mkdirSync(dest, {recursive: true})
        } else {
          if (!redirect) this.#backupExisting(dest, rel, bakDir)
          await extractEntry(abs, entry, dest)
          result.restored++
        }
      } catch (err) {
        this.#log(`还原 ${rel} 失败：${err.message}`, 'warn')
      }
      this.#task.current++
      this.#task.bytes += entry.size
    }

    if (unavailable.size) {
      result.pending = [...unavailable]
      this.#log(
        `${[...unavailable].join('、')} 没能装上，它们的文件暂存在 ${BACKUP_DIR}/${PENDING_DIR}/，`
        + '装好插件后再还原一次即可', 'warn')
    }
    if (fs.existsSync(bakDir)) {
      this.#log(`被覆盖的原文件已存进 ${result.backupDir}`)
    } else {
      result.backupDir = ''
    }
    this.#log(`还原完成：${result.restored} 个文件`
      + (result.cloned.length ? `，新装插件 ${result.cloned.length} 个` : ''))
    this.#finishTask(result)

    if (autoRestart) {
      this.#log('即将重启 Bot')
      const {doRestart} = await import('../../../utils/botActions.js')
      setTimeout(() => doRestart(), 1000)
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

  /** 覆盖之前把原文件挪走。同一个相对路径在 bakDir 里保持原样，方便手工找回 */
  #backupExisting(dest, rel, bakDir) {
    let st
    try {
      st = fs.lstatSync(dest)
    } catch {
      return
    }
    if (!st.isFile()) return
    const bak = path.join(bakDir, rel)
    fs.mkdirSync(path.dirname(bak), {recursive: true})
    try {
      fs.renameSync(dest, bak)
    } catch {
      fs.copyFileSync(dest, bak)
    }
  }

  /**
   * clone 一个插件。
   *
   * @return {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
   */
  async #clonePlugin(name, info) {
    if (!PLUGIN_NAME_RE.test(name)) return {ok: false, reason: '插件名不合法'}
    // 前端只会传包里列出的插件名，传别的说明是手拼的请求 —— 没有清单就不知道该装什么，
    // 更不能凭一个名字就在 plugins/ 下建目录
    if (!info) return {ok: false, reason: '备份包里没有这个插件'}
    const dir = path.join(this.root, 'plugins', name)
    if (fs.existsSync(dir)) {
      // 已经装了就不动它 —— 覆盖安装会毁掉用户现有的改动
      return {ok: false, skipped: true, reason: '已安装，跳过'}
    }
    if (!info.remote) {
      // 非 git 插件（手动解压装的）没有 remote，文件直接解出来就是完整插件；
      // 是 git 仓库却没记下地址（本地没配 origin）就只能让用户自己装
      if (!info.noGit) return {ok: false, reason: '备份里没记下仓库地址，请手动安装'}
      fs.mkdirSync(dir, {recursive: true})
      this.#log(`${name}：备份里没有仓库地址，按文件直接还原`)
      return {ok: true}
    }
    const check = this.#remoteAllowed(info.remote)
    if (!check.ok) {
      this.#log(`${name}：${check.reason}`, 'warn')
      return {ok: false, reason: check.reason}
    }
    const url = this.#proxyUrl(info.remote)
    const args = ['clone', '--depth', '1', '--single-branch']
    if (info.branch && /^[\w./-]+$/.test(info.branch)) args.push('-b', info.branch)
    args.push(url, dir)
    this.#log(`${name}：clone ${url}${info.branch ? ` (${info.branch})` : ''}`)
    const res = await this.#spawnLogged('git', args, {cwd: this.root})
    if (res.code === 0) {
      this.#log(`${name}：安装成功`)
      return {ok: true}
    }
    // clone 失败会留下半个目录，不清掉的话下次还原会被判成「已安装」
    fs.rmSync(dir, {recursive: true, force: true})
    return {ok: false, reason: res.tail || `git clone 退出码 ${res.code}`}
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

  /** 按本机配置拼 GitHub 反代，跟 GitTools._getProxyUrl 同一套规则 */
  #proxyUrl(repoUrl) {
    if (!cfg.get('base.githubReverseProxy')) return repoUrl
    let proxy = cfg.get('base.githubProxyUrl')
    if (!proxy) return repoUrl
    if (!proxy.endsWith('/')) proxy += '/'
    return /github\.com/.test(repoUrl) ? `${proxy}${repoUrl}` : repoUrl
  }

  /** 给新装的插件装依赖。装不上只警告 —— 大多数插件没有自己的依赖 */
  async #npmInstall(name) {
    const cwd = path.join(this.root, 'plugins', name)
    if (!fs.existsSync(path.join(cwd, 'package.json'))) return
    this.#log(`${name}：安装依赖`)
    const res = await this.#spawnLogged('pnpm', ['install'], {cwd})
    if (res.code !== 0) this.#log(`${name}：依赖安装失败，请手动执行 pnpm install`, 'warn')
  }

  /**
   * 起个子进程，输出实时进日志。
   * @return {Promise<{code: number, tail: string}>}
   */
  #spawnLogged(cmd, args, opts = {}) {
    return new Promise((resolve) => {
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
      proc.on('error', (err) => resolve({code: -1, tail: err.message}))
      proc.on('close', (code) => resolve({code: code ?? -1, tail: tail.join('; ')}))
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

  /** 取消：只置标志位，任务在下一个文件的间隙自己收尾 */
  cancel() {
    if (!this.#task || this.#task.done) return false
    this.#canceled = true
    this.#log('收到取消请求，正在收尾', 'warn')
    return true
  }

  // ------------------------------------------------------------------ 设置 / 定时

  getSettings() {
    return {
      enable: !!cfg.get('backup.enable'),
      cron: cfg.get('backup.cron') || '0 0 4 * * ?',
      keep: Number(cfg.get('backup.keep') ?? 5),
      keys: cfg.get('backup.keys') || [],
    }
  }

  async saveSettings(data = {}) {
    const keep = Number(data.keep)
    const cron = String(data.cron ?? '').trim()
    if (cron && cron.split(/\s+/).length < 5) throw new GuobaError('cron 表达式不完整')
    if (!Number.isFinite(keep) || keep < 1 || keep > 100) {
      throw new GuobaError('保留份数需要在 1 ~ 100 之间')
    }
    cfg.set('backup.enable', !!data.enable)
    if (cron) cfg.set('backup.cron', cron)
    cfg.set('backup.keep', Math.floor(keep))
    cfg.set('backup.keys', this.#normalizeKeys(data.keys))
    await this.applySchedule()
    return this.getSettings()
  }

  /**
   * 按设置挂 / 撤定时任务。
   *
   * `node-schedule` 是 Yunzai 自己的依赖，动态 import 是为了「锅巴不新增 npm 依赖」——
   * 依赖检查不过会让锅巴整个起不来，定时备份不值得冒这个风险。拿不到就只关掉这个功能。
   */
  async applySchedule() {
    this.#cancelJob()
    const {enable, cron} = this.getSettings()
    if (!enable) return false
    let schedule
    try {
      schedule = (await import('node-schedule')).default ?? await import('node-schedule')
    } catch {
      logger.warn('[Guoba] 没找到 node-schedule，定时备份不可用')
      return false
    }
    try {
      const job = schedule.scheduleJob(cron, () => {
        this.#autoBackup().catch((err) => logger.error('[Guoba] 定时备份失败：', err))
      })
      if (!job) throw new Error(`cron 表达式无效：${cron}`)
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
    const fileName = `guoba-backup-auto-${stamp()}.zip`
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
