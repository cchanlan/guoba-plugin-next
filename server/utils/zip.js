import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {promisify} from 'node:util'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

/**
 * ZIP 读写（零依赖）。
 *
 * 备份功能需要打包 / 解包 zip，但锅巴**不能新增 npm 依赖** —— `utils/adapter/check.js`
 * 里任一依赖缺失会让整个插件启动失败，老用户升级后不装依赖就起不来。所以这里用 Node 内置
 * 的 zlib（deflateRaw / inflateRaw）自己拼 ZIP 容器：local header + central directory +
 * EOCD，需要时带 zip64。
 *
 * 两个写入器共用同一套 header / 尾部构造函数：
 * - {@link ZipWriter} 写到磁盘文件（备份用）。**不用 data descriptor**，改成写完数据回填
 *   local header —— 全程用 FileHandle 按绝对位置写，回填只是多一次 write，兼容性比 data
 *   descriptor 好得多（有些老解压工具对 flag bit 3 处理得不对）。
 * - {@link createZipStream} 直接往 HTTP 响应里吐（文件管理下载文件夹用）。响应流没法回头
 *   改已发出的字节，所以小文件先在内存里压完再写头（还是不用 descriptor），只有超过
 *   {@link INLINE_LIMIT} 的大文件才退回 data descriptor。
 *
 * 文件名一律 UTF-8 + flag bit 11。Yunzai 下中文文件名遍地都是（`plugins/example/`
 * 里几十个），不设这个位的话 Windows 解压出来就是乱码。
 */

/** signature */
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_DATA_DESC = 0x08074b50

/** general purpose flag：bit 11 = 文件名是 UTF-8 */
const FLAG_UTF8 = 0x0800
/** general purpose flag：bit 3 = crc / 长度在数据后面的 data descriptor 里 */
const FLAG_DESC = 0x0008

/** 32 位字段的溢出哨兵，出现它就表示真值在 zip64 extra field 里 */
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

/**
 * 超过这个大小就一定要 zip64。
 *
 * 不是卡在 4G 整数上：local header 的长度写下去就不能改了，而 deflate 最坏情况会让数据
 * 略微变大，所以留出余量，免得压完才发现 csize 越界、header 里却没预留 zip64 extra。
 */
const ZIP64_SIZE_LIMIT = 0xffff0000

/** 小于这个大小的走一次性压缩（省去建流的开销），再大就流式 */
const INLINE_LIMIT = 4 * 1024 * 1024

/** deflate 的 chunk 调大些，减少 write 次数 */
const CHUNK_SIZE = 256 * 1024

/** 异步 deflate。响应请求的路径上不能用同步版，那会把整个事件循环按住 */
const deflateRaw = promisify(zlib.deflateRaw)

/**
 * 这些扩展名本身已经压过了，再 deflate 只烧 CPU 不减体积（实测大多在 1% 以内），
 * 直接 store。备份里图片 / 字体 / 视频占大头时差别很明显。
 */
const STORED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.mp3', '.mp4', '.m4a', '.flac', '.ogg', '.opus', '.wav', '.webm', '.mkv', '.avi',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.jar', '.apk', '.db', '.rdb',
])

/** CRC32 查表（多项式 0xEDB88320），首次用到时建 */
let CRC_TABLE = null

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  CRC_TABLE = table
  return table
}

/**
 * CRC32。
 * @param {Buffer} buf
 * @param {number} [seed] 上一段的结果，分段计算时传入
 * @return {number} 无符号 32 位
 */
export function crc32(buf, seed = 0) {
  const table = crcTable()
  let c = ~seed
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (~c) >>> 0
}

/** JS 时间 → DOS 日期时间。ZIP 的时间戳只到 1980 年、秒是 2 秒粒度 */
function dosDateTime(mtime) {
  const d = mtime instanceof Date ? mtime : new Date(mtime ?? Date.now())
  const year = d.getFullYear()
  if (Number.isNaN(year) || year < 1980) return {date: (1 << 5) | 1, time: 0}
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  }
}

