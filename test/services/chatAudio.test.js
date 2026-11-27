import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {encode} from 'silk-wasm'
import {AudioCache, playableAudio, sendAudio} from '../../server/service/both/model/chatAudio.js'

const wav = Buffer.alloc(44 + 48000)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(48000, 40)
const frame = Buffer.alloc(13); frame[0] = 4 // AMR-NB 4.75 kbps，合成零参数帧，无私人语音
const amr = Buffer.concat([Buffer.from('#!AMR\n'), ...Array(50).fill(frame)])

function response() {
  return {headers: {}, statusCode: 200, type(v) {this.mime = v; return this},
    set(k, v) {this.headers[k] = v; return this}, status(v) {this.statusCode = v; return this},
    send(v) {this.body = v; return this}, end() {return this}}
}

test('真实文件头覆盖 CDN 错报的 MIME，不重复编码已有 WAV / MP3', async () => {
  const a = await playableAudio({buffer: wav, mime: 'audio/mp3'})
  assert.equal(a.mime, 'audio/wav'); assert.equal(a.buffer, wav)
  const mp3 = Buffer.from('ID3-test')
  const b = await playableAudio({buffer: mp3, mime: 'application/octet-stream'})
  assert.equal(b.mime, 'audio/mpeg'); assert.equal(b.buffer, mp3)
})

test('实际 SILK 编解码后返回有准确长度的单声道 WAV', async () => {
  const pcm = Buffer.alloc(48000)
  for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI * 880 / 24000) * 5000), i * 2)
  const silk = await encode(pcm, 24000)
  const a = await playableAudio({buffer: Buffer.from(silk.data), mime: 'audio/mp3'})
  assert.equal(a.mime, 'audio/wav')
  assert.equal(a.buffer.toString('ascii', 0, 4), 'RIFF')
  assert.equal(a.buffer.readUInt32LE(4), a.buffer.length - 8)
  assert.equal(a.buffer.readUInt32LE(40), a.buffer.length - 44)
  assert.ok(Math.abs((a.buffer.length - 44) / 48000 - 1) < 0.1)
})

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], {windowsHide: true}).status === 0
test('实际 AMR 解码，修复标成 MP3 却无法播放的输入', {skip: !hasFfmpeg}, async () => {
  const a = await playableAudio({buffer: amr, mime: 'audio/mp3'})
  assert.equal(a.mime, 'audio/wav'); assert.equal((a.buffer.length - 44) / 48000, 1)
})

test('缺少 ffmpeg 时明确报错，子进程不产生未处理 EPIPE', async () => {
  await assert.rejects(playableAudio({buffer: amr}, {ffmpeg: 'guoba-missing-ffmpeg-test'}), /未找到 ffmpeg/)
})

test('拒绝空数据、过大文件、HTML 错误页', async () => {
  for (const buffer of [Buffer.alloc(0), Buffer.alloc(20 * 1024 * 1024 + 1), Buffer.from('<html>Expired</html>')]) {
    await assert.rejects(playableAudio({buffer, mime: 'audio/mp3'}))
  }
})

test('重复并发请求只下载转换一次，命中缓存不再读取源文件', async () => {
  const cache = new AudioCache(); let loads = 0
  const load = async () => {loads++; return {buffer: wav}}
  const values = await Promise.all(Array.from({length: 5}, () => cache.get('voice', load)))
  assert.equal(loads, 1); assert.ok(values.every(v => v === values[0]))
  await cache.get('voice', load); assert.equal(loads, 1)
})

test('转换失败不会污染缓存，后续可以重试', async () => {
  const cache = new AudioCache()
  await assert.rejects(cache.get('voice', async () => {throw new Error('expired')}))
  assert.equal((await cache.get('voice', async () => ({buffer: wav}))).mime, 'audio/wav')
})

test('并行解码最多两个，排队请求最终全部完成', async () => {
  const cache = new AudioCache(); let active = 0, peak = 0
  await Promise.all(Array.from({length: 8}, (_, i) => cache.get(String(i), async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 10)); active--
    return {buffer: wav}
  })))
  assert.equal(peak, 2)
})

test('完整响应与首部、尾部、开放区间 Range 均返回正确字节', () => {
  for (const [range, start, end, status] of [[undefined, 0, wav.length - 1, 200],
    ['bytes=0-43', 0, 43, 206], ['bytes=-10', wav.length - 10, wav.length - 1, 206],
    ['bytes=44-', 44, wav.length - 1, 206], ['bytes=0-999999', 0, wav.length - 1, 206]]) {
    const res = response(); sendAudio({headers: {range}}, res, {buffer: wav, mime: 'audio/wav'})
    assert.equal(res.statusCode, status); assert.deepEqual(res.body, wav.subarray(start, end + 1))
    assert.equal(res.headers['Accept-Ranges'], 'bytes')
  }
})

test('越界和畸形 Range 返回 416，不泄露完整文件', () => {
  for (const range of ['bytes=999999-', 'bytes=5-1', 'bytes=-0', 'bytes=-', 'nonsense', 'bytes=0-1,3-4']) {
    const res = response(); sendAudio({headers: {range}}, res, {buffer: wav, mime: 'audio/wav'})
    assert.equal(res.statusCode, 416); assert.equal(res.body, undefined)
    assert.equal(res.headers['Content-Range'], `bytes */${wav.length}`)
  }
})
