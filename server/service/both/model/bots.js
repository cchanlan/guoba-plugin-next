/**
 * 在线账号枚举。
 *
 * 沙盒与消息记录都要让用户选「用哪个号」，判据得一致，所以放在一处。
 */

/**
 * 可用账号列表。
 *
 * 判据与 StatusService 一致：`Bot.bots` 上挂着 logger、_events 这类非账号属性，
 * 甚至有插件往上塞自己的东西，只有带 adapter 的才是真账号。
 */
export function listBots() {
  const uins = []
  const push = (v) => {
    const uin = String(v ?? '').trim()
    if (uin && !uins.includes(uin)) uins.push(uin)
  }

  if (Array.isArray(Bot?.uin)) Bot.uin.forEach(push)
  else if (Bot?.uin) push(Bot.uin)

  for (const [key, value] of Object.entries(Bot?.bots ?? {})) {
    if (value && typeof value === 'object' && value.adapter) push(key)
  }

  return uins.map((uin) => {
    const bot = Bot?.bots?.[uin]
    return {
      uin,
      nickname: typeof bot?.nickname === 'string' ? bot.nickname : '',
      adapter: typeof bot?.adapter?.name === 'string' ? bot.adapter.name : '',
    }
  })
}
