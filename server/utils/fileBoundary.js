import fs from 'node:fs'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import GuobaError from '../../framework/src/components/GuobaError.js'

const {O_RDONLY, O_NOFOLLOW = 0, O_DIRECTORY = 0, O_NONBLOCK = 0} = fs.constants
const procRoot = '/proc/self/fd'
const canPinDirectory = process.platform === 'linux' && !!O_DIRECTORY && !!O_NOFOLLOW && fs.existsSync(procRoot)
const validComponent = name => !!name && name !== '.' && name !== '..'
  && !/[<>:"/\\|?*\x00-\x1f]|[. ]$/u.test(name)
  && !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/iu.test(name)

/** 仅接受可跨平台往返的相对路径；不要先 resolve 再丢掉 '..' 等不合法的段。 */
export function relativeParts(value) {
  if (value === '') return []
  if (typeof value !== 'string') throw new GuobaError('路径格式不合法')
  const parts = value.split(/[\\/]/u)
  if (!parts.every(validComponent)) throw new GuobaError('路径格式不合法或超出云崽目录')
  return parts
}

function unavailable(err) {
  if (err?.code === 'EEXIST') return new GuobaError('同名文件或目录已存在')
  if (err?.code === 'ENAMETOOLONG') return new GuobaError('文件名或路径过长')
  if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(err?.code)) {
    return new GuobaError('路径不存在、不可访问或包含链接')
  }
  return err
}

function entryStat(abs) {
  const st = fs.lstatSync(abs)
  if (st.isSymbolicLink()) throw new GuobaError('文件管理不跟随符号链接')
  if (!st.isDirectory() && !st.isFile()) throw new GuobaError('仅支持普通文件和目录')
  return st
}

/** 云崽根目录是信任边界；浏览器输入不能指定根，也不能经链接跨出根。 */
export class FileBoundary {
  constructor(root) {
    this.root = fs.realpathSync(root)
  }

  resolve(rel) {
    return path.join(this.root, ...relativeParts(rel))
  }

