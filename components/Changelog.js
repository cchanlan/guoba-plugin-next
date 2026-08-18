import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'

const COMPONENT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CHANGELOG_PATH = path.join(COMPONENT_DIR, '../CHANGELOG.md')

function cleanText(value = '') {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDate(value = '') {
  const match = value.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/)
  if (!match) return ''
  return match[2] ? `${match[1]} ${match[2]}` : match[1]
}

/**
 * 解析锅巴更新日志。每一个列表项都是一条可发送的更新记录，
 * 标题中的日期会自动作为没有独立日期条目的列表项的日期。
 */
export function parseChangelog(markdown = '') {
  const items = []
  let section = ''
  let current = null

  for (const rawLine of String(markdown).replace(/\r/g, '').split('\n')) {
    const line = rawLine.replace(/\t/g, '  ')
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = cleanText(heading[1])
      continue
    }

    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)
    if (!bullet) continue

    const text = cleanText(bullet[1])
    if (!text) continue
    const explicitDate = parseDate(text)
    current = {
      date: explicitDate || parseDate(section),
      version: explicitDate ? '' : (/^(?:v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)$/.test(section) ? section : ''),
      message: text.replace(/^\[?\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?\]?\s*/, ''),
    }
    items.push(current)
  }

  return items
}

/** 按需读取日志，确保 git 更新后不会被 ESM 模块缓存旧内容。 */
export function loadChangelog() {
  try {
    if (!fs.existsSync(CHANGELOG_PATH)) return []
    return parseChangelog(fs.readFileSync(CHANGELOG_PATH, 'utf8'))
  } catch (error) {
    if (typeof logger !== 'undefined' && logger.error) {
      logger.error('[Guoba] 读取更新日志失败：', error)
    }
    return []
  }
}

/** 将 git log --format="%aI%x09%s" 转成统一的更新记录。 */
export function parseGitLog(raw = '') {
  return String(raw).split(/\r?\n/).filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    const dateRaw = tab === -1 ? '' : line.slice(0, tab)
    const message = cleanText(tab === -1 ? line : line.slice(tab + 1))
    const date = dateRaw
      ? dateRaw.replace('T', ' ').replace(/([+-]\d{2}:\d{2}|Z)$/, '').slice(0, 19)
      : ''
    return {date, version: '', message}
  }).filter(item => item.message)
}

export {CHANGELOG_PATH, cleanText}
