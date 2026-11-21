import {formatLogDisplay, sliceLogText, splitLogText} from './logText.js'

/** 各宿主的截图返回值统一成标准图片段；二进制永远不经过默认 toString。 */
export function normalizeLogImage(value) {
  if (!value) return null
  if (Array.isArray(value)) {
    const images = value.map(normalizeLogImage)
    return images.length && images.every(Boolean) ? images : null
  }
  let file = value
  if (typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    if (value.type && value.type !== 'image') return null
    file = value.file ?? value.data?.file ?? value.data ?? value.buffer
  }
  if (file instanceof Uint8Array && !Buffer.isBuffer(file)) {
    file = Buffer.from(file.buffer, file.byteOffset, file.byteLength)
  }
  if (Buffer.isBuffer(file)) {
    if (!file.length) return null
    file = `base64://${file.toString('base64')}`
  } else if (typeof file === 'string') {
    if (!file.trim()) return null
    if (/^data:image\/[\w.+-]+;base64,/i.test(file)) file = `base64://${file.slice(file.indexOf(',') + 1)}`
    else if (/^[A-Za-z0-9+/]+={0,2}$/.test(file) && file.length > 100 && file.length % 4 === 0) file = `base64://${file}`
    // 字符串只接受明确的资源引用，拒绝被误转成文字的 PNG/JPEG。
    if (!/^(?:base64:\/\/|https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|[./\\])/.test(file)) return null
    if (file.startsWith('base64://') && !/^[A-Za-z0-9+/]+={0,2}$/.test(file.slice(9))) return null
  } else {
    return null
  }
  const extra = typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array) ? value : {}
  // 移除旧的二进制副本，不能归一了 file 却又把 data/buffer 原样带进协议层。
  const {data, file: oldFile, buffer: oldBuffer, ...metadata} = extra
  if (data && typeof data === 'object' && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    return {...metadata, type: 'image', data: {...data, file}}
  }
  return {...metadata, type: 'image', file}
}

/** false / 错误码不能算成功；void 也只能算未确认，不能假报成功。 */
export function isSendSuccess(result) {
  if (result === true) return true
  if (typeof result === 'string') return result.length > 0
  if (!result || typeof result !== 'object' || Buffer.isBuffer(result)) return false
  if (Array.isArray(result)) return result.length > 0 && result.every(isSendSuccess)
  if (result.ok === false || result.success === false || result.error || /^(?:failed|error)$/i.test(result.status || '')) return false
  if (result.retcode != null && Number(result.retcode) !== 0) return false
  if (result.code != null && ![0, 200].includes(Number(result.code))) return false
  if (result.ok === true || result.success === true || /^(?:ok|success)$/i.test(result.status || '')) return true
  if (result.retcode != null || result.code != null) return true
  if ([result.message_id, result.msg_id, result.id, result.seq].some(id => id != null && id !== '')) return true
  return result.data ? isSendSuccess(result.data) : false
}

function explicitlyRejected(result) {
  if (result === false || result === null) return true
  if (!result || typeof result !== 'object') return false
  return result.ok === false || result.success === false || Boolean(result.error)
    || /^(?:failed|error)$/i.test(result.status || '')
    || (result.retcode != null && Number(result.retcode) !== 0)
    || (result.code != null && ![0, 200].includes(Number(result.code)))
}

export async function sendWithTimeout(send, message, timeout = 20000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => send(message)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('发送超时，结果未确认')
          error.code = 'GUOBA_SEND_UNCONFIRMED'
          reject(error)
        }, timeout)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 已明确失败才降级；超时/void 不盲目重发，避免实际已送达时重复刷屏。 */
export async function sendLogMessage(send, image, text, {timeout = 20000} = {}) {
  const normalized = normalizeLogImage(image)
  if (normalized) {
    try {
      const result = await sendWithTimeout(send, normalized, timeout)
      if (isSendSuccess(result)) return {ok: true, fallback: false}
      if (!explicitlyRejected(result)) return {ok: false, fallback: false, uncertain: true}
      logger.warn(`[Guoba] 日志图片发送被拒绝（code=${result?.retcode ?? result?.code ?? 'false'}），改发文字`)
    } catch (error) {
      if (error?.code === 'GUOBA_SEND_UNCONFIRMED') return {ok: false, fallback: false, uncertain: true}
      // 不打印携带完整图片字节的错误对象，防止发送日志又产生二进制乱码。
      logger.warn(`[Guoba] 日志图片发送失败，改发文字：${sliceLogText(formatLogDisplay(error?.stack || error?.message || error), 1000)}`)
    }
  }
  const chunks = splitLogText(text)
  if (!chunks.length) return {ok: false, fallback: true}
  for (const chunk of chunks) {
    try {
      const result = await sendWithTimeout(send, chunk, timeout)
      if (!isSendSuccess(result)) {
        logger.warn(`[Guoba] 文字日志未确认发送成功（code=${result?.retcode ?? result?.code ?? 'unknown'}）`)
        return {ok: false, fallback: true, uncertain: !explicitlyRejected(result)}
      }
    } catch (error) {
      logger.warn(`[Guoba] 文字日志发送异常：${sliceLogText(formatLogDisplay(error?.stack || error?.message || error), 1000)}`)
      return {ok: false, fallback: true, uncertain: error?.code === 'GUOBA_SEND_UNCONFIRMED'}
    }
  }
  return {ok: true, fallback: true}
}