/** DOS 日期时间 → JS Date */
function fromDosDateTime(date, time) {
  return new Date(
    1980 + ((date >> 9) & 0x7f), ((date >> 5) & 0x0f) - 1, date & 0x1f,
    (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  )
}

/** 写 8 字节小端（Buffer 的 writeBigUInt64LE 要 BigInt，这里统一包一层） */
function writeU64(buf, value, offset) {
  buf.writeBigUInt64LE(BigInt(value), offset)
  return offset + 8
}

/** entry 名归一化：一律 `/` 分隔的相对路径，去掉盘符 / 前导斜杠 / `.` 段 */
function normalizeEntryName(name, isDir = false) {
  const parts = String(name ?? '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .filter((s) => s && s !== '.')
  let out = parts.join('/')
  if (isDir && out) out += '/'
  return out
}

/** 按扩展名决定压不压 */
function shouldStore(name) {
  return STORED_EXT.has(path.extname(name).toLowerCase())
}

/**
 * local header 的字节。
 *
 * crc / 两个长度写进 32 位槽的值由调用方给：{@link ZipWriter} 先填 0（或 zip64 的哨兵）
 * 等回填，流式写入器要么此刻就知道真值、要么走 data descriptor 全填 0。
 *
 * @param {object} p
 * @param {string} p.name 已归一化的包内路径
 * @param {number} p.method 0 = store，8 = deflate
 * @param {Date|number} [p.mtime]
 * @param {number} [p.flags] general purpose flag，默认只有 UTF-8 位
 * @param {number} [p.crc]
 * @param {number} [p.csizeField] 压缩后长度槽的值
 * @param {number} [p.sizeField] 原始长度槽的值
 * @param {{size: number, csize: number}|null} [p.zip64Extra] 要不要预留 zip64 extra field
 *   （长度一写下去就不能改，所以得在写数据前按原始大小定好，见 {@link ZIP64_SIZE_LIMIT}）
 */
function localHeaderBuf({
  name, method, mtime, flags = FLAG_UTF8, crc = 0, csizeField = 0, sizeField = 0, zip64Extra = null,
}) {
  const nameBuf = Buffer.from(name, 'utf8')
  const extraLen = zip64Extra ? 20 : 0
  const buf = Buffer.alloc(30 + nameBuf.length + extraLen)
  const {date, time} = dosDateTime(mtime)
  buf.writeUInt32LE(SIG_LOCAL, 0)
  buf.writeUInt16LE(zip64Extra ? 45 : 20, 4)
  buf.writeUInt16LE(flags, 6)
  buf.writeUInt16LE(method, 8)
  buf.writeUInt16LE(time, 10)
  buf.writeUInt16LE(date, 12)
  buf.writeUInt32LE(crc, 14)
  buf.writeUInt32LE(csizeField, 18)
  buf.writeUInt32LE(sizeField, 22)
  buf.writeUInt16LE(nameBuf.length, 26)
  buf.writeUInt16LE(extraLen, 28)
  nameBuf.copy(buf, 30)
  if (zip64Extra) {
    const at = 30 + nameBuf.length
    buf.writeUInt16LE(0x0001, at)
    buf.writeUInt16LE(16, at + 2)
    // zip64 extra 里 size 在前、csize 在后（跟 header 里的顺序相反，这是规范定的）
    writeU64(buf, zip64Extra.size, at + 4)
    writeU64(buf, zip64Extra.csize, at + 12)
  }
  return {buf, nameLen: nameBuf.length}
}

/** data descriptor（带签名那种）。zip64 时两个长度是 8 字节 */
function dataDescriptorBuf(crc, csize, size, zip64) {
  const buf = Buffer.alloc(zip64 ? 24 : 16)
  buf.writeUInt32LE(SIG_DATA_DESC, 0)
  buf.writeUInt32LE(crc, 4)
  if (zip64) {
    writeU64(buf, csize, 8)
    writeU64(buf, size, 16)
  } else {
    buf.writeUInt32LE(csize, 8)
    buf.writeUInt32LE(size, 12)
  }
  return buf
}

/**
 * central directory 里的一条。
 * @param {object} e 条目记录，可带 flags（默认只有 UTF-8 位）
 * @param {number} [zip64Limit] 超过就把长度 / 偏移挪进 zip64 extra，单测会调小
 */
function centralEntryBuf(e, zip64Limit = U32_MAX) {
  const nameBuf = Buffer.from(e.name, 'utf8')
  // size / csize / offset 任一越界，就把三个都挪进 zip64 extra（合法且解压端都认）
  const zip64 = e.size > zip64Limit || e.csize > zip64Limit || e.offset > zip64Limit
  const extraLen = zip64 ? 28 : 0
  const buf = Buffer.alloc(46 + nameBuf.length + extraLen)
  const {date, time} = dosDateTime(e.mtime)
  buf.writeUInt32LE(SIG_CENTRAL, 0)
  // version made by：高字节 3 = UNIX，这样 external attr 的高 16 位才被当权限位读
  buf.writeUInt16LE(0x031e, 4)
  buf.writeUInt16LE(zip64 ? 45 : 20, 6)
  buf.writeUInt16LE(e.flags ?? FLAG_UTF8, 8)
  buf.writeUInt16LE(e.method, 10)
  buf.writeUInt16LE(time, 12)
  buf.writeUInt16LE(date, 14)
  buf.writeUInt32LE(e.crc, 16)
  buf.writeUInt32LE(zip64 ? U32_MAX : e.csize, 20)
  buf.writeUInt32LE(zip64 ? U32_MAX : e.size, 24)
  buf.writeUInt16LE(nameBuf.length, 28)
  buf.writeUInt16LE(extraLen, 30)
  buf.writeUInt16LE(0, 32)
  buf.writeUInt16LE(0, 34)
  buf.writeUInt16LE(0, 36)
  buf.writeUInt32LE(((e.mode & 0o7777) << 16) | (e.isDir ? 0x10 : 0), 38)
  buf.writeUInt32LE(zip64 ? U32_MAX : e.offset, 42)
  nameBuf.copy(buf, 46)
  if (zip64) {
    let at = 46 + nameBuf.length
    buf.writeUInt16LE(0x0001, at)
    buf.writeUInt16LE(24, at + 2)
    at += 4
    at = writeU64(buf, e.size, at)
    at = writeU64(buf, e.csize, at)
    writeU64(buf, e.offset, at)
  }
  return buf
}

/**
 * central directory 之后的收尾字节：条目数 / 大小 / 偏移越界就补 zip64 EOCD + locator，
 * 普通 EOCD 里对应字段填哨兵。
 * @return {Buffer[]} 按顺序写出去即可
 */
function endRecordBufs(count, cdSize, cdStart, zip64Limit = U32_MAX) {
  const out = []
  const needZip64 = count > U16_MAX || cdSize > zip64Limit || cdStart > zip64Limit
  if (needZip64) {
    const z = Buffer.alloc(56)
    z.writeUInt32LE(SIG_ZIP64_EOCD, 0)
    // 本字段之后的长度，固定 44
    writeU64(z, 44, 4)
    z.writeUInt16LE(0x031e, 12)
    z.writeUInt16LE(45, 14)
    z.writeUInt32LE(0, 16)
    z.writeUInt32LE(0, 20)
    writeU64(z, count, 24)
    writeU64(z, count, 32)
    writeU64(z, cdSize, 40)
    writeU64(z, cdStart, 48)
    out.push(z)

    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0)
    loc.writeUInt32LE(0, 4)
    // zip64 EOCD 就紧跟在 central directory 后面
    writeU64(loc, cdStart + cdSize, 8)
    loc.writeUInt32LE(1, 16)
    out.push(loc)
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Math.min(count, U16_MAX), 8)
  eocd.writeUInt16LE(Math.min(count, U16_MAX), 10)
  eocd.writeUInt32LE(Math.min(cdSize, U32_MAX), 12)
  eocd.writeUInt32LE(Math.min(cdStart, U32_MAX), 16)
  eocd.writeUInt16LE(0, 20)
  out.push(eocd)
  return out
}

/**
 * ZIP 写入器。
 *
 * ```js
 * const zip = new ZipWriter(dest)
 * await zip.open()
 * await zip.addBuffer('manifest.json', buf)
 * await zip.addFile('files/config/config.yaml', abs)
 * const {entries, bytes} = await zip.finalize()
 * ```
 */
export class ZipWriter {

  /** @param {string} destPath 目标 zip 路径 */
  constructor(destPath) {
    this.destPath = destPath
    /** @type {fs.promises.FileHandle} */
    this.fh = null
    /** 当前写入位置，等于已写字节数 */
    this.pos = 0
    /** @type {object[]} central directory 用 */
    this.entries = []
    /** 已加入的 entry 名，去重用（同名 entry 会让解压工具行为不一致） */
    this.names = new Set()
  }

  async open() {
    await fs.promises.mkdir(path.dirname(this.destPath), {recursive: true})
    this.fh = await fs.promises.open(this.destPath, 'w')
    return this
  }

  /** 顺序写，同时推进 pos */
  async #write(buf) {
    await this.fh.write(buf, 0, buf.length, this.pos)
    this.pos += buf.length
  }

  /** 定点回填（不动 pos），写完数据回来补 crc / 长度 */
  async #patch(buf, position) {
    await this.fh.write(buf, 0, buf.length, position)
  }

  /**
   * local header。
   *
   * `zip64` 为真时预留 zip64 extra field —— 长度必须此刻定下来，所以调用方要在写数据前
   * 就按原始大小判断好，见 {@link ZIP64_SIZE_LIMIT}。
   */
  async #writeLocalHeader({name, method, mtime, zip64}) {
    const {buf, nameLen} = localHeaderBuf({
      name,
      method,
      mtime,
      // crc / 两个长度写完数据再回填
      csizeField: zip64 ? U32_MAX : 0,
      sizeField: zip64 ? U32_MAX : 0,
      zip64Extra: zip64 ? {size: 0, csize: 0} : null,
    })
    const headerPos = this.pos
    await this.#write(buf)
    return {headerPos, nameLen}
  }

  /** 数据写完，回填 local header 里的 crc 与两个长度 */
  async #patchLocalHeader({headerPos, nameLen, zip64}, crc, csize, size) {
    const buf = Buffer.alloc(12)
    buf.writeUInt32LE(crc, 0)
    buf.writeUInt32LE(zip64 ? U32_MAX : csize, 4)
    buf.writeUInt32LE(zip64 ? U32_MAX : size, 8)
    await this.#patch(buf, headerPos + 14)
    if (zip64) {
      const ext = Buffer.alloc(16)
      // zip64 extra 里 size 在前、csize 在后（跟 header 里的顺序相反，这是规范定的）
      writeU64(ext, size, 0)
      writeU64(ext, csize, 8)
      await this.#patch(ext, headerPos + 30 + nameLen + 4)
    }
  }

  /**
   * 加一个内存里的 entry。
   * @param {string} entryName 包内路径
   * @param {Buffer|string} data
   * @param {object} [opts]
   * @param {Date|number} [opts.mtime]
   * @param {number} [opts.mode] Unix 权限位，默认 0o644
   */
  async addBuffer(entryName, data, {mtime, mode = 0o644} = {}) {
    const name = normalizeEntryName(entryName)
    if (!name || this.names.has(name)) return null
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
    const size = raw.length
    const zip64 = size > ZIP64_SIZE_LIMIT
    let method = shouldStore(name) ? 0 : 8
    let body = raw
    if (method === 8) {
      const deflated = zlib.deflateRawSync(raw, {level: 6})
      // 压不动就存原样，别把包搞更大
      if (deflated.length < raw.length) body = deflated
      else method = 0
    }
    const head = await this.#writeLocalHeader({name, method, mtime, zip64})
    await this.#write(body)
    const crc = crc32(raw)
    await this.#patchLocalHeader({...head, zip64}, crc, body.length, size)
    return this.#record({name, method, crc, csize: body.length, size, mtime, mode, offset: head.headerPos})
  }

  /**
   * 加一个磁盘上的文件。小文件一次读完压，大文件走流式（内存恒定）。
   * @param {string} entryName 包内路径
   * @param {string} absPath 源文件绝对路径
   * @param {object} [opts]
   * @param {fs.Stats} [opts.stat] 已 stat 过就传进来，省一次 syscall
   */
  async addFile(entryName, absPath, {stat} = {}) {
    const name = normalizeEntryName(entryName)
    if (!name || this.names.has(name)) return null
    const st = stat || await fs.promises.stat(absPath)
    const mode = st.mode & 0o7777
    if (st.size <= INLINE_LIMIT) {
      const raw = await fs.promises.readFile(absPath)
      return this.addBuffer(name, raw, {mtime: st.mtime, mode})
    }

    const zip64 = st.size > ZIP64_SIZE_LIMIT
    const method = shouldStore(name) ? 0 : 8
    const head = await this.#writeLocalHeader({name, method, mtime: st.mtime, zip64})

    let crc = 0
    let size = 0
    let csize = 0
    // 读到的原始字节边过边算 CRC，压缩后的字节直接落盘
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        crc = crc32(chunk, crc)
        size += chunk.length
        cb(null, chunk)
      },
    })
    const rs = fs.createReadStream(absPath, {highWaterMark: CHUNK_SIZE})
    let source = rs.pipe(tap)
    if (method === 8) {
      source = source.pipe(zlib.createDeflateRaw({level: 6, chunkSize: CHUNK_SIZE}))
    }
    // for await 由消费端驱动，背压天然成立
    for await (const chunk of source) {
      await this.#write(chunk)
      csize += chunk.length
    }
    await this.#patchLocalHeader({...head, zip64}, crc, csize, size)
    return this.#record({name, method, crc, csize, size, mtime: st.mtime, mode, offset: head.headerPos})
  }

  /**
   * 加一个目录 entry（名字以 `/` 结尾、长度为 0）。
   * 只为了让空目录也能还原出来 —— 有内容的目录靠文件路径自然重建。
   */
  async addDirectory(entryName, {mtime, mode = 0o755} = {}) {
    const name = normalizeEntryName(entryName, true)
    if (!name || this.names.has(name)) return null
    const head = await this.#writeLocalHeader({name, method: 0, mtime, zip64: false})
    await this.#patchLocalHeader({...head, zip64: false}, 0, 0, 0)
    return this.#record({name, method: 0, crc: 0, csize: 0, size: 0, mtime, mode, offset: head.headerPos, isDir: true})
  }

  #record(entry) {
    this.names.add(entry.name)
    this.entries.push(entry)
    return entry
  }

  /** central directory 里的一条 */
  #centralEntry(e) {
    return centralEntryBuf(e)
  }

  /** 写 central directory + EOCD，关闭文件 */
  async finalize() {
    const cdStart = this.pos
    for (const e of this.entries) await this.#write(this.#centralEntry(e))
    const cdSize = this.pos - cdStart
    for (const buf of endRecordBufs(this.entries.length, cdSize, cdStart)) await this.#write(buf)

    const bytes = this.pos
    await this.fh.close()
    this.fh = null
    return {entries: this.entries, bytes}
  }

  /** 中途出错时收尾：关句柄、删掉写坏的半个包 */
  async abort() {
    try {
      await this.fh?.close()
    } catch {
      // 已经关了
    }
    this.fh = null
    await fs.promises.rm(this.destPath, {force: true}).catch(() => {})
  }
}

