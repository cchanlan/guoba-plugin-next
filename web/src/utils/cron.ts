/**
 * 极简 Cron 表达式解释器（中文）。
 *
 * Yunzai 使用 node-schedule，接受 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），
 * 并允许 `?` 作为「不指定」的占位符。
 *
 * 这里只覆盖常见写法（具体值、*、*\/n、逗号枚举、区间），
 * 解析不了就返回空串——宁可不解释，也不给出误导性的描述。
 */

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

interface CronParts {
  second?: string
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

export function parseCron(expr: string): CronParts | null {
  const segments = expr?.trim().split(/\s+/) ?? []
  if (segments.length === 5) {
    return {
      minute: segments[0],
      hour: segments[1],
      dayOfMonth: segments[2],
      month: segments[3],
      dayOfWeek: segments[4],
    }
  }
  if (segments.length === 6) {
    return {
      second: segments[0],
      minute: segments[1],
      hour: segments[2],
      dayOfMonth: segments[3],
      month: segments[4],
      dayOfWeek: segments[5],
    }
  }
  return null
}

/** 字段是否为「任意值」 */
function isAny(field: string): boolean {
  return field === '*' || field === '?'
}

/** 只支持纯数字，其他写法（如 1-5/2）交给上层判定为无法解释 */
function asNumber(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null
}

/** 描述「每 n 个单位」或枚举、区间 */
function describeField(field: string, unit: string): string | null {
  if (isAny(field)) return null

  const step = /^\*\/(\d+)$/.exec(field)
  if (step) return `每 ${step[1]} ${unit}`

  if (/^\d+(,\d+)+$/.test(field)) return `第 ${field.split(',').join('、')} ${unit}`

  const range = /^(\d+)-(\d+)$/.exec(field)
  if (range) return `${range[1]} 到 ${range[2]} ${unit}`

  return null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 生成中文描述，无法可靠解释时返回空串。
 */
export function explainCron(expr: string): string {
  const parts = parseCron(expr)
  if (!parts) return ''

  const { second, minute, hour, dayOfMonth, month, dayOfWeek } = parts

  // 时间点部分：要求时、分（及秒）都是具体数字才拼成 HH:mm
  const h = asNumber(hour)
  const m = asNumber(minute)
  const s = second === undefined ? 0 : asNumber(second)

  const timeText = (() => {
    if (h != null && m != null && s != null) {
      return s === 0 ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
    }
    return null
  })()

  // 多个具体时刻：如 0 0 8,20 * * ? → 08:00、20:00
  const hourList = /^\d+(,\d+)+$/.test(hour) ? hour.split(',').map(Number) : null

  const timesText =
    hourList && m != null && s != null
      ? hourList.map((hh) => (s === 0 ? `${pad(hh)}:${pad(m)}` : `${pad(hh)}:${pad(m)}:${pad(s)}`)).join('、')
      : null

  // 频率部分：没有确定时间点时，描述成「每 n 分钟」「每小时第 n 分钟」这类
  let freqText = ''

  if (timeText == null && timesText == null) {
    const secStep = second !== undefined ? describeField(second, '秒') : null
    const minStep = describeField(minute, '分钟')
    const hourStep = describeField(hour, '小时')

    if (isAny(hour)) {
      if (isAny(minute)) {
        // 时、分都不限
        freqText = secStep ?? '每分钟'
      } else if (minStep) {
        freqText = minStep
      } else if (m != null) {
        // 分钟固定、小时不限
        freqText = m === 0 ? '每小时整点' : `每小时第 ${m} 分钟`
      }
    } else if (hourStep) {
      // 每 n 小时
      if (m == null) freqText = hourStep
      else freqText = m === 0 ? `${hourStep}整点` : `${hourStep}（第 ${m} 分钟）`
    } else if (h != null && isAny(minute)) {
      freqText = `${pad(h)} 点每分钟`
    } else if (h != null && minStep) {
      freqText = `${pad(h)} 点${minStep}`
    }

    if (!freqText) return ''
  }

  // 日期范围部分
  const scopePieces: string[] = []

  if (!isAny(dayOfWeek)) {
    const dow = asNumber(dayOfWeek)
    if (dow != null && dow >= 0 && dow <= 7) {
      scopePieces.push(`每${WEEK_NAMES[dow % 7]}`)
    } else if (/^\d+(,\d+)+$/.test(dayOfWeek)) {
      const names = dayOfWeek
        .split(',')
        .map((d) => WEEK_NAMES[Number(d) % 7])
        .filter(Boolean)
      if (names.length) scopePieces.push(`每${names.join('、')}`)
      else return ''
    } else {
      const desc = describeField(dayOfWeek, '天（按周）')
      if (desc) scopePieces.push(desc)
      else return ''
    }
  } else if (!isAny(dayOfMonth)) {
    const dom = asNumber(dayOfMonth)
    if (dom != null) scopePieces.push(`每月 ${dom} 号`)
    else {
      const desc = describeField(dayOfMonth, '天')
      if (desc) scopePieces.push(desc)
      else return ''
    }
  }

  if (!isAny(month)) {
    const mo = asNumber(month)
    if (mo != null) scopePieces.push(`${mo} 月`)
    else {
      const desc = describeField(month, '月')
      if (desc) scopePieces.push(desc)
      else return ''
    }
  }

  // 组装
  const scope = scopePieces.length ? scopePieces.join('、') : '每天'

  if (timeText != null) return `${scope} ${timeText}`
  if (timesText != null) return `${scope} ${timesText}`
  // 范围本就是「每天」时，不必再加前缀，直接说频率
  return scope === '每天' ? freqText : `${scope}，${freqText}`
}
