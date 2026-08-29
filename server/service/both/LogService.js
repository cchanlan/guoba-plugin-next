import fs from 'fs'
import path from 'path'
import {Service, GuobaError} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import {
  formatLogText,
  getRealMasterList,
  mergeLogLines,
  renderLogImage,
  sendToMasterList,
} from '#guoba.utils'

/** 环形缓冲最多留多少行。太小了刷屏时翻不到前面，太大了白占内存 */
const MAX_LINES = 3000
/** 单行最多保留多少字符，防止有插件把一整个 JSON 打进日志 */
const MAX_LINE_LEN = 4096
/** 还没等到换行的半行攒到这么长就强制断开，兜住不带换行的进度输出 */
const MAX_PENDING = 8192
/** 启动时从磁盘日志尾部预读多少字节，只为让页面一进来不是空的 */
const PRELOAD_BYTES = 128 * 1024
/** 预读最多补多少行进缓冲 */
const PRELOAD_LINES = 300
/** 一次最多返回多少行 */
const MAX_LIMIT = 2000

/** 日志截图发给主人时，一次最多渲染多少条，跟前端取的「最近 100 行」对齐 */
const MAX_SEND_ITEMS = 100

/**
 * 劫持前的原始 write 存在 process 上。
 *
 * 插件热重载时模块会被重新 import，模块级变量留不住。挂在 process 上才能让新实例
 * 知道 stdout 已经被上一代包过一层，避免一层层套下去、同一行日志被记好几遍。
 */
const ORIGIN_KEY = Symbol.for('guoba.logService.originWrite')