/**
 * 流式打包成 zip：边遍历边往响应里吐，内存恒定、不落临时文件。
 *
 * 「下载整个文件夹」要能对付 `resources/`、`node_modules/` 这种几万文件几个 G 的目录，
 * 先打完再发既占磁盘、又让浏览器干等半天，所以走这条路。代价是**中途出错没法挽回** ——
 * 头都发出去了，只能掐断连接让下载失败（打开文件失败的还能跳过，见下面）。
 *
 * @param {AsyncIterable<object>|Iterable<object>} entries 条目，字段同 {@link walkDir} 的产出：
 *   `{name, abs, isDir, size, mtimeMs, mode}`，`name` 是包内路径
 * @param {object} [opts]
 * @param {number} [opts.level] deflate 级别，默认 6
 * @param {number} [opts.inlineLimit] 不超过这个大小的文件先在内存里压完再写头，
 *   这样不用 data descriptor（兼容性更好）；默认 {@link INLINE_LIMIT}
 * @param {number} [opts.zip64Threshold] 切 zip64 字段的阈值，**只给单测用**：默认 4G 附近，
 *   调小了才能不造 4G 文件就验证 zip64 分支
 * @return {import('node:stream').Readable} 直接 pipe 给 res
 */
export function createZipStream(entries, opts = {}) {
  const level = opts.level ?? 6
  const inlineLimit = opts.inlineLimit ?? INLINE_LIMIT
  const zip64Limit = opts.zip64Threshold ?? ZIP64_SIZE_LIMIT

  async function* generate() {
    /** @type {object[]} central directory 用 */
    const records = []
    /** 已写字节数，也就是下一条 local header 的偏移 */
    let pos = 0
    const names = new Set()

    /** 记一条并推进 pos */
    function* emit(buf) {
      pos += buf.length
      yield buf
    }

    for await (const item of entries) {
      const name = normalizeEntryName(item.name, item.isDir)
      if (!name || names.has(name)) continue

      if (item.isDir) {
        // 目录条目：长度 0，名字以 / 结尾，光靠它让空文件夹也能还原出来
        const {buf} = localHeaderBuf({name, method: 0, mtime: item.mtimeMs})
        const offset = pos
        yield* emit(buf)
        names.add(name)
        records.push({
          name, method: 0, crc: 0, csize: 0, size: 0,
          mtime: item.mtimeMs, mode: item.mode ?? 0o755, offset, isDir: true,
        })
        continue
      }

      // 先打开再写头：没权限 / 遍历完就被删的文件直接跳过，头写出去了可就没法撤了
      let handle
      try {
        handle = await fs.promises.open(item.abs, 'r')
      } catch {
        continue
      }
      try {
        const rec = yield* item.size <= inlineLimit
          ? inlineEntry(name, handle, item, pos, level)
          : streamEntry(name, handle, item, pos, level, zip64Limit)
        pos += rec.written
        names.add(name)
        records.push(rec)
      } finally {
        await handle.close().catch(() => {})
      }
    }

    const cdStart = pos
    let cdSize = 0
    for (const e of records) {
      const buf = centralEntryBuf(e, zip64Limit)
      cdSize += buf.length
      yield buf
    }
    for (const buf of endRecordBufs(records.length, cdSize, cdStart, zip64Limit)) yield buf
  }

  return Readable.from(generate())
}

