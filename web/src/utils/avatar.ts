/**
 * 头像地址。
 *
 * 后端已按适配器算好一份（server/service/both/model/avatar.js，好友列表、会话、
 * 消息发送者上的 avatar 字段），能用就直接用；这里是它缺席时的本地兜底。
 *
 * QQ 号能直接拼腾讯的公开地址；QQBot（QQ 官方机器人）适配器给的是 openid，
 * 那套地址取不到人，官方另给了一组按 appid + openid 拼的：
 *   https://q.qlogo.cn/qqapp/{appid}/{openid}/0
 * appid 不等于 botId —— 有的 fork 用机器人 QQ 号当 self_id，appid 得从在线账号表里查。
 */

/** openid 是 32 位十六进制串 */
const OPENID_RE = /^[0-9a-f]{32}$/i
/** QQ 号 / 群号：够长的纯数字。stdin 这类假账号不满足，也就没有头像 */
const NUMERIC_RE = /^\d{5,}$/

export interface AvatarOptions {
  /** 后端算好的地址，有就直接用 */
  avatar?: string
  /** QQBot 的 appid，取在线账号表里该 uin 的 appId */
  appId?: string
  /** 适配器名，取 /chat/status 里的 bots[].adapter */
  adapter?: string
}

/** 适配器名里带 qqbot 就按官方机器人算（QQBot、QQBot-Web-Adapter 等都算） */
export function isQQBot(adapter?: string) {
  return /qqbot/i.test(String(adapter ?? ''))
}

/**
 * 取 id 里真正标识人的那一段。
 *
 * QQBot 适配器的好友 / 群 id 是 `${self_id}:${openid}` 这种带账号前缀的复合形式，
 * 前缀不属于头像地址 —— 整串拿去拼 QQ 那套只会取回机器人自己那张图。
 */
function tailId(id?: string | number) {
  const s = String(id ?? '').trim()
  const i = s.lastIndexOf(':')
  return i === -1 ? s : s.slice(i + 1)
}

/** 后端给的地址，能直接用的才算 */
function given(avatar?: string) {
  const url = String(avatar ?? '').trim()
  return /^https?:\/\//i.test(url) ? url : ''
}

/**
 * 用户头像。
 *
 * openid 拿去问 QQ 那套地址必然取不到人，所以只要 id 长得像 openid 就按官方机器人拼 ——
 * 适配器名各家 fork 不一样（QQBot / qq-group-bot / …），不能只认名字。
 * 拼不出来的（没 appid、stdin 这类非数字 id）返回空串，模板退回首字兜底。
 */
export function userAvatar(
  userId?: string | number,
  {avatar, appId, adapter}: AvatarOptions = {},
) {
  const hit = given(avatar)
  if (hit) return hit
  const uid = tailId(userId)
  if (!uid) return ''
  if (OPENID_RE.test(uid)) {
    const app = String(appId ?? '').trim()
    return app ? `https://q.qlogo.cn/qqapp/${encodeURIComponent(app)}/${uid}/0` : ''
  }
  if (isQQBot(adapter) || !NUMERIC_RE.test(uid)) return ''
  return `https://q.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uid)}&s=100`
}

/** 群头像。QQBot 的群 openid 官方没给对应地址，返回空串走兜底 */
export function groupAvatar(groupId?: string | number, {avatar, adapter}: AvatarOptions = {}) {
  const hit = given(avatar)
  if (hit) return hit
  const gid = tailId(groupId)
  if (!gid || isQQBot(adapter) || !NUMERIC_RE.test(gid)) return ''
  return `https://p.qlogo.cn/gh/${gid}/${gid}/100`
}
