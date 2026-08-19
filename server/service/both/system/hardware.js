import os from 'node:os'

/**
 * 硬件指标采集。
 *
 * `os` 模块只给得出核心数、内存总量、负载这几样，Windows 上连负载都是恒 0。想要 CPU 型号 /
 * 内存频率 / SWAP / 显卡占用 / 温度，就得问系统要 —— 各平台的问法完全不同（Windows 是
 * PowerShell + WMI/CIM，Linux 读 /proc 和 /sys，macOS 靠 sysctl）。这些都封在
 * `systeminformation` 里了，椰奶插件的状态页也是用它，本机实测数据齐全。
 *
 * **它是可选依赖**：拿不到就整块降级成 `os` 的基础数据（少几项，不报错、不影响首页其余部分）。
 * 老用户不跑 `pnpm install` 也不该看到一个白屏。
 */

/** si 的静态信息（CPU 型号、内存条频率）只在启动时问一次 —— 它们不会变，而每次都查很慢 */
let staticInfo = null
/** si 模块本身；null 表示还没试过加载，false 表示装不上 */
let si

/**
 * 显卡有没有占用数据。
 *
 * 独显（NVIDIA 走 nvidia-smi、AMD 走 rocm-smi）才给得出占用和显存；核显只有型号，
 * 拿它画一个恒为 0 的环没意义。判定一次就够，插拔显卡得重启 Bot。
 */
let hasGpuMetrics = null

async function loadSi() {
  if (si !== undefined) return si
  try {
    si = (await import('systeminformation')).default
  } catch {
    si = false
  }
  return si
}

/** 有没有 si 可用。首页据此决定要不要显示扩展项 */
export async function siAvailable() {
  return !!(await loadSi())
}

/** 启动时预热静态信息，别让第一次打开首页等在这儿 */
export async function warmup() {
  const lib = await loadSi()
  if (!lib) return
  try {
    const [cpu, memLayout] = await Promise.all([lib.cpu(), lib.memLayout()])
    staticInfo = {
      manufacturer: cpu?.manufacturer?.split(' ')?.[0] ?? '',
      brand: cpu?.brand ?? '',
      // si 给的是 GHz
      speed: Number(cpu?.speed) || 0,
      cores: Number(cpu?.cores) || 0,
      physicalCores: Number(cpu?.physicalCores) || 0,
      // 内存条频率，混插时取第一条
      memClock: Number(memLayout?.find((m) => m?.clockSpeed)?.clockSpeed) || 0,
      memType: memLayout?.find((m) => m?.type)?.type ?? '',
    }
  } catch (err) {
    logger.debug?.(`[Guoba] 读取硬件静态信息失败：${err.message}`)
  }
}

/**
 * CPU / 内存 / SWAP。
 *
 * 内存用的是 `active` 而不是 `used`：Linux 的 used 把 buff/cache 算进去了，一台闲着的机器
 * 也能显示 95%，跟 `free -h` 对不上。`active` 才是进程真正占着的。Windows 上两者一致。
 */
async function readCore(lib) {
  const {currentLoad, mem} = await lib.get({
    currentLoad: 'currentLoad',
    mem: 'total,used,active,available,buffcache,swaptotal,swapused,swapfree',
  })
  const out = {}

  if (typeof currentLoad?.currentLoad === 'number') {
    out.cpuPercent = Math.min(100, Math.max(0, currentLoad.currentLoad))
  }

  if (mem?.total) {
    const used = Number(mem.active) || Number(mem.used) || 0
    out.memory = {
      total: Number(mem.total),
      used,
      percent: (used / Number(mem.total)) * 100,
      buffcache: Number(mem.buffcache) || 0,
    }
    // 没开 swap 的机器 swaptotal 是 0，此时不给这一项，前端也就不画那个环
    if (Number(mem.swaptotal) > 0) {
      out.swap = {
        total: Number(mem.swaptotal),
        used: Number(mem.swapused) || 0,
        free: Number(mem.swapfree) || 0,
        percent: ((Number(mem.swapused) || 0) / Number(mem.swaptotal)) * 100,
      }
    }
  }
  return out
}