/**
 * 小文件：一次读完、内存里压完，crc 和两个长度此刻都知道，头里直接写真值 ——
 * 不用 data descriptor，兼容性跟 {@link ZipWriter} 打出来的包一致。
 *
 * 压缩走异步的 deflateRaw：这是在响应请求的路径上，deflateRawSync 会把整个事件循环
 * （所有 WebSocket、心跳、别的请求）按住不放。
 * @return {AsyncGenerator<Buffer, object>} 产出字节，返回值是 central directory 用的记录（带 written）
 */
async function* inlineEntry(name, handle, item, offset, level) {
  const raw = await handle.readFile()
  let method = shouldStore(name) ? 0 : 8
  let body = raw
  if (method === 8) {
    const deflated = await deflateRaw(raw, {level})
    // 压不动就存原样，别把包搞更大
    if (deflated.length < raw.length) body = deflated
    else method = 0
  }
  const crc = crc32(raw)
  const {buf} = localHeaderBuf({
    name, method, mtime: item.mtimeMs, crc, csizeField: body.length, sizeField: raw.length,
  })
  yield buf
  if (body.length) yield body
  return {
    name, method, crc, csize: body.length, size: raw.length,
    mtime: item.mtimeMs, mode: item.mode ?? 0o644, offset, isDir: false,
    written: buf.length + body.length,
  }
}

