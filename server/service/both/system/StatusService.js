import os from 'os'
import moment from 'moment'
import {Service} from '#guoba.framework'
import {diskInfo} from '#guoba.libs'
import {collect as collectHardware, warmup as warmupHardware} from './hardware.js'

/** 采样两次 /proc 计算 CPU 占用的间隔 */
const CPU_SAMPLE_INTERVAL = 200

/**
 * 只统计真实磁盘，过滤内存盘和容器叠加层，
 * 否则 df 里的 tmpfs / overlay 会混进来把容量算歪。
 */
const IGNORE_FS = /^(udev|tmpfs|devtmpfs|overlay|squashfs|shm|none)$/i

/** 磁盘取不到时告警的最小间隔：首页每 5 秒来一次，不节流就是每 5 秒刷一行 */
const DISK_WARN_INTERVAL = 10 * 60 * 1000

/**
 * 系统状态与消息统计。
 *
 * 消息数来自 Yunzai 自身在 lib/plugins/loader.js 里累加的 `Yz:count:*`，
 * 锅巴只读不写。
 */
export class StatusService extends Service {

  constructor(app) {
    super(app)
    // 预热硬件静态信息（CPU 型号、内存条频率），别让第一次打开首页等在这儿
    warmupHardware().catch(() => {})
  }

  /** 上次为磁盘失败打日志的时刻，见 {@link DISK_WARN_INTERVAL} */
  #diskWarnAt = 0

