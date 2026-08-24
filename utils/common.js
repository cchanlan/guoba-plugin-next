import os from 'os'
import fs from 'fs'
import path from 'path'
import moment from 'moment'
import lodash from 'lodash'
import fetch from 'node-fetch'
import {cfg, Constant} from "#guoba.platform"
import {isV3, isV4, isTRSS} from '#guoba.adapter'

/**
 * 随机生成指定长度的字符串
 * @param length
 * @return {string}
 */
export function randomString(length = 8) {
  let str = ''
  for (let i = 0; i < length; i++) {
    str += lodash.random(36).toString(36)
  }
  return str.substr(0, length)
}

export function toPairsMap(arg) {
  let obj = {}
  let pairs = lodash.toPairs(arg)
  for (let [key, value] of pairs) {
    obj[key] = value
  }
  return obj
}

/**
 * 非真实账号的判定。
 *
 * `stdin` 是控制台；官方 QQ 机器人（官bot）除了正式账号，还会额外注册一个沙盒环境的
 * 账号 `QQBotSandbox`。这类账号没有关系链、私聊发不出去，也不该拿它当「有账号上线了」
 * 的依据 —— 挑中它的话，`cfg.master` 里根本查不到它名下的主人。
 */
export function isFakeAccount(id) {
  return id == null || id === '' || /^stdin$|sandbox$/i.test(String(id))
}

/**
 * 获取主人列表，元素为 {botId, userId}
 *
 * TRSS 的 cfg.master 是 `botId:userId` 的映射，能明确知道该用哪个账号发消息；
 * 其余情况只有 masterQQ 列表，botId 留空由框架自行挑选。
 *
 * 注意 userId 不一定是数字：官bot 的主人是 `appid:openid`（本身就带冒号），宿主
 * 解析 master 时是 `split(':')` 后把剩下的 `join(':')` 还原的，所以这里拿到的是完整标识。
 */
async function getMasterList() {
  let config
  if (isV3 || isV4) {
    config = (await import('../../../lib/config/config.js')).default
  } else {
    config = BotConfig
  }
  if (isTRSS) {
    const list = []
    for (const [botId, users] of Object.entries(config.master ?? {})) {
      for (const userId of users ?? []) {
        list.push({botId, userId})
      }
    }
    if (list.length > 0) return list
  }
  let masterQQ = config.masterQQ ?? []
  if (!Array.isArray(masterQQ)) masterQQ = [masterQQ]
  return masterQQ.map(userId => ({botId: null, userId}))
}

/**
 * 真实主人列表：去掉 stdin、官bot 沙盒这类收不到私聊的账号。
 * botId 为 null 表示「由框架挑账号」，是合法的，不能当假账号滤掉。
 */
export async function getRealMasterList() {
  const masters = await getMasterList()
  return masters.filter(i =>
    i && !isFakeAccount(i.userId) && (i.botId == null || !isFakeAccount(i.botId)),
  )
}

/**
 * master 映射里真正配了主人的 Bot 账号集合（字符串）。
 * 用来在多账号环境里挑出「能给主人发消息」的那个账号。
 */
export async function getMasterBotIds() {
  const masters = await getRealMasterList()
  return new Set(masters.filter(i => i.botId != null).map(i => String(i.botId)))
}

/**
 * 给主人发送消息
 *
 * 默认发给所有主人：主人列表里第一个常常是 stdin（控制台）之类的非 QQ 账号，
 * 只发第一个会导致真正的主人收不到消息。
 *
 * @param msg 消息内容
 * @param all 是否发送给所有主人，默认true
 * @param idx 不发送给所有主人时，指定发送给第几个主人，默认发送给第一个主人
 * @return {Promise<number>} 发送成功的主人数量
 */
export async function sendToMaster(msg, all = true, idx = 0) {
  let masters = await getMasterList()
  if (masters.length === 0) {
    logger.warn('[Guoba] 未配置主人账号，无法发送私聊消息')
    return 0
  }
  let sendTo = all ? masters : [masters[idx]]
  let success = 0
  for (let master of sendTo) {
    if (!master) continue
    if (await replyPrivate(master, msg)) {
      success++
    }
  }
  return success
}

/**
 * 给指定 Bot 账号的主人发送消息
 *
 * 与 sendToMaster 的区别：只发给这个账号名下的主人，不会顺带发给 stdin
 * 这类非真实账号，适合“某个账号刚连上”时的场景。
 *
 * @param botId 目标 Bot 账号
 * @param msg 消息内容
 * @return {Promise<number>} 发送成功的主人数量
 */