/**
 * 大文件：边读边压边发，压完才知道 crc 和长度，所以头里留空、末尾补 data descriptor
 * （general purpose flag bit 3）。原始大小超阈值的还要在头里预留 zip64 extra，
 * 否则 descriptor 里的 8 字节长度就没地方对应。
 * @return {AsyncGenerator<Buffer, object>}
 */
async function* streamEntry(name, handle, item, offset, level, zip64Limit) {
  const method = shouldStore(name) ? 0 : 8
  const zip64 = item.size > zip64Limit
  const flags = FLAG_UTF8 | FLAG_DESC
  const {buf: header} = localHeaderBuf({
    name, method, mtime: item.mtimeMs, flags,
    zip64Extra: zip64 ? {size: 0, csize: 0} : null,
  })
  yield header

  let crc = 0
  let size = 0
  let csize = 0
  // 读到的原始字节边过边算 CRC，压缩后的字节直接往下游发
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      crc = crc32(chunk, crc)
      size += chunk.length
      cb(null, chunk)
    },
  })
  const rs = handle.createReadStream({autoClose: false, highWaterMark: CHUNK_SIZE})
  const deflate = method === 8 ? zlib.createDeflateRaw({level, chunkSize: CHUNK_SIZE}) : null
  const tail = deflate ?? tap
  // 上游任何错误都掐掉末端，让下面的 for await 抛出去（整个响应随之断掉）
  rs.on('error', (e) => tail.destroy(e))
  tap.on('error', (e) => tail.destroy(e))
  if (deflate) tap.pipe(deflate)
  rs.pipe(tap)
  try {
    // for await 由消费端驱动，背压天然成立
    for await (const chunk of tail) {
      csize += chunk.length
      yield chunk
    }
  } finally {
    // 客户端中途断开时这个 generator 会被 return，这里保证读流和 deflate 都释放
    rs.destroy()
    tap.destroy()
    deflate?.destroy()
  }
  const desc = dataDescriptorBuf(crc, csize, size, zip64)
  yield desc
  return {
    name, method, crc, csize, size, flags,
    mtime: item.mtimeMs, mode: item.mode ?? 0o644, offset, isDir: false,
    written: header.length + csize + desc.length,
  }
}

