/**
 * 头像地址。
 *
 * QQ 号能直接拼腾讯的公开地址；QQBot（QQ 官方机器人）适配器给的是 openid，
 * 那套地址取不到人，官方另给了一组按 appid + openid 拼的：
 *   https://q.qlogo.cn/qqapp/{appid}/{openid}/0
 * appid 只有 Bot 实例上有（`Bot[uin].info.appid`）—— 各 fork 的 self_id 有的是 appid、
 * 有的是机器人 QQ 号，光看 id 猜不出来，所以地址在后端算好再给前端。
 */

/** openid 是 32 位十六进制串 */
const OPENID_RE = /^[0-9a-f]{32}$/i
/** QQ 号 / 群号：够长的纯数字。stdin 这类假账号不满足，也就没有头像 */
const NUMERIC_RE = /^\d{5,}$/

/**
 * 取 id 里真正标识人的那一段。
 *
 * QQBot 适配器的好友 / 群 id 是 `${self_id}:${openid}` 这种带账号前缀的复合形式，
 * 前缀不属于头像地址，整串拿去拼只会取回机器人自己那张图。
 */
export function tailId(id) {
  const s = String(id ?? '').trim()
  const i = s.lastIndexOf(':')
  return i === -1 ? s : s.slice(i + 1)
}

/** 账号的 QQBot appid，非官方机器人没有这东西 */
export function botAppId(botId) {
  const uin = String(botId ?? '').trim()
  if (!uin) return ''
  const bot = Bot?.bots?.[uin] ?? Bot?.bots?.[Number(uin)]
  const appid = bot?.info?.appid ?? bot?.appid
  return appid ? String(appid) : ''
}

/** 适配器给的头像地址，能直接用的才算 */
function pickGiven(avatar) {
  const url = String(avatar ?? '').trim()
  return /^https?:\/\//i.test(url) ? url : ''
}

/**
 * 用户头像。
 *
 * 优先用适配器自己给的（QQBot 的好友表里就存着现成的地址），
 * 缺了再按 id 的样子算：openid 配 appid 拼官方那套，纯数字按 QQ 号拼，
 * 其余（stdin 之类）没有公开地址，返回空串让前端退回首字兜底。
 *
 * @param userId 好友 id，可能是 `${self_id}:${openid}` 复合形式
 * @param botId  该好友属于哪个账号，取 appid 用
 * @param given  适配器已给出的头像地址
 */
export function userAvatarUrl(userId, botId, given) {
  const hit = pickGiven(given)
  if (hit) return hit
  const uid = tailId(userId)
  if (!uid) return ''
  if (OPENID_RE.test(uid)) {
    const app = botAppId(botId)
    return app ? `https://q.qlogo.cn/qqapp/${encodeURIComponent(app)}/${uid}/0` : ''
  }
  if (!NUMERIC_RE.test(uid)) return ''
  return `https://q1.qlogo.cn/g?b=qq&s=100&nk=${uid}`
}

/**
 * 机器人自己的头像。
 *
 * 优先用适配器自带的 `bot.avatar`（OneBotv11、OPQBot、ComWeChat 都有这个 getter）——
 * 只有它知道自己的 id 到底是 QQ 号还是别的什么。拿不到就按 uin 的样子算：
 * 纯数字按 QQ 号拼，其余（stdin、官方机器人那种字面 id）没有公开地址，
 * 返回空串让前端退回首字兜底。
 *
 * 别图省事去读全局 `Bot.avatar`：TRSS 的 Proxy 会把自身没有的属性重定向到**随机**一个
 * 在线账号（见 lib/bot.js 里 uin.toJSON 的随机 + 60 秒缓存），多账号时头像会和昵称
 * 来自不同的号，还会隔一会儿自己变一次。
 */
export function botAvatarUrl(botId) {
  const uin = String(botId ?? '').trim()
  if (!uin) return ''
  const bot = Bot?.bots?.[uin] ?? Bot?.bots?.[Number(uin)]
  let given = ''
  try {
    // avatar 多半是 getter，账号信息还没就绪时个别实现会抛
    given = pickGiven(bot?.avatar)
  } catch {
    given = ''
  }
  // info 没填好时会拼出 nk=undefined 这种能过 http 校验但取不到图的地址
  if (given && !/undefined|null/i.test(given)) return given
  if (!NUMERIC_RE.test(uin)) return ''
  return `https://q1.qlogo.cn/g?b=qq&s=100&nk=${uin}`
}

/** 群头像。QQBot 的群 openid 官方没给对应地址，只能空串走兜底 */
export function groupAvatarUrl(groupId, given) {
  const hit = pickGiven(given)
  if (hit) return hit
  const gid = tailId(groupId)
  if (!gid || !NUMERIC_RE.test(gid)) return ''
  return `https://p.qlogo.cn/gh/${gid}/${gid}/100`
}