export async function sendToBotMaster(botId, msg) {
  const masters = await getMasterList()
  // connect 事件里的 self_id 是数字，cfg.master 的键是字符串，统一转字符串再比
  const target = String(botId)
  // TRSS 能按账号精确匹配；其余情况 botId 为空，就用传入的账号发给所有主人
  let sendTo = masters.filter(i => i.botId != null && String(i.botId) === target)
  if (sendTo.length === 0) {
    sendTo = masters.filter(i => i.botId == null).map(i => ({...i, botId}))
  }
  /*
   * 传入的账号在 master 里查不到，就退回给「配了主人的账号」发。
   *
   * 官bot 除了正式账号还会注册一个沙盒账号（QQBotSandbox），多号环境也常见某个号
   * 没写进 master（只写了 masterQQ）。这时候直接跳过的话，首次引导这种一次性消息
   * 就永远发不出去 —— 而且不能改用传入的账号发：官bot 的 openid 只在自己 appid
   * 名下有效，拿沙盒账号去 pickFriend 正式账号的主人必然失败。
   */
  if (sendTo.length === 0) {
    sendTo = (await getRealMasterList()).filter(i => i.botId != null)
    if (sendTo.length > 0) {
      const ids = [...new Set(sendTo.map(i => String(i.botId)))].join('、')
      logger.mark(`[Guoba] Bot(${botId}) 名下没有主人账号，改用 ${ids} 发送`)
    }
  }
  if (sendTo.length === 0) {
    logger.warn(`[Guoba] Bot(${botId}) 名下没有主人账号，跳过发送`)
    return 0
  }
  let success = 0
  for (const master of sendTo) {
    if (await replyPrivate(master, msg)) {
      success++
    }
  }
  return success
}

/**
 * 给所有真实主人发消息，返回发送成功的主人账号列表。
 *
 * 与 sendToMaster 的区别：跳过 stdin 这类假账号（它收不到图片），并且返回明细而不只是数量。
 */
export async function sendToMasterList(msg) {
  const masters = await getRealMasterList()
  const sent = []
  for (const master of masters) {
    if (await replyPrivate(master, msg)) {
      sent.push(String(master.userId))
    }
  }
  return sent
}

/**
 * 发送私聊消息
 * @param master {{botId: ?string, userId: string|number}} 目标主人
 * @param msg 消息
 * @return {Promise<boolean>} 是否发送成功
 */
async function replyPrivate({botId, userId}, msg) {
  // 数字 QQ 转 number（部分适配器只认 number），官bot 的 `appid:openid` 保持字符串
  userId = Number(userId) || userId
  try {
    let bot = botId != null ? Bot.bots?.[botId] : null
    if (botId != null && !bot) {
      // 不走 Bot.sendFriendMsg：账号离线时它会挂起等待上线（默认5分钟），
      // 会把调用方（如登录接口）一起拖死
      logger.mark(`[Guoba] Bot(${botId}) 不在线，跳过给主人(${userId})发消息`)
      return false
    }
    let friend = (bot ?? Bot).pickFriend(userId)
    logger.mark(`[Guoba] 发送主人私聊消息(${botId ?? Bot.uin}:${userId})`)
    // 加超时兜底，避免适配器卡住导致接口一直不返回
    await Promise.race([
      friend.sendMsg(msg),
      new Promise((_, reject) => setTimeout(() => reject(new Error('发送超时')), 20000)),
    ])
    return true
  } catch (err) {
    logger.mark(`[Guoba] 给主人(${userId})发消息失败：${err.message ?? err}`)
    return false
  }
}

/**
 * 获取所有web地址，包括内网、外网
 */
export async function getAllWebAddress() {
  const {splicePort, helloTRSS} = cfg.get('server')
  let host = cfg.serverHost
  let port = cfg.serverPort
  port = splicePort ? Number.parseInt(port) : null
  port = port === 80 ? null : port
  let custom = []
  if (isTRSS && helloTRSS) {
    // 宿主自己配的对外地址。TRSS 在 server.yaml，Orangezai 这类 fork 在 bot.yaml
    const hostCfg = (await import('../../../lib/config/config.js')).default
    const server = hostCfg.server ?? {}
    if (server.url)
      custom.push(server.url)
    if (server.https?.url)
      custom.push(server.https.url)
    if (!custom.length && hostCfg.bot?.url)
      custom.push(hostCfg.bot.url)
  }
  let local = getAutoIps(port, true)
  let remote = await getRemoteIps()
  if (remote && remote.length > 0) {
    remote = remote.map((i) => joinHttpPort(i, port))
  }
  if (host) {
    if (!Array.isArray(host)) {
      host = [host]
    }
    for (let h of host) {
      if (h && h !== 'auto') {
        custom.push(joinHttpPort(h, port))
      }
    }
  }
  let mountRoot = cfg.serverMountPath.mountRoot
  mountRoot = mountRoot === '/' ? '' : mountRoot
  if (mountRoot) {
    custom = custom.map((i) => i + mountRoot)
    local = local.map((i) => i + mountRoot)
    remote = remote.map((i) => i + mountRoot)
  }
  return {custom, local, remote}
}