/** 从尾部找 EOCD。comment 最长 65535，加上 22 字节头，读这么多够了 */
function findEocd(fd, fileSize) {
  const len = Math.min(fileSize, 65557 + 22)
  const buf = Buffer.alloc(len)
  fs.readSync(fd, buf, 0, len, fileSize - len)
  for (let i = len - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return {buf, at: i, base: fileSize - len}
    }
  }
  return null
}

/** 解析 central directory 里的 zip64 extra field，返回覆盖值 */
function parseZip64Extra(extra, need) {
  const out = {}
  let at = 0
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    const body = extra.subarray(at + 4, at + 4 + size)
    if (id === 0x0001) {
      let p = 0
      // 出现顺序固定，但只有 32 位字段是哨兵的那些才在这里
      if (need.size && p + 8 <= body.length) {
        out.size = Number(body.readBigUInt64LE(p))
        p += 8
      }
      if (need.csize && p + 8 <= body.length) {
        out.csize = Number(body.readBigUInt64LE(p))
        p += 8
      }
      if (need.offset && p + 8 <= body.length) {
        out.offset = Number(body.readBigUInt64LE(p))
      }
      break
    }
    at += 4 + size
  }
  return out
}

/**
 * 读出全部 entry（只碰尾部的 central directory，不读数据）。
 * @param {string} absPath
 * @return {{entries: object[], comment: string}}
 */
