import path from 'node:path'
import fs from 'node:fs'
import {GuobaError, Service} from '#guoba.framework'
import {_paths, cfg} from '#guoba.platform'
import {dirStats, walkDir} from '../../utils/fsWalk.js'
import {FileBoundary, relativeParts} from '../../utils/fileBoundary.js'
import {createZipStream} from '../../utils/zip.js'

/** 文本文件超过这个大小就不在页面里编辑，提示用下载 */
const MAX_TEXT_SIZE = 2 * 1024 * 1024
/** 上传单文件上限 */
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024
/** 读文件前多少字节嗅探二进制（含 \0 就按二进制处理） */
const BINARY_SNIFF = 4096
/** 未通过二级验证时允许写入的默认目录 */
const DEFAULT_WRITE_SCOPES = ['data', 'logs', 'temp']

/**
 * 文件管理。
 *
 * 面板主人要在网页里直接看 / 改 Yunzai 目录下的文件，不必每次上服务器。与老的全盘文件树
 * （/sys/fs/tree/*，Linux 下直接挂 /）不同，这里**限定在 Yunzai 根目录内**：
 * 入参一律是相对根目录的路径（根本身传空串），后端解析后校验没越界才放行。
 */
export default class FileService extends Service {

  /**
   * @param {object} guobaApp
   * @param {string} [root] 根目录，默认取 Yunzai 根（测试时传入临时目录）
   */
  constructor(guobaApp, root) {
    super(guobaApp)
    this.boundary = new FileBoundary(root || _paths.root)
    this.root = this.boundary.root
  }

