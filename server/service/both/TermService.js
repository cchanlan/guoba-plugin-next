import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import {spawn} from 'node:child_process'
import {GuobaError, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/** 输出缓冲上限，超了从头挤（同日志页） */
const MAX_LINES = 2000

/**
 * 热重载键：锅巴热重载时本模块被重新 import，实例是新的，但旧命令子进程可能还活着。
 * 把子进程挂到 process 上，新实例构造时看到旧的先杀掉。
 */
const PROC_KEY = Symbol.for('guoba.term.proc')

const IS_WIN = process.platform === 'win32'

/**
 * 终端。
 *
 * 每条命令单独 spawn 一个 shell（Linux `bash -c`、Windows `powershell -Command`），
 * cwd 由后端追踪（纯 `cd` 命令后端解析更新），输出流式读到内存缓冲，前端拿 seq 游标
 * 轮询增量（同 LogService 范式）。
 *
 * 为什么不用长驻 shell：bash 从非 tty 的 stdin 读时，收到 SIGINT 中断当前命令后就不再
 * 执行后续命令（进程活着但不响应）。单命令进程 + 后端记 cwd 让 Ctrl+C 可靠 —— 直接
 * 中断正在跑的那条命令，下一条照常开新进程。
 */
export default class TermService extends Service {

  /** 行缓冲，每行 {seq, type: 'out'|'err'|'cmd', text} */
  #lines = []
  /** 下一条的序号，只增不减 */
  #seq = 1
  /** 当前正在运行的命令子进程（没有则为 null） */
  #proc = null
  #running = false
  /** 跨 chunk 的半行，攒到换行才入缓冲 */
  #pending = ''
  /** 后端跟踪的当前目录：cd 时解析更新，命令 spawn 时作为 cwd */
  #cwd = ''
  #home = os.homedir()
  #user = ''
  #host = ''

  /**
   * @param {object} guobaApp
   * @param {string} [root] 工作目录，默认 Yunzai 根（测试时传临时目录）
   */
  constructor(guobaApp, root) {
    super(guobaApp)
    this.root = root || _paths.root
    this.#cwd = this.root
    this.shell = IS_WIN ? 'powershell.exe' : 'bash'
    try {
      this.#user = os.userInfo().username
    } catch {
      this.#user = process.env.USER || 'user'
    }
    this.#host = os.hostname() || 'host'
    // 热重载接管：上一代的命令子进程若还活着，杀掉
    const old = process[PROC_KEY]
    if (old && typeof old.kill === 'function') {
      try { old.kill() } catch { /* 已经死了 */ }
      delete process[PROC_KEY]
    }
  }

  /** stdout/stderr 的 chunk 按换行拆进缓冲，攒半行等下一个 chunk */
  #feed(chunk, type) {
    this.#pending += String(chunk)
    let idx
    while ((idx = this.#pending.indexOf('\n')) !== -1) {
      const line = this.#pending.slice(0, idx).replace(/\r$/, '')
      this.#pending = this.#pending.slice(idx + 1)
      this.#push(type, line)
    }
  }

  #push(type, text) {
    this.#lines.push({seq: this.#seq++, type, text})
    if (this.#lines.length > MAX_LINES) {
      this.#lines.splice(0, this.#lines.length - MAX_LINES)
    }
  }

  /** 启动一条命令子进程 */
  #spawnCmd(cmd) {
    const args = IS_WIN ? ['-NoProfile', '-Command', cmd] : ['-c', cmd]
    const proc = spawn(this.shell, args, {
      cwd: this.#cwd,
      windowsHide: true,
      // Linux 独立进程组，Ctrl+C 可以给整组（bash -c 及其子进程）发 SIGINT
      detached: !IS_WIN,
      env: {...process.env, TERM: 'xterm'},
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#proc = proc
    process[PROC_KEY] = proc
    this.#running = true
    this.#pending = ''
    proc.stdout?.on('data', (c) => this.#feed(c, 'out'))
    proc.stderr?.on('data', (c) => this.#feed(c, 'err'))
    proc.on('error', (err) => {
      this.#running = false
      this.#proc = null
      this.#push('err', `[终端] ${err?.message ?? err}`)
      if (process[PROC_KEY] === proc) delete process[PROC_KEY]
    })
    proc.on('exit', (code) => {
      this.#running = false
      this.#proc = null
      if (process[PROC_KEY] === proc) delete process[PROC_KEY]
      // 非零退出码提示一下命令结束了（pm2 log 被 Ctrl+C 中断是 130）
      if (code) this.#push('err', `[exit ${code}]`)
    })
    proc.stdin?.on('error', () => {})
  }

  /** 真终端风格的提示符：`root@chan:~/Yunzai/plugins# `，home 缩写为 ~ */
  #prompt() {
    let cwd = this.#cwd
    const home = this.#home
    if (cwd === home) cwd = '~'
    else if (cwd.startsWith(home + path.sep)) cwd = `~${cwd.slice(home.length)}`
    const sym = IS_WIN ? '>' : (this.#user === 'root' ? '#' : '$')
    return `${this.#user}@${this.#host}:${cwd}${sym} `
  }

  /**
   * 解析纯 cd 命令（不带 && 、| 、; 这些），返回目标绝对路径；不是 cd 返回 null。
   * 目标目录存在才更新 cwd，否则交给 shell 自己报错。
   */
  #parseCd(text) {
    const m = String(text).match(/^\s*cd\s+([^\s;&|<>]*)?\s*$/)
    if (!m) return null
    let target = m[1] ?? '~'
    if (target === '~') target = this.#home
    else if (target.startsWith('~/')) target = path.join(this.#home, target.slice(2))
    else target = path.resolve(this.#cwd, target)
    return target
  }

  /** 执行一条命令 */
  exec(cmd) {
    const text = String(cmd ?? '').trim()
    if (!text) return {ok: false}
    if (this.#running) throw new GuobaError('有命令正在执行，先点 Ctrl+C 中断')
    // 纯 cd：后端直接更新 cwd，不 spawn（路径由下一行提示符体现，像真终端）
    const cdTarget = this.#parseCd(text)
    if (cdTarget) {
      try {
        if (fs.existsSync(cdTarget) && fs.statSync(cdTarget).isDirectory()) {
          this.#cwd = cdTarget
          this.#push('cmd', `${this.#prompt()}${text}`)
          return {ok: true}
        }
      } catch {
        // 解析不了就按普通命令 spawn，让 shell 自己报错
      }
    }
    this.#push('cmd', `${this.#prompt()}${text}`)
    this.#spawnCmd(text)
    return {ok: true}
  }

  /**
   * 中断正在运行的命令（键盘 Ctrl+C）。Linux 给整条命令的进程组发 SIGINT，
   * pm2 log 这类前台进程会停，shell 不受影响（每条命令独立进程）。
   */
  interrupt() {
    if (!this.#proc) throw new GuobaError('没有正在执行的命令')
    this.#push('out', '^C')
    // 明确告诉用户命令被中断了，以及现在在哪个目录
    this.#push('out', `已中断 → ${this.#cwd}`)
    try {
      if (!IS_WIN && this.#proc.pid) {
        process.kill(-this.#proc.pid, 'SIGINT')
      } else {
        this.#proc.kill('SIGINT')
      }
    } catch {
      try { this.#proc.kill() } catch { /* 已经没了 */ }
    }
    return {ok: true}
  }

  /** 增量拉取输出，游标跟全量走 */
  query(cursor = 0) {
    const from = Number(cursor) || 0
    return {
      lines: this.#lines.filter((l) => l.seq > from),
      cursor: this.#seq - 1,
      running: this.#running,
      shell: this.shell,
      cwd: this.#cwd,
      prompt: this.#prompt(),
    }
  }

  /** 重启会话：中断当前命令、清空缓冲、cwd 回根 */
  restart() {
    if (this.#proc) {
      try { this.#proc.kill() } catch { /* ignore */ }
      this.#proc = null
      if (process[PROC_KEY]) delete process[PROC_KEY]
    }
    this.#lines = []
    this.#seq = 1
    this.#pending = ''
    this.#running = false
    this.#cwd = this.root
    return {ok: true}
  }

  status() {
    return {
      shell: this.shell,
      cwd: this.#cwd,
      running: this.#running,
      count: this.#lines.length,
      attached: !!this.#proc,
      prompt: this.#prompt(),
    }
  }
}
