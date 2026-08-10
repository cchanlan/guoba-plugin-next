/**
 * 展示用格式化。
 *
 * 首页状态卡与消息统计共用，都是给人看的近似值，
 * 不追求精确到字节/秒。
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** 字节 → 带单位字符串，如 `7.67 GB`。按 1024 进制 */
export function formatBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < BYTE_UNITS.length - 1) {
    value /= 1024
    idx++
  }
  // B 没有小数意义
  return `${value.toFixed(idx === 0 ? 0 : digits)} ${BYTE_UNITS[idx]}`
}

/** 秒 → `3 天 4 小时`，只保留最大的两级，不足 1 分钟显示秒 */
export function formatDuration(seconds: number): string {
  const total = Math.floor(Number(seconds) || 0)
  if (total < 60) {
    return `${Math.max(0, total)} 秒`
  }
  const parts: string[] = []
  const units: [number, string][] = [
    [86400, '天'],
    [3600, '小时'],
    [60, '分钟'],
  ]
  let rest = total
  for (const [size, name] of units) {
    const n = Math.floor(rest / size)
    rest %= size
    if (n > 0) {
      parts.push(`${n} ${name}`)
    }
    if (parts.length === 2) {
      break
    }
  }
  return parts.join(' ')
}

/** 大数字加千分位，如 `973,241` */
export function formatNumber(value: number): string {
  return (Number(value) || 0).toLocaleString('en-US')
}

/** 百分比保留两位，不带 % 号 */
export function formatPercent(value: number, digits = 2): string {
  return (Number(value) || 0).toFixed(digits)
}
