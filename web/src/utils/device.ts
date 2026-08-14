/**
 * 本机设备凭证 + 浏览器指纹。
 *
 * 凭证（id + secret）存在 localStorage，随每个请求发给后端，跟 IP 无关 ——
 * 手机流量的 IPv6 隔一会儿就换一个，只认 IP 的话验证码没完没了。
 * 后端只存 sha256，每次登录成功会换一份新 secret（见 LoginSecurityService.issueDevice）。
 *
 * 指纹只用来在「登录安全」里认出是哪台设备，**不参与放行判定**：浏览器升级、改缩放、
 * 换显示器都会让它变，客户端也能随便伪造，拿它当凭证只会误伤自己。
 *
 * 哈希是自己写的 FNV-1a：面板常跑在 http 下，`crypto.subtle` 在非安全上下文里没有。
 */

const ID_KEY = 'guoba-device-id'
const SECRET_KEY = 'guoba-device-secret'

/** 请求头名，与后端 Constant 里的保持一致 */
export const DEVICE_HEADERS = {
  id: 'x-guoba-device-id',
  secret: 'x-guoba-device-secret',
  fp: 'x-guoba-device-fp',
  info: 'x-guoba-device-info',
}

export interface DeviceCredential {
  id: string
  secret: string
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    // 隐私模式下 localStorage 可能直接抛，退化成「每次都要验证码」
    return ''
  }
}

function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 存不下就算了
  }
}

function randomId(len = 24): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const buf = new Uint8Array(len)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (const b of buf) out += chars[b % chars.length]
  return out
}

/** 本机设备 id，没有就现生成一个（secret 要等登录成功后由后端签发） */
export function getDeviceId(): string {
  let id = read(ID_KEY)
  if (!id) {
    id = randomId()
    write(ID_KEY, id)
  }
  return id
}

export function getDeviceSecret(): string {
  return read(SECRET_KEY)
}

/** 登录 / 改密码成功后保存后端签发的新凭证，旧的当场作废 */
export function saveDeviceCredential(cred?: DeviceCredential | null) {
  if (!cred?.id || !cred?.secret) return
  write(ID_KEY, cred.id)
  write(SECRET_KEY, cred.secret)
}

/** 撤销本机设备后清掉，下次登录就得走验证码 */
export function clearDeviceSecret() {
  write(SECRET_KEY, '')
}

/** 指纹用到的原始信息，顺带作为设备名显示 */
function collect() {
  const nav: any = navigator
  const ua = nav.userAgent ?? ''
  return {
    ua,
    browser: guessBrowser(ua),
    os: guessOS(ua),
    lang: nav.language ?? '',
    tz: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
      } catch {
        return ''
      }
    })(),
    screen: `${screen.width}x${screen.height}`,
    dpr: String(window.devicePixelRatio ?? 1),
    depth: String(screen.colorDepth ?? ''),
    cores: String(nav.hardwareConcurrency ?? ''),
    memory: String(nav.deviceMemory ?? ''),
    touch: String(nav.maxTouchPoints ?? 0),
  }
}

function guessBrowser(ua: string): string {
  // 顺序有讲究：Edge/Chrome 的 UA 里都带 Chrome，得先判更具体的
  const list: [RegExp, string][] = [
    [/Edg[e/]/i, 'Edge'],
    [/OPR|Opera/i, 'Opera'],
    [/QQBrowser/i, 'QQ浏览器'],
    [/MicroMessenger/i, '微信'],
    [/Firefox/i, 'Firefox'],
    [/Chrome/i, 'Chrome'],
    [/Safari/i, 'Safari'],
  ]
  for (const [reg, name] of list) if (reg.test(ua)) return name
  return '未知浏览器'
}

function guessOS(ua: string): string {
  const list: [RegExp, string][] = [
    [/Windows NT 10/i, 'Windows'],
    [/Windows/i, 'Windows'],
    [/Android/i, 'Android'],
    [/iPhone|iPad|iPod/i, 'iOS'],
    [/Mac OS X/i, 'macOS'],
    [/Linux/i, 'Linux'],
  ]
  for (const [reg, name] of list) if (reg.test(ua)) return name
  return '未知系统'
}

/** FNV-1a，够短够稳，只用来给指纹起个好读的名字 */
function hash(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

let cachedFp = ''
let cachedInfo = ''

function build() {
  if (cachedFp) return
  const info = collect()
  cachedFp = hash(Object.values(info).join('|'))
  cachedInfo = `${info.browser} · ${info.os} · ${info.screen}`
}

/** 指纹短哈希，仅展示用 */
export function getFingerprint(): string {
  build()
  return cachedFp
}

/** 人能读的设备摘要，登录安全页拿它当设备名 */
export function getDeviceInfo(): string {
  build()
  return cachedInfo
}

/**
 * 请求头。
 *
 * info 里有中文，而请求头只认 latin1，得先 encodeURIComponent（后端会解回来）。
 */
export function deviceHeaders(): Record<string, string> {
  const out: Record<string, string> = {
    [DEVICE_HEADERS.id]: getDeviceId(),
    [DEVICE_HEADERS.fp]: getFingerprint(),
    [DEVICE_HEADERS.info]: encodeURIComponent(getDeviceInfo()),
  }
  const secret = getDeviceSecret()
  if (secret) out[DEVICE_HEADERS.secret] = secret
  return out
}
