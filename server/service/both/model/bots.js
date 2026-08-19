/**
 * 在线账号枚举 + 好友 / 群缓存的兜底加载。
 *
 * 沙盒与消息记录都要让用户选「用哪个号」，判据得一致，所以放在一处。
 */

import {botAppId} from './avatar.js'

/**
 * 拉到了、但列表确实是空的，隔多久再试。
 *
 * 真的一个好友都没有的账号（新号、只进群不加好友的号）会一直走到重试分支，别让它每次
 * 刷新页面都去请求一遍协议端。
 */
const RELOAD_TTL = 60 * 1000
/**
 * 请求失败时隔多久再试。
 *
 * 比上面短得多 —— 失败最常见的原因是协议端还在启动（QQ 刚拉起来，好友列表没就绪），
 * 这种过几秒就好了。要是也压 60 秒，用户盯着空列表刷新半天都没反应。
 */
const RETRY_TTL = 10 * 1000
/** `${uin}:${kind}` -> 下次允许尝试的时刻 */
const nextTry = new Map()
/** `${uin}:${kind}` -> 进行中的请求，多个页面同时刷新时共用一次 */
const pending = new Map()

/**
 * 缓存看起来是空的吗。
 *
 * 不能只判 `size === 0`：`pickFriend` 到某个号会把它写进 `fl`（见适配器的 `getFriendInfo`），
 * 而面板自己就会 pick 机器人账号，于是列表里常常只剩机器人自己一条 —— 实测 LLOneBot 上
 * 「好友数量 1」就是这么来的，那一条正是机器人本人。
 */
function looksEmpty(cache, uin) {
  if (!cache || typeof cache.size !== 'number') return true
  if (cache.size === 0) return true
  if (cache.size > 1) return false
  // fl 的 key 是 user_id（数字），gl 是 group_id，两种类型都试一下
  return cache.has(Number(uin)) || cache.has(String(uin))
}

/** 各家实现里，好友 / 群号可能叫的名字 */
const FRIEND_ID_KEYS = ['user_id', 'uin', 'qq', 'id']
const GROUP_ID_KEYS = ['group_id', 'gid', 'id']
/** 列表可能直接是数组，也可能包在这些字段下 */
const LIST_WRAP_KEYS = ['friends', 'groups', 'list', 'data']
/** 兜底也失败时，只警告一次，别每次刷新都刷一行 */
const warned = new Set()

/**
 * 自己调一次 OneBot 的标准接口，把列表合并进缓存。
 *
 * 适配器那套（`plugins/adapter/OneBotv11.js` 的 `getFriendMap`）有两个前提：返回的一定是
 * 数组、每项的号码一定叫 `user_id`。任一条不成立就会拿到一个空 Map，而它是
 * `data.bot.fl = map` **整体替换** —— 连之前 `getFriendInfo` 写进去的条目都一起清掉，
 * 于是页面上就只剩机器人自己（面板 pick 过它，那是替换之后才写回去的）。
 *
 * 所以这里自己来一遍：字段名多认几个，写入用**合并**而不是替换。
 *
 * @return {Promise<number>} 新写进缓存的条数
 */
async function loadViaApi(bot, isGroup) {
  if (typeof bot?.sendApi !== 'function') return 0
  const res = await bot.sendApi(isGroup ? 'get_group_list' : 'get_friend_list')
  // sendApi 回来的是个 Proxy，data 里的字段直接取得到
  const raw = res?.data ?? res
  let arr = raw
  if (!Array.isArray(arr)) {
    arr = LIST_WRAP_KEYS.map((k) => raw?.[k]).find(Array.isArray) ?? []
  }
  if (!arr.length) return 0

  const cache = isGroup ? bot.gl : bot.fl
  if (!(cache instanceof Map)) return 0
  const idKeys = isGroup ? GROUP_ID_KEYS : FRIEND_ID_KEYS
  const idField = isGroup ? 'group_id' : 'user_id'
  let added = 0
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const found = idKeys.map((k) => it[k]).find((v) => v != null && v !== '')
    if (found == null) continue
    // 缓存的 key 用数字，跟适配器和 lib/bot.js 的取法保持一致
    const key = Number(found) || found
    if (!cache.has(key)) added++
    // 补齐标准字段名，前端和 lib/bot.js 都按它取
    cache.set(key, {...it, [idField]: key})
  }
  return added
}