  /** 取一次各 CPU 核心的累计时间片 */
  #cpuSnapshot() {
    let idle = 0
    let total = 0
    for (const cpu of os.cpus()) {
      for (const type of Object.keys(cpu.times)) {
        total += cpu.times[type]
      }
      idle += cpu.times.idle
    }
    return {idle, total}
  }

  /**
   * CPU 占用率。
   * os.cpus() 给的是开机以来的累计值，直接算只能得到一个平均值，
   * 所以隔一小段时间采样两次做差。
   */
  async getCpuUsage() {
    const start = this.#cpuSnapshot()
    await new Promise(resolve => setTimeout(resolve, CPU_SAMPLE_INTERVAL))
    const end = this.#cpuSnapshot()
    const totalDiff = end.total - start.total
    const idleDiff = end.idle - start.idle
    if (totalDiff <= 0) {
      return 0
    }
    return Math.min(100, Math.max(0, ((totalDiff - idleDiff) / totalDiff) * 100))
  }

  /**
   * 全部磁盘。si 不可用时的退路 —— 锅巴自带的 diskinfo 走 `df` / PowerShell CIM，
   * 拿到的盘列表跟 si 是一回事，只是没有文件系统类型。
   */
  async #getDisksFallback() {
    const drives = await this.#getDrives()
    if (!drives) return []
    const out = []
    for (const d of drives) {
      if (!d.filesystem || IGNORE_FS.test(d.filesystem)) continue
      const total = Number(d.blocks) * 1024
      const used = Number(d.used) * 1024
      if (!total) continue
      out.push({
        name: d.mounted || d.filesystem,
        fs: '',
        total,
        used,
        free: Math.max(0, total - used),
        percent: (used / total) * 100,
      })
    }
    return out
  }

  /** 读一次盘列表，失败时按 {@link DISK_WARN_INTERVAL} 节流告警 */
  async #getDrives() {
    let drives
    try {
      drives = await diskInfo.getDrives()
    } catch (e) {
      // 取不到就取不到，首页少一块磁盘卡而已 —— 但别每 5 秒刷一行 warn 把日志淹了
      const now = Date.now()
      if (now - this.#diskWarnAt > DISK_WARN_INTERVAL) {
        this.#diskWarnAt = now
        logger.warn('[Guoba] 获取磁盘信息失败：', e.message || e)
      }
      return null
    }
    return Array.isArray(drives) && drives.length ? drives : null
  }

  /**
   * 系统状态：负载、CPU、内存、SWAP、GPU、磁盘。
   *
   * 优先用 {@link collectHardware}（systeminformation）—— 它能给出 `os` 拿不到的 CPU 型号、
   * 内存频率、SWAP、显卡占用和温度。装不上就整块降级回 `os`，少几项但不会崩。
   */
  async getSystemStatus() {
    const cpuCount = os.cpus().length || 1
    // Windows 上 loadavg 恒为 [0,0,0]，前端据此隐藏该项
    const [load1, load5, load15] = os.loadavg()

    const hw = await collectHardware().catch(() => null)

    // CPU 占用：si 没给就自己采样两次算
    const cpuPercent = typeof hw?.cpu?.percent === 'number'
      ? hw.cpu.percent
      : await this.getCpuUsage()

    // 内存：si 的 active 比 os.freemem() 准（Linux 上 free 不含可回收的 buff/cache）
    let memory = hw?.memory
    if (!memory) {
      const totalMem = os.totalmem()
      const usedMem = totalMem - os.freemem()
      memory = {total: totalMem, used: usedMem, percent: (usedMem / totalMem) * 100, buffcache: 0}
    }

    const disks = hw?.disks?.length ? hw.disks : await this.#getDisksFallback()
    // 保留单值 disk 字段：老前端和外部调用方还在读它
    const disk = disks.find((d) => d.name === '/')
      ?? disks.reduce((a, b) => (!a || b.total > a.total ? b : a), null)

    return {
      load: {
        avg1: load1,
        avg5: load5,
        avg15: load15,
        cpuCount,
        // 负载按核心数归一化成百分比，超过 100% 说明已经排队
        percent: Math.min(100, (load1 / cpuCount) * 100),
        supported: os.platform() !== 'win32',
      },
      cpu: {
        percent: cpuPercent,
        count: hw?.cpu?.cores || cpuCount,
        physicalCores: hw?.cpu?.physicalCores ?? 0,
        model: hw?.cpu?.model || os.cpus()[0]?.model?.trim() || '',
        manufacturer: hw?.cpu?.manufacturer ?? '',
        /** GHz，0 表示没读到 */
        speed: hw?.cpu?.speed ?? 0,
        /** ℃，0 表示没读到（虚拟机通常读不到） */
        temp: hw?.cpu?.temp ?? 0,
      },
      memory,
      /** 内存条频率 MHz / 代际，0 和空串表示没读到 */
      memClock: hw?.memClock ?? 0,
      memType: hw?.memType ?? '',
      /** 没开 swap 时为 null */
      swap: hw?.swap ?? null,
      /** 没有独显、或读不到占用时为 null */
      gpu: hw?.gpu ?? null,
      disk,
      /** 全部磁盘，前端列表用 */
      disks,
      // 进程与主机各自的运行时长，单位秒
      uptime: {
        process: process.uptime(),
        system: os.uptime(),
      },
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      nodeVersion: process.version,
      /** 有没有 systeminformation：没有的话前端不必留出扩展项的位置 */
      extended: !!hw,
    }
  }

  /** 批量读 redis 计数，缺失按 0 处理 */
  async #mget(keys) {
    if (keys.length === 0) {
      return []
    }
    try {
      const values = await redis.mGet(keys)
      return values.map(v => Number(v) || 0)
    } catch (e) {
      logger.warn('[Guoba] 读取消息统计失败：', e.message || e)
      return keys.map(() => 0)
    }
  }

  /**
   * 消息统计：今日 / 本月 / 累计，以及最近 7 天趋势。
   * key 结构见 Yunzai lib/plugins/loader.js 的 countMsg。
   */
  async getMsgStat(days = 7) {
    const day = moment().format('YYYY:MM:DD')
    const month = moment().format('YYYY:MM')

    const scopes = [day, month, 'total']
    const keys = []
    for (const type of ['receive', 'send']) {
      for (const scope of scopes) {
        keys.push(`Yz:count:${type}:msg:total:${scope}`)
      }
    }

    // 趋势：从今天往前数 days 天
    const trendDays = []
    for (let i = days - 1; i >= 0; i--) {
      const m = moment().subtract(i, 'days')
      trendDays.push({date: m.format('MM-DD'), key: m.format('YYYY:MM:DD')})
    }
    for (const type of ['receive', 'send']) {
      for (const d of trendDays) {
        keys.push(`Yz:count:${type}:msg:total:${d.key}`)
      }
    }

    const values = await this.#mget(keys)
    let i = 0
    const receive = {today: values[i++], month: values[i++], total: values[i++]}
    const send = {today: values[i++], month: values[i++], total: values[i++]}

    const trend = trendDays.map((d, idx) => ({
      date: d.date,
      receive: values[i + idx] ?? 0,
      send: values[i + trendDays.length + idx] ?? 0,
    }))

    return {receive, send, trend}
  }

  /**
   * Bot 账号列表 —— 当前正在运行的所有账号。
   *
   * 两个来源合并：
   *  - `Bot.uin`：TRSS 维护的已登录账号数组，正常情况下就是全部；
   *  - `Bot.bots`：个别适配器只往这里塞对象、没登记进 uin，漏了会看不到。
   *
   * `Bot.bots` 不能直接遍历 —— 它同时挂着 url / logger / _events 这类非账号属性，
   * 甚至有插件往上面挂自己的东西（如 xiaofei_plugin）。真账号的判据是带 adapter，
   * 这也是 TRSS 上报事件时认的字段（见 lib/bot.js 的 adapter_id / adapter_name）。
   *
   * 不用 redis 的计数 key 当名单：那是历史累计，账号停用了也不会消失。
   */
  #isBotAccount(v) {
    return !!v && typeof v === 'object' && !!v.adapter
  }

  async #getBotList() {
    const uins = []
    const push = (v) => {
      const uin = String(v ?? '').trim()
      if (uin && !uins.includes(uin)) uins.push(uin)
    }

    if (Array.isArray(Bot?.uin)) Bot.uin.forEach(push)
    else if (Bot?.uin) push(Bot.uin)

    // 补上只在 bots 里、没进 uin 的账号
    for (const [key, value] of Object.entries(Bot?.bots ?? {})) {
      if (this.#isBotAccount(value)) push(key)
    }

    return uins.map((uin) => {
      const bot = Bot?.bots?.[uin] ?? (String(Bot?.uin) === uin ? Bot : null)
      return {
        uin,
        nickname: typeof bot?.nickname === 'string' ? bot.nickname : '',
        /** 适配器名，多适配器混跑时用来区分账号来源 */
        adapter: typeof bot?.adapter?.name === 'string' ? bot.adapter.name : '',
      }
    })
  }

  /** 各 Bot 账号的今日 / 累计收发量 */
  async getBotStat() {
    const bots = await this.#getBotList()
    if (bots.length === 0) {
      return []
    }
    const day = moment().format('YYYY:MM:DD')
    const keys = []
    for (const {uin} of bots) {
      for (const scope of [day, 'total']) {
        keys.push(`Yz:count:receive:msg:bot:${uin}:${scope}`)
        keys.push(`Yz:count:send:msg:bot:${uin}:${scope}`)
      }
    }

    const values = await this.#mget(keys)
    return bots.map((bot, idx) => {
      const at = idx * 4
      return {
        uin: bot.uin,
        nickname: bot.nickname,
        adapter: bot.adapter,
        today: {receive: values[at], send: values[at + 1]},
        total: {receive: values[at + 2], send: values[at + 3]},
      }
    })
  }
}
