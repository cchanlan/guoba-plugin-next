/**
 * 消息记录里的「临时会话」（非好友私聊）。
 *
 * 好友表在 `bot.fl` 里、重启也在；陌生人 / 群临时会话只活在收到的消息里，
 * 不落盘的话重启一次就全没了。这份 JSON 只记最近聊过的人，够列表显示和再次打开。
 *
 * 文件：`data/guoba/chat-temp-sessions.json`
 * ```
 * {
 *   "version": 1,
 *   "sessions": {
 *     "3851152744:friend:123456": {
 *       "botId": "3851152744",
 *       "userId": "123456",
 *       "name": "昵称",
 *       "lastTime": 1793640000,
 *       "lastText": "…",
 *       "groupId": "575663150"
 *     }
 *   }
 * }
 * ```
 * 读失败（文件不在、坏了）从空开始；写失败只记 debug 日志，不影响收消息。
 */

import fs from 'fs'
import path from 'path'
// 同目录的 chatPrefs.js 也走相对路径，这里跟着来，不依赖 #guoba.* 别名
import {_paths} from '../../../../utils/paths.js'

const FILE = path.join(_paths.data, 'guoba', 'chat-temp-sessions.json')
const VERSION = 1
/** 最多记多少个，超了淘汰最久没聊的 */
const MAX_TEMP_SESSIONS = 300
const MAX_NAME = 64
const MAX_PREVIEW = 120

let cache = null

function blank() {
  return {version: VERSION, sessions: {}}
}

function cleanText(text, max) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function asSessions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object') continue
    const k = String(key ?? '').trim()
    const userId = String(item.userId ?? '').trim()
    if (!k || !userId) continue
    out[k] = {
      botId: String(item.botId ?? ''),
      userId,
      name: cleanText(item.name, MAX_NAME) || userId,
      lastTime: Number(item.lastTime) || 0,
      lastText: cleanText(item.lastText, MAX_PREVIEW),
      groupId: String(item.groupId ?? ''),
    }
  }
  return out
}

function load() {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    cache = {version: VERSION, sessions: asSessions(raw?.sessions)}
  } catch {
    cache = blank()
  }
  return cache
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), {recursive: true})
    fs.writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf8')
    return true
  } catch (err) {
    logger?.debug?.(`[Guoba] 保存临时会话失败：${err?.message ?? err}`)
    return false
  }
}

function trim(state) {
  const entries = Object.entries(state.sessions)
  if (entries.length <= MAX_TEMP_SESSIONS) return
  entries.sort((a, b) => (Number(a[1].lastTime) || 0) - (Number(b[1].lastTime) || 0))
  for (const [key] of entries.slice(0, entries.length - MAX_TEMP_SESSIONS)) {
    delete state.sessions[key]
  }
}

/** 记一条临时会话（按 key 覆盖；名字 / 预览缺了沿用旧的） */
export function rememberTempSession({key, botId, userId, name, lastTime, lastText, groupId = ''} = {}) {
  const k = String(key ?? '').trim()
  const uid = String(userId ?? '').trim()
  if (!k || !uid) return false
  const state = load()
  const old = state.sessions[k]
  state.sessions[k] = {
    botId: String(botId ?? ''),
    userId: uid,
    name: cleanText(name, MAX_NAME) || old?.name || uid,
    lastTime: Math.max(Number(lastTime) || 0, Number(old?.lastTime) || 0),
    lastText: cleanText(lastText, MAX_PREVIEW) || old?.lastText || '',
    groupId: String(groupId || old?.groupId || ''),
  }
  trim(state)
  return save()
}

/** 列出全部临时会话（可按账号过滤） */
export function listTempSessions(botId = '') {
  const want = String(botId ?? '').trim()
  return Object.entries(load().sessions)
    .map(([key, item]) => ({key, ...item}))
    .filter((item) => !want || item.botId === want)
}

/** 删掉一条（对方加了机器人好友、或用户主动清掉时用） */
export function forgetTempSession(key) {
  const k = String(key ?? '').trim()
  if (!k) return false
  const state = load()
  if (!state.sessions[k]) return false
  delete state.sessions[k]
  return save()
}