  #parts(abs) {
    return relativeParts(path.relative(this.root, abs))
  }

  #inside(abs) {
    const rel = path.relative(this.root, abs)
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
  }

  /** Linux 逐级在已打开的目录上解析子项，防止检查后替换祖先链接。其他平台逐段 lstat。 */
  openDir(abs) {
    const parts = this.#parts(abs)
    let fd
    try {
      if (canPinDirectory) {
        const flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW
        fd = fs.openSync(this.root, flags)
        for (const name of parts) {
          const next = fs.openSync(`${procRoot}/${fd}/${name}`, flags)
          fs.closeSync(fd)
          fd = next
        }
        const pinned = `${procRoot}/${fd}`
        if (!this.#inside(fs.realpathSync(pinned))) throw new GuobaError('路径超出云崽目录')
        return {path: pinned, close: () => fs.closeSync(fd)}
      }
      let current = this.root
      for (const name of parts) {
        current = path.join(current, name)
        if (!entryStat(current).isDirectory()) throw new GuobaError('不是目录')
      }
      if (!this.#inside(fs.realpathSync(current))) throw new GuobaError('路径超出云崽目录')
      return {path: current, close: () => {}}
    } catch (err) {
      if (fd !== undefined) fs.closeSync(fd)
      throw unavailable(err)
    }
  }

  withParent(abs, fn) {
    if (abs === this.root) throw new GuobaError('不能直接修改根目录')
    const parent = this.openDir(path.dirname(abs))
    try {
      return fn(path.join(parent.path, path.basename(abs)), parent.path)
    } catch (err) {
      throw unavailable(err)
    } finally {
      parent.close()
    }
  }

  mkdirParents(abs) {
    let current = this.root
    for (const name of this.#parts(abs)) {
      current = path.join(current, name)
      this.withParent(current, target => {
        try {
          fs.mkdirSync(target)
        } catch (err) {
          if (err?.code !== 'EEXIST' || !entryStat(target).isDirectory()) throw err
        }
      })
    }
  }

  stat(abs) {
    return this.withParent(abs, entryStat)
  }

  list(abs) {
    const dir = this.openDir(abs)
    try {
      return fs.readdirSync(dir.path, {withFileTypes: true})
        .filter(entry => validComponent(entry.name) && (entry.isDirectory() || entry.isFile()))
    } finally {
      dir.close()
    }
  }

  async readDir(abs) {
    const dir = this.openDir(abs)
    try {
      return (await fs.promises.readdir(dir.path, {withFileTypes: true}))
        .filter(entry => validComponent(entry.name) && (entry.isDirectory() || entry.isFile()))
    } finally {
      dir.close()
    }
  }

  async openFile(abs) {
    if (abs === this.root) throw new GuobaError('请选择普通文件')
    const dir = this.openDir(path.dirname(abs))
    const file = path.join(dir.path, path.basename(abs))
    let handle
    try {
      const before = entryStat(file)
      if (!before.isFile() || before.nlink !== 1) throw new GuobaError('不能打开非普通文件或多重硬链接文件')
      const flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK
      handle = await fs.promises.open(file, flags)
      const st = await handle.stat()
      // 在同一个已打开的描述符上校验和读写，不再用路径重新打开文件。
      if (!st.isFile() || st.nlink !== 1 || st.ino !== before.ino || st.dev !== before.dev) {
        throw new GuobaError('文件已变化，请刷新后重试')
      }
      const opened = fs.realpathSync(canPinDirectory ? `${procRoot}/${handle.fd}` : file)
      if (!this.#inside(opened)) throw new GuobaError('路径超出云崽目录')
      return {handle, stat: st}
    } catch (err) {
      if (handle) await handle.close().catch(() => {})
      throw unavailable(err)
    } finally {
      dir.close()
    }
  }

  /** 先写同目录临时文件，再原子替换；不截断其他进程正在读的文件，也不跟随替换目标。 */
  replaceFile(abs, expected, data) {
    this.withParent(abs, (target, parent) => {
      const current = entryStat(target)
      if (!current.isFile() || current.nlink !== 1 || current.dev !== expected.dev || current.ino !== expected.ino
        || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
        throw new GuobaError('文件已变化，请刷新后重试')
      }
      const tmp = path.join(parent, `.guoba-save-${randomUUID()}.tmp`)
      const fd = fs.openSync(tmp, 'wx', 0o600)
      try {
        try {
          fs.writeFileSync(fd, data)
          if (process.platform !== 'win32') fs.fchownSync(fd, current.uid, current.gid)
          fs.fchmodSync(fd, current.mode & 0o777)
        } finally {
          fs.closeSync(fd)
        }
        fs.renameSync(tmp, target)
      } finally {
        fs.rmSync(tmp, {force: true})
      }
    })
  }

  /** 递归删除途中遇到链接只移除目录项，不进入目标。 */
  remove(abs) {
    this.withParent(abs, entryStat)
    const visit = (item, depth) => {
      if (depth > 128) throw new GuobaError('目录层级过深，不能递归删除')
      this.withParent(item, target => {
        if (!fs.lstatSync(target).isDirectory()) return fs.unlinkSync(target)
        // 不用递归 rm 重新走整条绝对路径。每层目录都从通过检查的父级定位。
        const dir = this.openDir(item)
        let names
        try { names = fs.readdirSync(dir.path) } finally { dir.close() }
        for (const name of names) {
          // 不可寻址的名字先在固定的父目录下删除文件项，目录则拒绝自动进入。
          if (!validComponent(name)) {
            const parent = this.openDir(item)
            try {
              if (process.platform === 'win32') throw new GuobaError('目录内有不兼容的文件名，请手动处理')
              const child = path.join(parent.path, name)
              if (fs.lstatSync(child).isDirectory()) throw new GuobaError('目录内有不兼容的目录名，请手动处理')
              fs.unlinkSync(child)
            } finally { parent.close() }
          } else {
            visit(path.join(item, name), depth + 1)
          }
        }
        fs.rmdirSync(target)
      })
    }
    visit(abs, 0)
  }
}