export function readEntries(absPath) {
  const fd = fs.openSync(absPath, 'r')
  try {
    const fileSize = fs.statSync(absPath).size
    if (fileSize < 22) throw new Error('不是有效的 zip 文件（太小）')
    const found = findEocd(fd, fileSize)
    if (!found) throw new Error('不是有效的 zip 文件（找不到 EOCD）')
    const {buf, at, base} = found

    let count = buf.readUInt16LE(at + 8)
    let cdSize = buf.readUInt32LE(at + 12)
    let cdStart = buf.readUInt32LE(at + 16)
    const commentLen = buf.readUInt16LE(at + 20)
    const comment = commentLen ? buf.subarray(at + 22, at + 22 + commentLen).toString('utf8') : ''

    // 有哨兵就说明真值在 zip64 EOCD 里，locator 紧贴在 EOCD 前面。
    // 注意 count 恰好是 65535 的普通包也会撞上这个判断，所以签名对不上就沿用 32 位值
    if (count === U16_MAX || cdSize === U32_MAX || cdStart === U32_MAX) {
      const locPos = base + at - 20
      if (locPos >= 0) {
        const loc = Buffer.alloc(20)
        fs.readSync(fd, loc, 0, 20, locPos)
        if (loc.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
          const zPos = Number(loc.readBigUInt64LE(8))
          const z = Buffer.alloc(56)
          fs.readSync(fd, z, 0, 56, zPos)
          if (z.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('zip64 EOCD 缺失')
          count = Number(z.readBigUInt64LE(32))
          cdSize = Number(z.readBigUInt64LE(40))
          cdStart = Number(z.readBigUInt64LE(48))
        }
      }
    }

    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdStart)
    const entries = []
    let p = 0
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) break
      const method = cd.readUInt16LE(p + 10)
      const time = cd.readUInt16LE(p + 12)
      const date = cd.readUInt16LE(p + 14)
      const crc = cd.readUInt32LE(p + 16)
      let csize = cd.readUInt32LE(p + 20)
      let size = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLength = cd.readUInt16LE(p + 32)
      const externalAttr = cd.readUInt32LE(p + 38)
      let offset = cd.readUInt32LE(p + 42)
      // 我们自己写的包一定是 UTF-8；别家的包 bit 11 没设时也基本是 UTF-8，统一按它解
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      if (extraLen) {
        const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
        const need = {size: size === U32_MAX, csize: csize === U32_MAX, offset: offset === U32_MAX}
        if (need.size || need.csize || need.offset) {
          const z = parseZip64Extra(extra, need)
          if (z.size !== undefined) size = z.size
          if (z.csize !== undefined) csize = z.csize
          if (z.offset !== undefined) offset = z.offset
        }
      }
      const mode = (externalAttr >>> 16) & 0o7777
      entries.push({
        name,
        method,
        crc,
        csize,
        size,
        offset,
        mode: mode || 0,
        isDir: name.endsWith('/') || !!(externalAttr & 0x10),
        mtime: fromDosDateTime(date, time),
      })
      p += 46 + nameLen + extraLen + commentLength
    }
    return {entries, comment}
  } finally {
    fs.closeSync(fd)
  }
}