// 拼接端口号和http前缀
function joinHttpPort(ip, port) {
  ip = /^http/.test(ip) ? ip : 'http://' + ip
  return `${ip}${port ? ':' + port : ''}`
}

/**
 * 获取web地址
 * @param allIp 是否展示全部IP
 */
export function getWebAddress(allIp = false) {
  const {splicePort} = cfg.get('server')
  let host = cfg.serverHost
  let port = cfg.serverPort
  port = splicePort ? Number.parseInt(port) : null
  port = port === 80 ? null : port
  let hosts = []
  if (host === 'auto') {
    hosts.push(...getAutoIps(port, allIp))
  } else {
    if (!Array.isArray(host)) {
      host = [host]
    }
    for (let item of host) {
      if (item === 'auto') {
        hosts.push(...getAutoIps(port, allIp))
      } else {
        item = /^http/.test(item) ? item : 'http://' + item
        hosts.push(`${item}${port ? ':' + port : ''}`)
      }
    }
  }
  let mountRoot = cfg.serverMountPath.mountRoot
  mountRoot = mountRoot === '/' ? '' : mountRoot
  if (mountRoot) {
    hosts = hosts.map((i) => i + mountRoot)
  }
  return hosts
}

function getAutoIps(port, allIp) {
  let ips = getLocalIps(port)
  if (ips.length === 0) {
    ips.push(`localhost${port ? ':' + port : ''}`)
  }
  if (allIp) {
    return ips.map(ip => `http://${ip}`)
  } else {
    return [`http://${ips[0]}`]
  }
}

/**
 * 获取本地ip地址
 * 感谢 @吃吃吃个柚子皮
 * https://gitee.com/guoba-yunzai/guoba-plugin/pulls/2
 * @param port 要拼接的端口号
 * @return {*[]}
 */
export function getLocalIps(port) {
  let ips = []
  port = port ? `:${port}` : ''
  try {
    let networks = os.networkInterfaces()
    for (let [name, wlans] of Object.entries(networks)) {
      for (let wlan of wlans) {
        /*
         * 更改过滤规则,填坑。(之前未测试Windows系统)
         * 通过掩码过滤本地IPv6
         * 通过MAC地址过滤Windows 本地回环地址（踩坑）
         * 过滤lo回环网卡（Linux要过滤'lo'），去掉会导致Linxu"::1"过滤失败（踩坑）
         * 如有虚拟网卡需自己加上过滤--技术有限
         */
        /*
         * 修复过滤，部分Linux读取不到IPv6
         * 放弃使用网段过滤，采取过滤fe、fc开头地址
         */
        // noinspection EqualityComparisonWithCoercionJS
        if (name != 'lo' && name != 'docker0' && wlan.address.slice(0, 2) != 'fe' && wlan.address.slice(0, 2) != 'fc') {
          // 过滤本地回环地址
          if (['127.0.0.1', '::1'].includes(wlan.address)) {
            continue
          }
          if (wlan.family === 'IPv6') {
            ips.push(`[${wlan.address}]${port}`)
          } else {
            ips.push(`${wlan.address}${port}`)
          }
        }
      }
    }
  } catch (e) {
    let err = e?.stack || e?.message || e
    err = err ? err.toString() : ''
    if (/Unknown system error 13/i.test(err)) {
      logger.warn('[Guoba] 由于系统限制，无法获取到IP地址，仅显示本地回环地址。该问题目前暂无方案解决，但不影响Guoba使用，您可手动配置自定义地址。')
      ips.push(`localhost${port}`)
    } else {
      logger.error(`错误：${logger.red(e)}`)
    }
  }
  if (ips.length === 0) {
    logger.warn('[Guoba] 无法获取到IP地址，仅显示本地回环地址，详情请查看以上报错。')
    ips.push(`localhost${port}`)
  }
  return ips
}

/**
 * 获取外网ip地址
 * @author @吃吃吃个柚子皮
 */
