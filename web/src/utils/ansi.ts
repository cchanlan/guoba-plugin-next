/**
 * ANSI 配色解析。
 *
 * 云崽的日志在终端里是彩色的（log4js + 各插件自己打的颜色），颜色信息就在 SGR
 * 转义序列里。后端把带色的正文原样带上来（`LogLine.ansi`），这里解析成一串
 * `{text, 样式}`，交给模板用 span 渲染 —— 不走 v-html，日志内容里的尖括号
 * 就永远不会被当标签解释。
 *
 * 只认颜色 / 字重相关的参数，光标移动、清屏那些后端已经滤掉了。
 * 8 色和它们的亮色版走 CSS 变量（见 styles/index.css 的 --g-ansi-*），
 * 深浅主题各一套；256 色和真彩色没法预调，直接给 hex。
 */

/** SGR 序列：`ESC[` + 若干分号分隔的数字 + `m` */
const SGR_RE = /\x1B\[([0-9;]*)m/g

/** 基础 8 色的变量名，索引即 SGR 的 30-37 / 40-47 */
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/** xterm 256 色表里 16-231 那段立方体的分量取值 */
const CUBE = [0, 95, 135, 175, 215, 255]

export interface AnsiSpan {
  text: string
  /** 可直接写进 style 的颜色值 */
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

/** 当前生效的样式，遇到 0 复位 */
interface State {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** 反显（7）：前景背景对调，交给渲染时处理 */
  inverse?: boolean
}

function hex(r: number, g: number, b: number) {
  const to = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** xterm 256 色：0-15 是基础色，16-231 是 6×6×6 立方体，232-255 是灰阶 */
function color256(n: number) {
  if (n < 8) return `var(--g-ansi-${NAMES[n]})`
  if (n < 16) return `var(--g-ansi-bright-${NAMES[n - 8]})`
  if (n < 232) {
    const i = n - 16
    return hex(CUBE[Math.floor(i / 36) % 6], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6])
  }
  const v = 8 + (n - 232) * 10
  return hex(v, v, v)
}

/**
 * 扩展色：`38;5;n`（256 色）和 `38;2;r;g;b`（真彩），`48;…` 是背景。
 * 返回消耗掉的参数个数，格式不对就当没这回事，避免把后面的参数错位解释。
 */
function extended(params: number[], i: number, state: State, isFg: boolean) {
  const mode = params[i + 1]
  let color: string | undefined
  let used = 0
  if (mode === 5 && params.length > i + 2) {
    color = color256(params[i + 2])
    used = 2
  } else if (mode === 2 && params.length > i + 4) {
    color = hex(params[i + 2], params[i + 3], params[i + 4])
    used = 4
  }
  if (color) {
    if (isFg) state.fg = color
    else state.bg = color
  }
  return used
}

function apply(state: State, params: number[]) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) {
      // 复位。key 得一个个删，state 对象是复用的
      for (const k of Object.keys(state)) delete state[k as keyof State]
    } else if (p === 1) state.bold = true
    else if (p === 2) state.dim = true
    else if (p === 3) state.italic = true
    else if (p === 4) state.underline = true
    else if (p === 7) state.inverse = true
    else if (p === 9) state.strike = true
    else if (p === 21 || p === 22) {
      state.bold = false
      state.dim = false
    } else if (p === 23) state.italic = false
    else if (p === 24) state.underline = false
    else if (p === 27) state.inverse = false
    else if (p === 29) state.strike = false
    else if (p >= 30 && p <= 37) state.fg = `var(--g-ansi-${NAMES[p - 30]})`
    else if (p === 38) i += extended(params, i, state, true)
    else if (p === 39) state.fg = undefined
    else if (p >= 40 && p <= 47) state.bg = `var(--g-ansi-${NAMES[p - 40]})`
    else if (p === 48) i += extended(params, i, state, false)
    else if (p === 49) state.bg = undefined
    else if (p >= 90 && p <= 97) state.fg = `var(--g-ansi-bright-${NAMES[p - 90]})`
    else if (p >= 100 && p <= 107) state.bg = `var(--g-ansi-bright-${NAMES[p - 100]})`
    // 其余（闪烁、字体切换之类）没人用，忽略
  }
}

/** 按当前样式产出一段。反显在这里落地：前景背景对调，缺的一边用默认前景 / 背景 */
function span(text: string, state: State): AnsiSpan {
  const out: AnsiSpan = { text }
  let { fg, bg } = state
  if (state.inverse) {
    const f = fg ?? 'var(--g-text)'
    const b = bg ?? 'var(--g-bg-soft)'
    fg = b
    bg = f
  }
  if (fg) out.fg = fg
  if (bg) out.bg = bg
  if (state.bold) out.bold = true
  if (state.dim) out.dim = true
  if (state.italic) out.italic = true
  if (state.underline) out.underline = true
  if (state.strike) out.strike = true
  return out
}

/**
 * 解析成 span 数组。没有任何转义序列时返回单个无样式 span，
 * 调用方可以拿 `spans.length === 1 && !spans[0].fg` 判断要不要走快路径。
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const raw = String(input ?? '')
  if (!raw) return []
  if (!raw.includes('\x1B')) return [{ text: raw }]

  const out: AnsiSpan[] = []
  const state: State = {}
  let last = 0
  SGR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR_RE.exec(raw))) {
    if (m.index > last) out.push(span(raw.slice(last, m.index), state))
    // `ESC[m` 等价于 `ESC[0m`；空参数段（`38;;5`）按 0 算，跟终端一致
    const params = (m[1] || '0').split(';').map((s) => (s === '' ? 0 : Number(s)))
    apply(state, params)
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push(span(raw.slice(last), state))
  return out
}

/** 拼成 span 的 style 字符串，空样式返回空串（模板里就不生成 style 属性） */
export function ansiStyle(s: AnsiSpan) {
  let css = ''
  if (s.fg) css += `color:${s.fg};`
  if (s.bg) css += `background:${s.bg};`
  if (s.bold) css += 'font-weight:600;'
  if (s.dim) css += 'opacity:.7;'
  if (s.italic) css += 'font-style:italic;'
  if (s.underline || s.strike) {
    css += `text-decoration:${[s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ')};`
  }
  return css
}
