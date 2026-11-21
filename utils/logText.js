/** 日志显示与导出的纯文本边界；不改变宿主落盘的原始日志。 */
const HIDDEN = '不给你看喵！'
const SECRET_KEYS = 'authorization|access[_-]?token|refresh[_-]?token|stoken|ltoken|cookie|password|passwd|secret|api[_-]?key|token'
const QUOTED_SECRET = new RegExp(`(\\b(?:${SECRET_KEYS})\\b['"]?\\s*[:=]\\s*)(['"])(?:(?!\\2)[\\s\\S])*?\\2`, 'gi')
const BARE_SECRET = new RegExp(`(\\b(?:${SECRET_KEYS})\\b['"]?\\s*[:=]\\s*)(?!['"])(?:Bearer\\s+)?[^\\s,;}\\]'"]+`, 'gi')

/** 上限仍按 UTF-16 长度计，但绝不从代理对中间切开。 */
export function sliceLogText(value, max) {
  const text = String(value ?? '')
  let end = Math.max(0, Math.floor(max))
  if (text.length <= end) return text
  const prev = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
  return text.slice(0, end)
}

export function redactLogSecrets(value) {
  return String(value ?? '')
    .replace(/headers:\s*\{[\s\S]*?\}/gi, `headers: { ${HIDDEN} }`)
    .replace(QUOTED_SECRET, (_match, prefix, quote) => `${prefix}${quote}${HIDDEN}${quote}`)
    .replace(BARE_SECRET, (_match, prefix) => `${prefix}${HIDDEN}`)
    // Cookie 可能包含多个用分号分隔的字段，不能只遮住第一个值。
    .replace(/(\bcookie\b['"]?\s*[:=]\s*)[^\r\n]+/gi, (_match, prefix) => `${prefix}${HIDDEN}`)
}

/** 只摘要明确的图片载荷，不猜测一般中文，更不删除所有替换字符来假装没有乱码。 */
export function summarizeLogBinary(value) {
  let text = String(value ?? '')
  text = text.replace(/<Buffer\s+(89 50 4e 47|ff d8 ff|47 49 46 38|52 49 46 46)[^>]*>/gi,
    (_match, magic) => `[${magic.toLowerCase().startsWith('89') ? 'PNG' : magic.toLowerCase().startsWith('ff') ? 'JPEG' : '图片'} 数据已省略]`)
  text = text.replace(/(?:base64:\/\/|data:image\/[\w.+-]+;base64,)[A-Za-z0-9+/=\s]{128,}/g, '[图片 base64 已省略]')
  const marker = /Failed to parse URL from\s+/i.exec(text)
  if (marker) {
    const start = marker.index + marker[0].length
    const payload = text.slice(start)
    let type = ''
    if (/^[�\x89]?PNG(?:\r?\n|\b)/.test(payload)) type = 'PNG'
    else if (/^GIF8[79]a/.test(payload)) type = 'GIF'
    else if (/^(?:[�\xff\xd8\x00-\x1f]){2,}/.test(payload) && /JFIF|Exif|ICC_PROFILE/.test(payload.slice(0, 1000))) type = 'JPEG'
    else if (/^RIFF[\s\S]{0,16}WEBP/.test(payload)) type = 'WebP'
    if (type) {
      // 保留真正的异常堆栈；图片字节不再把一张日志图撑满。
      const stack = /\n\s+at\s/.exec(payload)
      text = text.slice(0, start) + `[${type} 图片数据已省略]` + (stack ? payload.slice(stack.index) : '')
    }
  }
  return text
}

export function formatLogDisplay(value) {
  return redactLogSecrets(summarizeLogBinary(value))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** JSON 被放进 script 原始文本中，必须在 HTML 解析之前保护结束标签。 */
export function inlineLogJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 文字兜底分段，避免长日志再次撞上消息长度上限。 */
export function splitLogText(value, max = 1800) {
  const chunks = []
  let text = String(value ?? '')
  while (text.length > max) {
    let part = sliceLogText(text, max)
    const newline = part.lastIndexOf('\n')
    if (newline > max / 2) part = part.slice(0, newline + 1)
    chunks.push(part)
    text = text.slice(part.length)
  }
  if (text) chunks.push(text)
  return chunks
}