/**
 * ANSI 转义序列。
 *
 * 纯文本（筛选、复制、截图用）要把它们剥干净，同时另存一份带色的正文交给前端还原
 * 终端里的配色 —— 云崽的日志颜色信息全在这些序列里，剥掉就再也拼不回来了。
 */
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]|\x1B][^\x07\x1B]*(?:\x07|\x1B\\)/g
/** 同一个模式加捕获组，切片时用它把转义序列和可见字符分开 */
const ANSI_SPLIT_RE = new RegExp(`(${ANSI_RE.source})`)
/** 只有 SGR（`ESC[...m`）是颜色 / 字重，光标移动、清屏之类留着没用还会干扰前端 */
const SGR_RE = /^\x1B\[[0-9;]*m$/
/** log4js 的 pattern 是 `[%d{hh:mm:ss.SSS}][%4.4p]%m`，据此抠出时间和级别 */
const HEAD_RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)]\[([A-Za-z]+)\s*]/
/** `%4.4p` 把级别截成 4 个字符，这里还原回完整名字 */
const LEVELS = {
  TRAC: 'trace',
  DEBU: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERRO: 'error',
  FATA: 'fatal',
  MARK: 'mark',
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 按「可见字符」切一段，保留颜色。
 *
 * 跳过前 `skip` 个可见字符、最多保留 `max` 个，转义序列不计长度。被跳过那段里的
 * SGR 要搬到结果开头 —— 时间戳和级别常常被整段染色（`ESC[33m[…][WARN]…ESC[39m`），
 * 直接扔掉的话剩下的正文就丢了颜色。
 */
function sliceAnsi(raw, skip, max) {
  /** 落在 skip 区间里的 SGR，攒着前置到正文 */
  let prefix = ''
  let out = ''
  /** 走过的可见字符数，含被跳过的 */
  let vis = 0
  for (const part of raw.split(ANSI_SPLIT_RE)) {
    if (!part) continue
    if (part.charCodeAt(0) === 0x1b) {
      if (!SGR_RE.test(part)) continue
      if (vis < skip) prefix += part
      else out += part
      continue
    }
    let chunk = part
    if (vis < skip) {
      const drop = Math.min(skip - vis, chunk.length)
      vis += drop
      chunk = chunk.slice(drop)
      if (!chunk) continue
    }
    const room = max - (vis - skip)
    if (room <= 0) break
    if (chunk.length > room) {
      out += chunk.slice(0, room)
      break
    }
    out += chunk
    vis += chunk.length
  }
  return prefix + out
}

/**
 * 运行日志。
 *
 * 云崽的日志走 log4js 的 stdout appender（见 `lib/config/log.js`），info 及以下
 * 只进控制台不落盘，磁盘上的 `logs/command.*.log` 只有 warn 以上。想在面板里看到
 * 全量日志，最直接的办法就是在进程内把 stdout / stderr 接过来 —— 顺带也收得到
 * 插件里裸写的 `console.log`。
 *
 * 捕到的行存在内存环形缓冲里，每行一个单调递增的 seq；前端拿着上次的 seq 来要增量，
 * 不必重复传输已经显示过的内容，也不用维护长连接。
 */
export default class LogService extends Service {

  /** @type {{seq: number, time: string, level: string, text: string, ansi: string, cont: boolean}[]} */
  #lines = []
  /** 下一行的序号，只增不减 */
  #seq = 1
  /** 半行缓存，stdout 的一次 write 未必刚好是整行 */
  #pending = {stdout: '', stderr: ''}
  /** 原始的 write，劫持前存下来 */
  #origin = {}
  /** 多行日志（异常堆栈之类）的后续行没有级别前缀，继承上一行的 */
  #lastLevel = 'info'
  #attached = false

  constructor(guobaApp) {
    super(guobaApp)
    // 先补历史再接管，页面一打开就有内容可看
    try {
      this.#preload()
    } catch {
      // 读不到磁盘日志不影响实时捕获
    }
    this.attach()
  }

  /**
   * 接管 stdout / stderr。
   *
   * 这两个函数在整个进程里被调用得极其频繁，出任何异常都不能影响原始输出，
   * 所以捕获逻辑整个包在 try 里，且内部一律不许再调 logger / console（会无限递归）。
   */
  attach() {
    if (this.#attached) return
    this.#attached = true
    // 上一代实例留下的包装，先剥掉再包，不然每重载一次就多套一层
    const saved = process[ORIGIN_KEY] ?? {}
    for (const [key, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
      const origin = saved[key] ?? stream.write.bind(stream)
      this.#origin[key] = origin
      // write 的签名是 (chunk[, encoding][, callback])，原样透传，别自作主张补参数
      stream.write = (...args) => {
        try {
          this.#feed(key, args[0])
        } catch {
          // 吞掉，日志功能坏了也不能让 Bot 的输出断掉
        }
        return origin(...args)
      }
    }
    process[ORIGIN_KEY] = {...this.#origin}
  }

  /** 把 write 还回去，卸载插件时用 */
  detach() {
    if (!this.#attached) return
    this.#attached = false
    if (this.#origin.stdout) process.stdout.write = this.#origin.stdout
    if (this.#origin.stderr) process.stderr.write = this.#origin.stderr
    delete process[ORIGIN_KEY]
  }

  /** 攒够一行就入缓冲 */
  #feed(key, chunk) {
    if (chunk == null) return
    let text
    if (typeof chunk === 'string') {
      text = chunk
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString('utf8')
    } else {
      return
    }
    if (!text) return
    const parts = (this.#pending[key] + text).split('\n')
    // 最后一段没遇到换行，留着等下一次 write
    this.#pending[key] = parts.pop() ?? ''
    for (const line of parts) {
      this.#push(key, line)
    }
    if (this.#pending[key].length > MAX_PENDING) {
      this.#push(key, this.#pending[key])
      this.#pending[key] = ''
    }
  }

  /** 解析一行并入缓冲 */
  #push(key, raw) {
    const line = String(raw).replace(/\r/g, '')
    let text = line.replace(ANSI_RE, '')
    // 全是空白的行没有信息量，刷屏时还挺占地方
    if (!text.trim()) return
    let cut = false
    if (text.length > MAX_LINE_LEN) {
      text = text.slice(0, MAX_LINE_LEN) + ' …(已截断)'
      cut = true
    }
    const head = HEAD_RE.exec(text)
    let time = ''
    let level
    let cont = false
    let skip = 0
    if (head) {
      time = head[1]
      level = LEVELS[head[2].toUpperCase().slice(0, 4)] || 'info'
      skip = head[0].length
      text = text.slice(skip)
      this.#lastLevel = level
    } else {
      // 没前缀，大概是堆栈或者裸 console.log，跟着上一行走
      cont = true
      level = key === 'stderr' ? 'error' : this.#lastLevel
    }
    // 带色正文只在真有颜色时才留，纯文本的行没必要多传一份
    let ansi = ''
    if (line.includes('\x1B')) {
      ansi = sliceAnsi(line, skip, MAX_LINE_LEN - skip)
      if (cut) ansi += ' …(已截断)'
      if (!ansi.includes('\x1B')) ansi = ''
    }
    this.#lines.push({seq: this.#seq++, time, level, text, ansi, cont})
    if (this.#lines.length > MAX_LINES * 1.2) {
      // 攒够一批再裁，省得每行都挪一次数组
      this.#lines.splice(0, this.#lines.length - MAX_LINES)
    }
  }

  /**
   * 启动前的日志从磁盘补一段。
   *
   * pm2 收着完整的 stdout，有就用它；否则退回 log4js 落盘的当天日志（只有 warn 以上）。
   * 文件动辄几十 MB，只从尾部读固定长度。
   */
  #preload() {
    const file = this.#preloadFile()
    if (!file) return
    const {size} = fs.statSync(file)
    const start = Math.max(0, size - PRELOAD_BYTES)
    const fd = fs.openSync(file, 'r')
    let text
    try {
      const len = size - start
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    const lines = text.split('\n')
    // 从中间截的，第一行多半是半截的，丢掉
    if (start > 0) lines.shift()
    for (const line of lines.slice(-PRELOAD_LINES)) {
      this.#push('stdout', line)
    }
  }

  /** 预读用哪个文件 */
  #preloadFile() {
    const candidates = [
      // pm2 注入的 stdout 日志路径，全量
      process.env.pm_out_log_path,
      // log4js 的 dateFile，当天那份没压缩
      path.join(_paths.root, 'logs', `command.${today()}.log`),
    ]
    for (const file of candidates) {
      if (!file) continue
      try {
        if (fs.statSync(file).isFile()) return file
      } catch {
        // 换下一个
      }
    }
    return null
  }

  /**
   * 取日志。
   *
   * @param cursor 上次取到的 seq，只要比它新的；不传则取最后 limit 行
   * @param options {{limit?: number, level?: string, keyword?: string}}
   */
  query(cursor, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 500, 1), MAX_LIMIT)
    const levels = this.#levelFilter(options.level)
    const keyword = String(options.keyword ?? '').trim().toLowerCase()
    const oldest = this.#lines.length ? this.#lines[0].seq : this.#seq
    const from = Number(cursor)
    // cursor 比缓冲里最老的还老，说明中间的行已经被挤掉了，前端要提示一下
    const missed = Number.isFinite(from) && from > 0 && from + 1 < oldest

    let lines = this.#lines
    if (Number.isFinite(from) && from > 0) {
      lines = lines.filter((it) => it.seq > from)
    }
    if (levels) {
      lines = lines.filter((it) => levels.has(it.level))
    }
    if (keyword) {
      lines = lines.filter((it) => it.text.toLowerCase().includes(keyword))
    }
    // 超量时保留最新的
    const total = lines.length
    if (total > limit) {
      lines = lines.slice(total - limit)
    }
    return {
      lines,
      // 游标要跟着全量走，不能被筛选影响，否则被过滤掉的行下次还会再取一遍
      cursor: this.#seq - 1,
      truncated: total > limit ? total - limit : 0,
      missed,
    }
  }

  /**
   * 级别筛选：按 log4js 的严重程度取「该级别及以上」，跟日志本身的 level 语义一致。
   * 传空或 all 表示不筛。
   */
  #levelFilter(level) {
    const order = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
    const key = String(level ?? '').trim().toLowerCase()
    if (!key || key === 'all') return null
    const idx = order.indexOf(key)
    if (idx < 0) return null
    // mark 是 log4js 里最高的级别，云崽用它打启动信息，任何筛选下都该留着
    return new Set([...order.slice(idx), 'mark'])
  }

  /** 清空缓冲。只清面板这边的显示，磁盘上的日志文件不动 */
  clear() {
    this.#lines = []
    return this.#seq - 1
  }

  /**
   * 把日志渲染成图私聊发给主人。
   *
   * 图在 Bot 进程里用宿主的渲染器出（模板见 resources/html/log.html），跟聊天里的
   * `#锅巴日志` 是同一份模板 —— 早先是前端用 canvas 画一张深色终端图上传上来，
   * 两边长得完全不一样，改成服务端渲染后只需维护一套 UI。
   *
   * 行数据由前端传：面板上有级别 / 关键字筛选，发出去的应该是「主人在页面上看到的」
   * 那些行，而不是缓冲里最新的一批。
   */
  async sendImage(body) {
    /*
     * 主人账号不一定是数字：官bot 的主人是 `appid:openid`，早先这里按 /^\d+$/ 过滤
     * masterQQ，官bot 环境下一个主人都留不下，直接报「未配置主人 QQ」。
     * 改走 master 映射：既能带上非数字账号，也知道该用哪个 Bot 发 —— 官bot 的 openid
     * 只在自己 appid 名下有效，用 Bot.pickUser 全局挑号会挑错账号。
     */
    const masters = await getRealMasterList()
    if (!masters.length) throw new GuobaError('未配置主人账号（检查 config/config/other.yaml 的 master）')
    const items = mergeLogLines(body?.lines, MAX_SEND_ITEMS)
    if (!items.length) throw new GuobaError('没有可发送的日志')
    const res = await renderLogImage(items, {title: '锅巴日志'})
    // 宿主没装渲染后端（或 Chromium 起不来）时退回文本，总比什么都收不到好
    const fallback = !res?.images?.length
    const sent = await sendToMasterList(fallback ? [formatLogText(items)] : res.images)
    if (!sent.length) throw new GuobaError('发送失败，请检查主人配置')
    return {ok: true, sent, fallback}
  }

  /** 页面上显示的状态 */
  status() {
    return {
      lines: this.#lines.length,
      max: MAX_LINES,
      cursor: this.#seq - 1,
      attached: this.#attached,
      source: process.env.pm_out_log_path ? 'pm2' : 'stdout',
      logFile: this.#preloadFile() || '',
    }
  }
}
