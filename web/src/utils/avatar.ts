/**
 * 头像地址。
 *
 * QQ 号能直接拼腾讯的公开地址；QQBot（QQ 官方机器人）适配器给的是 openid，
 * 那套地址取不到人，官方另给了一组按 appid + openid 拼的：
 *   https://q.qlogo.cn/qqapp/{appid}/{openid}/0
 * appid 就是消息里的 botId（事件的 self_id）。
 */

/** openid 是 32 位十六进制串 */
const OPENID_RE = /^[0-9a-f]{32}$/i

export interface AvatarOptions {
  /** QQBot 的 appid，取消息 / 会话的 botId */
  appId?: string
  /** 适配器名，取 /chat/status 里的 bots[].adapter */
  adapter?: string
}

/** 适配器名里带 qqbot 就按官方机器人算（QQBot、QQBot-Web-Adapter 等都算） */
export function isQQBot(adapter?: string) {
  return /qqbot/i.test(String(adapter ?? ''))
}

/**
 * 用户头像。
 *
 * openid 拿去问 QQ 那套地址必然取不到人，所以只要 id 长得像 openid 就按官方机器人拼 ——
 * 适配器名各家 fork 不一样（QQBot / qq-group-bot / …），不能只认名字。
 * QQBot 下 id 又不是 openid 的（机器人自己那条给的是 appid）没有公开地址，返回空串走兜底。
 */
export function userAvatar(userId: string, {appId, adapter}: AvatarOptions = {}) {
  const uid = String(userId ?? '').trim()
  if (!uid) return ''
  const app = String(appId ?? '').trim()
  if (OPENID_RE.test(uid)) {
    return app ? `https://q.qlogo.cn/qqapp/${encodeURIComponent(app)}/${uid}/0` : ''
  }
  if (isQQBot(adapter)) return ''
  return `https://q.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uid)}&s=100`
}

/** 群头像。QQBot 的群 openid 没有对应的公开地址，返回空串走兜底 */
export function groupAvatar(groupId: string, {adapter}: AvatarOptions = {}) {
  const gid = String(groupId ?? '').trim()
  if (!gid || isQQBot(adapter) || OPENID_RE.test(gid)) return ''
  return `https://p.qlogo.cn/gh/${gid}/${gid}/100`
}