export async function getRemoteIps() {
  let redisKey = Constant.REDIS_PREFIX + 'remote-ips:3'
  let cacheData = await redis.get(redisKey)
  let ips
  if (cacheData) {
    ips = JSON.parse(cacheData)
    if (Array.isArray(ips) && ips.length > 0) {
      return ips
    }
  }
  ips = []
  //API是免费，但不能商用。(废话)
  let apis = [
    // 返回IPv4地址
    'http://v4.ip.zxinc.org/info.php?type=json',
    // 返回IPv6地址（已失效）
    // 'http://v6.ip.zxinc.org/info.php?type=json'
  ]
  for (let api of apis) {
    let response
    try {
      response = await fetch(api)
    } catch {
      continue
    }
    if (response.status === 200) {
      let {code, data} = await response.json()
      if (code === 0) {
        ips.push(data.myip)
      }
    }
  }
  // 缓存避免过多请求，防止接口提供商检测
  // 服务器上的外网IP一般不会变，如果经常变的话就推荐使用DDNS，
  // 而家用PC一般也用不到外网IP，仍然推荐使用DDNS内网穿透。
  if (ips.length > 0) {
    redis.set(redisKey, JSON.stringify(ips), {EX: 3600 * 24})
  }
  return ips
}

export function sleep(ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 读取JSON文件
 * @param filePath
 */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 *
 * 制作转发消息
 * @param e
 * @param msg 消息体
 * @param dec 描述
 * @returns {Promise<boolean|*>}
 */
export async function makeForwardMsg(e, msg = [], dec = '') {
  const bot = e.bot || Bot
  let nickname = bot.nickname
  if (e.isGroup && bot.getGroupMemberInfo) try {
    const info = await bot.getGroupMemberInfo(e.group_id, bot.uin)
    nickname = info.card || info.nickname
	} catch {}
  let userInfo = {
    user_id: bot.uin,
    nickname,
  }

  let forwardMsg = []
  msg.forEach(v => {
    forwardMsg.push({
      ...userInfo,
      message: v,
    })
  })

  /** 制作转发内容 */
  if (e.group?.makeForwardMsg) {
    forwardMsg = await e.group.makeForwardMsg(forwardMsg)
  } else if (e.friend?.makeForwardMsg) {
    forwardMsg = await e.friend.makeForwardMsg(forwardMsg)
  } else {
    forwardMsg = await Bot.makeForwardMsg(forwardMsg)
  }

  if (dec && !Array.isArray(forwardMsg)) {
    /** 处理描述 */
    if (typeof forwardMsg.data === 'object' && forwardMsg.data !== null) {
      let detail = forwardMsg.data?.meta?.detail
      if (detail) {
        detail.news = [{ text: dec }]
      }
    } else if (typeof forwardMsg.data === 'string') {
      forwardMsg.data = forwardMsg.data
        .replace(/\n/g, '')
        .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
        .replace(/___+/, `<title color="#777777" size="26">${dec}</title>`)
    }
  }

  return forwardMsg
}

/** 此方法可以解决 docker 跨设备问题 */
export function moveFile(src, dest) {
  fs.copyFileSync(src, dest)
  fs.unlinkSync(src)
}

// 递归创建目录 同步方法
export function mkdirSync(dirname) {
  if (fs.existsSync(dirname)) {
    return true
  } else {
    if (mkdirSync(path.dirname(dirname))) {
      fs.mkdirSync(dirname)
      return true
    }
  }
}

// 判断目录是否为空
export function dirIsEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return true
  }
  try {
    fs.rmdirSync(dirPath)
    fs.mkdirSync(dirPath)
    return true
  } catch (e) {
    if (/directory not empty/.test(e?.message)) {
      return false
    }
    throw e
  }
}

/**
 * 日期比较，相差时间数
 * @param beginTime
 * @param endTime
 * @return {{hours: number, seconds: number, minutes: number, days: number}}
 */
export function dateDiff(beginTime, endTime) {
  let diff = moment(endTime).diff(moment(beginTime))
  if (diff < 0) {
    throw new Error('结束时间不能小于开始时间')
  }
  // 计算出相差天数
  let days = Math.floor(diff / (24 * 3600 * 1000))
  // 计算出小时数
  let leave1 = diff % (24 * 3600 * 1000)
  let hours = Math.floor(leave1 / (3600 * 1000))
  // 计算相差分钟数
  let leave2 = leave1 % (3600 * 1000)
  let minutes = Math.floor(leave2 / (60 * 1000))
  // 计算相差秒数
  let leave3 = leave2 % (60 * 1000)
  let seconds = Math.round(leave3 / 1000)
  return {days, hours, minutes, seconds}
}