/**
 * 确保好友 / 群列表已经加载过。
 *
 * `Bot.getFriendMap()`（lib/bot.js）只是把各账号的 `bot.fl` 合并起来读，**不会主动请求**；
 * 真正去问协议端的是适配器挂在账号上的同名方法 `bot.getFriendMap()`，而适配器只在连接时
 * 调了一次，既没 await 也没 catch（见 plugins/adapter/OneBotv11.js 的 `data.bot.getFriendMap()`）。
 * 那一次要是失败了或还没跑完 —— QQ 刚启动、协议端还没就绪时很常见 —— `bot.fl` 就一直是
 * 初始化时那个空 Map，面板上于是「好友 0 个」「私聊列表只有机器人自己」。
 *
 * 两级兜底：先让适配器重新拉一遍（它会回填 `bot.fl` / `bot.gl`），还是空就自己调标准接口，
 * 见 {@link loadViaApi}。
 *
 * @param {'friend'|'group'} kind
 * @param {string} [botId] 只管这一个账号，缺省管所有在线账号
 */
export async function ensureContacts(kind = 'friend', botId = '') {
  const isGroup = kind === 'group'
  const wanted = String(botId ?? '').trim()
  const uins = wanted ? [wanted] : listBots().map((it) => it.uin)

  await Promise.all(uins.map(async (uin) => {
    // 这是尽力而为的兜底，本身出任何岔子都不该让「读列表」失败
    try {
      const bot = Bot?.bots?.[uin]
      if (!bot) return
      if (!looksEmpty(isGroup ? bot.gl : bot.fl, uin)) return

      const key = `${uin}:${kind}`
      if (pending.has(key)) return pending.get(key)
      if (Date.now() < (nextTry.get(key) ?? 0)) return

      // 账号级的那个才会真的请求协议端；全局 Bot 上的同名方法只读缓存
      const load = isGroup ? bot.getGroupMap : bot.getFriendMap
      const name = isGroup ? '群' : '好友'
      const api = isGroup ? 'get_group_list' : 'get_friend_list'

      // 先占住，别让同一时刻涌进来的请求各发一遍（pending 要等下面 task 建好才生效）
      nextTry.set(key, Date.now() + RELOAD_TTL)
      const task = (async () => {
        try {
          /** 有任何一层是「抛错」而不是「干净地返回空」—— 多半是协议端还没就绪，值得早点重试 */
          let failed = false
          if (typeof load === 'function') {
            try {
              await load.call(bot)
            } catch (err) {
              // 适配器认死 user_id 字段、返回的不是数组就会在这儿炸，下面还有一层兜底
              failed = true
              logger?.debug?.(`[Guoba] 适配器拉取${name}列表失败（${uin}）：${err?.message ?? err}`)
            }
          }
          // 适配器那套拿到空数组还会把缓存整个替换掉，所以拉完得再看一眼
          if (!looksEmpty(isGroup ? bot.gl : bot.fl, uin)) return

          let added = 0
          try {
            added = await loadViaApi(bot, isGroup)
          } catch (err) {
            failed = true
            logger?.debug?.(`[Guoba] 直接调 ${api} 失败（${uin}）：${err?.message ?? err}`)
          }

          if (added) {
            // 说清是谁救回来的，不然用户只觉得「时好时坏」
            logger?.mark?.(`[Guoba] 适配器没拉到${name}列表，已自行取回 ${added} 个（${uin}）`)
            return
          }
          // 报错过就早点再试；干净地返回了空（新号、只进群不加好友）就按长间隔来
          if (failed) nextTry.set(key, Date.now() + RETRY_TTL)
          if (!warned.has(key)) {
            // 只提醒一次：面板每次刷新都会走到这儿
            warned.add(key)
            logger?.warn?.(`[Guoba] 取不到${name}列表（${uin}）：协议端的 ${api} 没有返回可用数据，`
              + '面板上这一项会是空的')
          }
        } catch (err) {
          // 顺序要紧：先放开重试窗口再打日志。日志本身要是出了岔子（logger 还没就位之类），
          // 重试时机不能跟着一起丢 —— 那会让这个账号在整个长间隔里都不再尝试
          nextTry.set(key, Date.now() + RETRY_TTL)
          logger?.debug?.(`[Guoba] 重新拉取${name}列表失败（${uin}）：${err?.message ?? err}`)
        }
      })()
      pending.set(key, task)
      /**
       * 清理挂在 `.finally` 上，不能写进上面那个 try 的 finally 块里。
       *
       * async 函数体在遇到第一个 await 之前是**同步**跑的：`load` 要是同步抛错（参数校验之类），
       * try/catch/finally 会在 `pending.set` 之前就跑完，那句 delete 删的是还不存在的 key ——
       * 于是 key 永久留在 pending 里，这个账号再也不会重试。`.finally` 的回调走微任务，
       * 一定晚于同步的 set。
       */
      task.finally(() => pending.delete(key))
      return task
    } catch (err) {
      logger?.debug?.(`[Guoba] 兜底加载联系人出错（${uin}）：${err?.message ?? err}`)
    }
  }))
}

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
      /**
       * QQBot 的 appid，前端拼 openid 头像要用。
       * 不等于 uin —— 有的 fork 用机器人 QQ 号当 self_id，appid 只在 Bot 实例上。
       */
      appId: botAppId(uin),
    }
  })
}