/** 显卡：型号、占用、显存、温度 */
async function readGpu(lib) {
  if (hasGpuMetrics === false) return null
  const {controllers} = await lib.graphics()
  const card = controllers?.find((it) => it?.utilizationGpu != null && it?.memoryTotal)
  if (!card) {
    hasGpuMetrics = false
    // 核显也值得报个型号出来，占用留空
    const any = controllers?.find((it) => it?.model)
    return any ? {model: any.model, vendor: any.vendor ?? '', percent: null} : null
  }
  hasGpuMetrics = true
  return {
    model: card.model ?? '',
    vendor: card.vendor ?? '',
    percent: Math.min(100, Math.max(0, Number(card.utilizationGpu) || 0)),
    // si 的显存单位是 MiB
    memUsed: (Number(card.memoryUsed) || 0) * 1024 * 1024,
    memTotal: (Number(card.memoryTotal) || 0) * 1024 * 1024,
    temp: Number(card.temperatureGpu) || 0,
  }
}

/** CPU 温度。虚拟机和不少云主机读不到，返回 0 表示没有 */
async function readCpuTemp(lib) {
  try {
    const t = await lib.cpuTemperature()
    return Number(t?.main) > 0 ? Number(t.main) : 0
  } catch {
    return 0
  }
}

/** 内存盘 / 容器叠加层 / 只读镜像，这些混进来会把容量算歪 */
const IGNORE_FS = /^(udev|tmpfs|devtmpfs|overlay|overlay2|squashfs|shm|none|ramfs|fuse\.\w+)$/i

/**
 * 磁盘列表缓存多久。
 *
 * 首页每 5 秒轮询一次，而 Windows 上 `si.fsSize()` 要起一个 PowerShell 进程 —— 每 5 秒起一次
 * 纯属浪费。容量又不是实时数据，缓一会儿完全够用。
 */
const DISK_TTL = 30 * 1000
let diskCache = {at: 0, list: []}

/**
 * 所有磁盘。
 *
 * 过滤掉内存盘和容器叠加层：`overlay` / `tmpfs` / `squashfs` 这些要么是同一块盘算两次
 * （Docker 的 overlay2 挂载点跟 `/` 同容量），要么根本不是磁盘。Windows 上是干净的盘符列表。
 */
async function readDisks(lib) {
  const now = Date.now()
  if (diskCache.list.length && now - diskCache.at < DISK_TTL) return diskCache.list
  const list = await lib.fsSize()
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const it of list) {
    const size = Number(it?.size) || 0
    const used = Number(it?.used) || 0
    if (!size || IGNORE_FS.test(it?.type ?? '') || IGNORE_FS.test(it?.fs ?? '')) continue
    // 同一块盘可能挂在多处（bind mount / docker），按「容量+已用」去重
    const sig = `${size}:${used}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push({
      name: it.mount || it.fs || '',
      fs: it.type ?? '',
      total: size,
      used,
      free: Math.max(0, size - used),
      percent: typeof it.use === 'number' ? it.use : (used / size) * 100,
    })
  }
  diskCache = {at: now, list: out}
  return out
}

/**
 * 采集一次扩展指标。si 不可用时返回 null，调用方退回 `os` 的基础数据。
 *
 * @return {Promise<object|null>}
 */
export async function collect() {
  const lib = await loadSi()
  if (!lib) return null
  if (!staticInfo) await warmup()

  // 一项失败不该拖垮整块：各自 catch，缺的字段前端会自己隐藏
  const [core, gpu, cpuTemp, disks] = await Promise.all([
    readCore(lib).catch((err) => {
      logger.debug?.(`[Guoba] 读取 CPU / 内存失败：${err.message}`)
      return {}
    }),
    readGpu(lib).catch(() => null),
    readCpuTemp(lib),
    readDisks(lib).catch((err) => {
      logger.debug?.(`[Guoba] 读取磁盘失败：${err.message}`)
      return []
    }),
  ])

  return {
    cpu: {
      percent: core.cpuPercent,
      model: staticInfo?.brand || os.cpus()[0]?.model?.trim() || '',
      manufacturer: staticInfo?.manufacturer ?? '',
      cores: staticInfo?.cores || os.cpus().length,
      physicalCores: staticInfo?.physicalCores ?? 0,
      speed: staticInfo?.speed ?? 0,
      temp: cpuTemp,
    },
    memory: core.memory,
    swap: core.swap,
    memClock: staticInfo?.memClock ?? 0,
    memType: staticInfo?.memType ?? '',
    gpu,
    disks,
  }
}
