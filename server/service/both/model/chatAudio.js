import {spawn} from 'node:child_process'

const SAMPLE_RATE = 24000
const MAX_INPUT = 20 * 1024 * 1024
const MAX_PCM = SAMPLE_RATE * 2 * 600

/** QQ CDN 的 Content-Type 可能把 AMR 标成 MP3，必须先看文件头。 */
export async function playableAudio({buffer, mime}, {ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('语音内容为空')
  if (buffer.length > MAX_INPUT) throw new Error('语音文件过大')
  const head = buffer.subarray(0, 16).toString('latin1')
  if (head.startsWith('#!SILK_V3') || head.startsWith('\x02#!SILK_V3')) {
    let silk
    try { silk = await import('silk-wasm') } catch {
      throw new Error('缺少语音解码依赖，请在锅巴插件目录运行 pnpm install')
    }
    if (silk.getDuration(buffer) > 600000) throw new Error('语音超过十分钟，无法预览')
    try {
      const {data} = await silk.decode(buffer, SAMPLE_RATE)
      return wav(Buffer.from(data))
    } catch {
      throw new Error('语音解码失败，文件可能已损坏')
    }
  }
  if (head.startsWith('#!AMR\n') || head.startsWith('#!AMR-WB\n')) {
    return wav(await decodeAmr(buffer, ffmpeg))
  }
  // 已可播放的格式不重复编码，也不沿用 CDN 的错误类型。
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') mime = 'audio/wav'
  else if (head.startsWith('OggS')) mime = 'audio/ogg'
  else if (head.startsWith('fLaC')) mime = 'audio/flac'
  else if (head.slice(4, 8) === 'ftyp') mime = 'audio/mp4'
  else if (head.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    mime = !head.startsWith('ID3') && (buffer[1] & 0xf6) === 0xf0 ? 'audio/aac' : 'audio/mpeg'
  } else if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) mime = 'audio/webm'
  else throw new Error('暂不支持此语音格式，或语音链接已失效')
  return {buffer, mime}
}

function wav(pcm) {
  if (!pcm.length || pcm.length > MAX_PCM || pcm.length % 2) throw new Error('语音解码结果无效或超过十分钟')
  // 管道输出 WAV 常用未知长度；自己写实际长度，浏览器才能可靠显示时长和拖动。
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return {buffer: Buffer.concat([header, pcm]), mime: 'audio/wav'}
}

function decodeAmr(buffer, executable) {
  return new Promise((resolve, reject) => {
    // 固定参数、不经 shell、不把 URL 交给 ffmpeg；解码器只允许读取管道里的 AMR。
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'pipe', '-f', 'amr', '-i', 'pipe:0', '-vn',
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
    let size = 0, failure
    const chunks = []
    const fail = (message) => { failure ||= new Error(message); child.kill('SIGKILL') }
    const timer = setTimeout(() => fail('语音转换超时，请重试'), 20000)
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > MAX_PCM) fail('语音超过十分钟，无法预览')
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.stdin.on('error', () => {}) // ffmpeg 提前退出时的 EPIPE 由 close 统一报错
    child.on('error', error => {
      clearTimeout(timer)
      reject(new Error(error.code === 'ENOENT' ? '未找到 ffmpeg，请先安装并加入 PATH' : '无法启动语音转换'))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure || new Error('语音转换失败，文件可能已损坏'))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(buffer)
  })
}

/** 缓存转换结果并合并重复请求；限制总内存与同时下载/解码的数量。 */
export class AudioCache {
  #cache = new Map()
  #pending = new Map()
  #bytes = 0
  #active = 0
  #queue = []

  async get(key, load) {
    const now = Date.now()
    for (const [id, item] of this.#cache) {
      if (item.expires <= now) { this.#cache.delete(id); this.#bytes -= item.value.buffer.length }
    }
    const hit = this.#cache.get(key)
    if (hit) return hit.value
    if (this.#pending.has(key)) return this.#pending.get(key)
    if (this.#pending.size >= 32) throw new Error('语音加载较多，请稍后重试')
    const task = this.#run(load).then(value => {
      this.#cache.set(key, {value, expires: Date.now() + 300000})
      this.#bytes += value.buffer.length
      while (this.#bytes > 32 * 1024 * 1024 || this.#cache.size > 30) {
        const oldest = this.#cache.keys().next().value
        this.#bytes -= this.#cache.get(oldest).value.buffer.length
        this.#cache.delete(oldest)
      }
      return value
    }).finally(() => this.#pending.delete(key))
    this.#pending.set(key, task)
    return task
  }

  async #run(load) {
    if (this.#active >= 2) await new Promise(resolve => this.#queue.push(resolve))
    else this.#active++
    try { return await playableAudio(await load()) } finally {
      const next = this.#queue.shift()
      if (next) next()
      else this.#active--
    }
  }
}

/** 音频支持单段 Range，兼容浏览器读取元数据与拖动播放位置。 */
export function sendAudio(req, res, {buffer, mime}) {
  res.type(mime)
  res.set('Cache-Control', 'private, max-age=300')
  res.set('Accept-Ranges', 'bytes')
  const range = req.headers.range
  if (!range) { res.send(buffer); return }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  let start = 0, end = buffer.length - 1
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1])
      if (match[2]) end = Math.min(Number(match[2]), end)
    } else start = Math.max(0, buffer.length - Number(match[2]))
  } else start = buffer.length
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= buffer.length) {
    res.set('Content-Range', `bytes */${buffer.length}`)
    res.status(416).end()
    return
  }
  res.set('Content-Range', `bytes ${start}-${end}/${buffer.length}`)
  res.status(206).send(buffer.subarray(start, end + 1))
}