/** 数据区起始位置：local header 长度不固定（name / extra），得读出来算 */
function dataOffset(fd, entry) {
  const head = Buffer.alloc(30)
  fs.readSync(fd, head, 0, 30, entry.offset)
  if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`local header 损坏：${entry.name}`)
  return entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
}

/**
 * 读出单个 entry 的内容（给 manifest.json 这类小文件用，大文件请走 extractEntry）。
 * @param {string} absPath
 * @param {object} entry {@link readEntries} 给出的条目
 * @return {Buffer}
 */
export function readEntryBuffer(absPath, entry) {
  const fd = fs.openSync(absPath, 'r')
  try {
    const start = dataOffset(fd, entry)
    const raw = Buffer.alloc(entry.csize)
    if (entry.csize) fs.readSync(fd, raw, 0, entry.csize, start)
    const out = entry.method === 8 ? zlib.inflateRawSync(raw) : raw
    if (crc32(out) !== entry.crc) throw new Error(`CRC 校验失败：${entry.name}`)
    return out
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 解出单个 entry 到指定路径（流式，内存恒定）。目录 entry 只建目录。
 * @param {string} absPath zip 路径
 * @param {object} entry {@link readEntries} 给出的条目
 * @param {string} destAbs 目标文件绝对路径（调用方负责校验没越界）
 */
export async function extractEntry(absPath, entry, destAbs) {
  if (entry.isDir) {
    await fs.promises.mkdir(destAbs, {recursive: true})
    return
  }
  await fs.promises.mkdir(path.dirname(destAbs), {recursive: true})
  const fd = fs.openSync(absPath, 'r')
  let start
  try {
    start = dataOffset(fd, entry)
  } finally {
    fs.closeSync(fd)
  }

  if (!entry.csize && !entry.size) {
    // 空文件：建流反而麻烦
    await fs.promises.writeFile(destAbs, '')
  } else {
    let crc = 0
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        crc = crc32(chunk, crc)
        cb(null, chunk)
      },
    })
    const rs = fs.createReadStream(absPath, {start, end: start + entry.csize - 1, highWaterMark: CHUNK_SIZE})
    const steps = [rs]
    if (entry.method === 8) steps.push(zlib.createInflateRaw({chunkSize: CHUNK_SIZE}))
    else if (entry.method !== 0) throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`)
    steps.push(tap, fs.createWriteStream(destAbs))
    await pipeline(...steps)
    if (crc !== entry.crc) {
      await fs.promises.rm(destAbs, {force: true}).catch(() => {})
      throw new Error(`CRC 校验失败：${entry.name}`)
    }
  }
  if (entry.mode) await fs.promises.chmod(destAbs, entry.mode).catch(() => {})
  if (entry.mtime instanceof Date && !Number.isNaN(entry.mtime.getTime())) {
    await fs.promises.utimes(destAbs, entry.mtime, entry.mtime).catch(() => {})
  }
}

/**
 * 包内路径 → 目标绝对路径，顺手做 zip-slip 校验。
 *
 * 备份包可能来自别处（页面支持上传外部包还原），entry 名里塞 `../../etc/passwd`
 * 或绝对路径就能写到 Bot 目录外面去，所以解包前每条都要过一遍。
 *
 * @param {string} rootAbs 允许写入的根
 * @param {string} entryName 包内路径
 * @return {string|null} 合法则返回绝对路径，越界返回 null
 */
export function safeJoin(rootAbs, entryName) {
  const rel = normalizeEntryName(entryName).replace(/\/+$/, '')
  const parts = rel.split('/')
  if (!rel || parts.includes('..')) return null
  const abs = path.resolve(rootAbs, rel)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null

  // 字符串在根内不代表最终落盘也在根内：目标机可能已有 `config -> /etc` 这样的符号链接。
  // createWriteStream 会直接跟随它，外部备份包就能借此写出 Yunzai。逐段 lstat，连最终文件本身
  // 是 symlink 也拒绝。不存在的后续路径安全，因为调用方只会在已验证的父链下面 mkdir。
  let current = path.resolve(rootAbs)
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return null
    } catch (err) {
      if (err?.code === 'ENOENT') break
      return null
    }
  }
  return abs
}