  #resolve(rel = '') {
    return this.boundary.resolve(rel)
  }

  /**
   * 文件名清洗：去掉路径分隔符，并把 Windows 的非法字符（`<>:"/\|?*` 及控制字符）
   * 换成下划线 —— 文件管理要能跑在 Windows 上，这些字符建不出文件。
   * 仍以 `..` 开头的名字由调用方拒绝。
   */
  #sanitizeName(name) {
    return String(name ?? '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim()
  }

  /** 相对路径拆段（兼容两种分隔符），取 basename 名并清洗后重组 */
  #sanitizeRel(rel) {
    const parts = relativeParts(rel)
    const name = parts.pop()
    if (!name) throw new GuobaError('名称不合法')
    return [...parts, this.#sanitizeName(name)].join('/')
  }

  /** 保留已有自定义范围；旧版 '*' 不再绕过二级验证。 */
  #writeScopes() {
    const configured = cfg.get('security.fileWriteScopes')
    if (!Array.isArray(configured)) return DEFAULT_WRITE_SCOPES
    const scopes = configured.map(item => String(item ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean)
    if (!scopes.includes('*')) return scopes
    // 旧配置里的 '*' 可能占掉合并后的第一个默认目录，回落时补齐默认范围。
    return [...new Set([...DEFAULT_WRITE_SCOPES, ...scopes.filter(scope => scope !== '*')])]
  }

  /** 范围校验与实际路径检查分开；即便已验证二级密码也必须经过 FileBoundary。 */
  #assertWritable(abs, gateVerified) {
    const rel = path.relative(this.root, abs)
    if (!rel) throw new GuobaError('不能直接修改根目录')
    if (gateVerified === true || this.#writeScopes().includes(rel.split(path.sep)[0])) return
    throw new GuobaError('此位置只读。请在「登录安全」设置二级密码，再验证后修改')
  }

  /** 列目录：文件夹在前、按名称排，无权限的项跳过 */
  list(rel = '') {
    const dir = this.#resolve(rel)
    const out = []
    for (const entry of this.boundary.list(dir)) {
      const name = entry.name
      try {
        const stat = this.boundary.stat(path.join(dir, name))
        if (stat.isFile() && stat.nlink !== 1) continue
        out.push({name, isDir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000)})
      } catch {
        // 已消失、权限不允许、链接或特殊文件不展示。
      }
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)))
    return out
  }

  async #checkText(handle, size) {
    if (size > MAX_TEXT_SIZE) throw new GuobaError('文件过大，无法在页面编辑，请下载后查看')
    const head = Buffer.alloc(Math.min(size, BINARY_SNIFF))
    await handle.read(head, 0, head.length, 0)
    if (head.includes(0)) throw new GuobaError('这是二进制文件，不支持在页面编辑')
  }

  /** 预览和保存都用通过边界检查的文件描述符。 */
  async read(rel = '') {
    const {handle, stat} = await this.boundary.openFile(this.#resolve(rel))
    try {
      await this.#checkText(handle, stat.size)
      const buf = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < buf.length) {
        const {bytesRead} = await handle.read(buf, offset, buf.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return {content: buf.toString('utf8', 0, offset), size: offset}
    } finally {
      await handle.close()
    }
  }

  async save(rel = '', content = '', gateVerified = false) {
    const abs = this.#resolve(rel)
    this.#assertWritable(abs, gateVerified)
    const data = Buffer.from(String(content ?? ''), 'utf8')
    if (data.length > MAX_TEXT_SIZE) throw new GuobaError('保存内容不能超过 2 MB')
    const {handle, stat} = await this.boundary.openFile(abs)
    try {
      await this.#checkText(handle, stat.size)
    } finally {
      await handle.close()
    }
    this.boundary.replaceFile(abs, stat, data)
    return {ok: true}
  }

  /** 新建文件夹 */
  mkdir(rel = '', gateVerified = false) {
    const abs = this.#resolve(this.#sanitizeRel(rel))
    this.#assertWritable(abs, gateVerified)
    this.boundary.withParent(abs, target => fs.mkdirSync(target))
    return {ok: true}
  }

  /** 新建文件，独占创建，不跟随末端链接或覆盖已有条目。 */
  create(rel = '', content = '', gateVerified = false) {
    const abs = this.#resolve(this.#sanitizeRel(rel))
    this.#assertWritable(abs, gateVerified)
    this.boundary.withParent(abs, target => fs.writeFileSync(target, String(content ?? ''), {flag: 'wx'}))
    return {ok: true}
  }

  rename(rel = '', newName = '', gateVerified = false) {
    const name = this.#sanitizeName(newName)
    if (!name || name.startsWith('..')) throw new GuobaError('文件名不合法')
    relativeParts(name)
    const abs = this.#resolve(rel)
    const target = path.join(path.dirname(abs), name)
    this.#assertWritable(abs, gateVerified)
    this.#assertWritable(target, gateVerified)
    this.boundary.withParent(abs, (source, parent) => {
      const st = fs.lstatSync(source)
      if (!st.isDirectory() && !st.isFile()) throw new GuobaError('不能重命名符号链接或特殊文件')
      const dest = path.join(parent, name)
      if (fs.lstatSync(dest, {throwIfNoEntry: false})) throw new GuobaError('同名文件已存在')
      fs.renameSync(source, dest)
    })
    return {ok: true}
  }

  /** 删除文件或目录，不跟随目录内的链接。 */
  remove(rel = '', gateVerified = false) {
    const abs = this.#resolve(rel)
    this.#assertWritable(abs, gateVerified)
    this.boundary.remove(abs)
    return {ok: true}
  }

  /**
   * 上传文件到 `rel` 目录。
   *
   * `relPaths` 是「上传整个文件夹」时前端带过来的相对路径（如 `我的插件/sub/a.js`），
   * 与 files 按下标一一对应。有它就在目标目录下按这些相对路径建子目录，
   * 每条路径都会被逐段清洗并校验没有越出目标目录 —— 浏览器给的相对路径不可信。
   */
  async upload(rel = '', files = [], relPaths = [], gateVerified = false) {
    const dir = this.#resolve(rel)
    this.boundary.openDir(dir).close()
    if (dir !== this.root) this.#assertWritable(dir, gateVerified)
    const list = Array.isArray(files) ? files : [files]
    if (!list.length) throw new GuobaError('没有收到文件')
    const relList = Array.isArray(relPaths) ? relPaths : []
    const saved = []
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      if (!f?.path || !f?.originalname) continue
      if (Number(f.size) > MAX_UPLOAD_SIZE) {
        throw new GuobaError(`文件过大（上限 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB）`)
      }
      const name = this.#sanitizeName(f.originalname)
      relativeParts(name)
      if (!name) throw new GuobaError('文件名不合法')
      const subdirs = relList[i] == null ? [] : relativeParts(relList[i]).slice(0, -1)
      const targetDir = path.join(dir, ...subdirs)
      this.#assertWritable(path.join(targetDir, name), gateVerified)
      this.boundary.mkdirParents(targetDir)
      const parent = this.boundary.openDir(targetDir)
      try {
        const ext = path.extname(name)
        let dest = path.join(parent.path, name)
        for (let attempt = 0; ; attempt++) {
          try {
            // 独占落盘，不覆盖目标（包括已存在的链接）；目标目录在整个操作期间保持打开。
            try {
              await fs.promises.link(f.path, dest)
            } catch (err) {
              if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(err?.code)) throw err
              await fs.promises.copyFile(f.path, dest, fs.constants.COPYFILE_EXCL)
            }
            await fs.promises.unlink(f.path)
            break
          } catch (err) {
            if (err?.code !== 'EEXIST' || attempt >= 5) throw err
            const renamed = `${path.basename(name, ext)}-${Date.now().toString(36)}-${attempt + 1}${ext}`
            dest = path.join(parent.path, renamed)
          }
        }
        saved.push([...subdirs, path.basename(dest)].join('/'))
      } finally {
        parent.close()
      }
    }
    return {ok: true, saved}
  }

  async openDownload(rel = '') {
    const abs = this.#resolve(rel)
    return {...await this.boundary.openFile(abs), name: path.basename(abs)}
  }

  #walkOptions() {
    return {
      readDir: abs => this.boundary.readDir(abs),
      stat: abs => this.boundary.stat(abs),
    }
  }

  /**
   * 算文件夹占用。列目录时不做这件事 —— `node_modules` 之类一层就得走十万个 inode，
   * 每次进目录都算一遍页面就废了，所以做成用户点一下才算的接口。
   *
   * 撞上条目数 / 时间上限会带 `partial: true` 返回已经数到的部分，让页面标出「≥」，
   * 而不是干等到超时或者报个错。
   */
  async dirSize(rel = '') {
    const abs = this.#resolve(rel)
    this.boundary.openDir(abs).close()
    return dirStats(abs, this.#walkOptions())
  }

  /**
   * 打包文件夹下载：返回 {name, stream}，stream 由 controller 直接 pipe 给响应。
   *
   * 全程流式，不落临时文件（见 createZipStream）。包内会多一层跟文件夹同名的目录，
   * 解出来就是一个完整文件夹，不会把几万个文件散在下载目录里。
   */
  zipDir(rel = '') {
    const abs = this.#resolve(rel)
    this.boundary.openDir(abs).close()
    const walkOptions = this.#walkOptions()
    // 根目录没有 basename，用 Yunzai 兜底
    const base = abs === this.root ? 'Yunzai' : path.basename(abs)
    const entries = (async function* () {
      // 顶层目录自己也要有条目，不然包里只有它的子项
      yield {name: base, isDir: true, size: 0, mtimeMs: Date.now(), mode: 0o755}
      for await (const entry of walkDir(abs, walkOptions)) {
        yield {...entry, name: `${base}/${entry.rel}`}
      }
    })()
    return {name: `${base}.zip`, stream: createZipStream(entries, {openFile: file => this.boundary.openFile(file)})}
  }
}
