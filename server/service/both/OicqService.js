import {GuobaError, Service} from '#guoba.framework';
import {toPairsMap} from '#guoba.utils'

/** 单次群发的目标数上限，再多就该用插件自己写定时任务了 */
const MAX_TARGETS = 500
/** 发送间隔（毫秒）的允许范围，太快容易触发风控 */
const MIN_INTERVAL = 200
const MAX_INTERVAL = 60000
const DEFAULT_INTERVAL = 1000
/** 任务跑完后在内存里保留多久，供前端拉最终结果 */
const TASK_TTL = 10 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class OicqService extends Service {
  /**
   * 群发任务，仅存在内存里，重启即丢 —— 这是主人临时发通知用的，
   * 没必要落盘，也避免残留任务在重启后诈尸继续发。
   */
  #tasks = new Map()
  #taskSeq = 0

  constructor(app) {
    super(app)
  }

  /** 获取一个QQ用户信息 */
  async pickUser(userId) {
    userId = Number(userId) || userId
    const user = Bot.pickUser(userId)
    return {
      userId,
      simpleInfo: user.info || await user.getInfo?.() || await user.getSimpleInfo?.(),
    }
  }

  /** 获取一个QQ群组信息 */
  async pickGroup(groupId) {
    groupId = Number(groupId) || groupId
    const group = Bot.pickGroup(groupId)
    return {
      groupId,
      info: group.info || await group.getInfo?.(),
    }
  }

  /**
   * 主动发消息。
   *
   * @param type 'friend' | 'group'
   * @param id   好友 QQ 号 / 群号
   * @param msg  消息内容（纯文本）
   * @param botId 指定用哪个账号发，多账号环境下必填才能保证发信人正确
   */
  async sendMsg(type, id, msg, botId) {
    if (type !== 'friend' && type !== 'group') {
      throw new GuobaError(`不支持的发送类型：${type}`)
    }
    msg = typeof msg === 'string' ? msg.trim() : ''
    if (!msg) {
      throw new GuobaError('消息内容不能为空')
    }
    id = Number(id) || id
    const target = this.#pick(type, id, botId)
    if (!target?.sendMsg) {
      throw new GuobaError(`未找到可用的发送对象：${id}`)
    }
    const res = await target.sendMsg(msg)
    // 各适配器返回结构不一，只把能用的字段透出去
    return {
      id,
      type,
      messageId: res?.message_id ?? null,
      time: res?.time ?? null,
    }
  }

  /**
   * 按 bot_id 取到操作对象。
   *
   * 多账号（TRSS）下同一个号只挂在其中一个账号的列表里，指定了 bot_id 就直接用它，
   * 免得 Bot.pickXxx 在找不到时「随机选择Bot」，把操作发到别的号上去。
   */
  #pick(type, id, botId) {
    id = Number(id) || id
    botId = botId ? (Number(botId) || botId) : null
    const owner = (botId != null && Bot.bots?.[botId]) || Bot
    return type === 'group' ? owner.pickGroup(id) : owner.pickUser(id)
  }

  /** 是否为本机 Bot 自己的账号 */
  #isSelf(id) {
    id = String(id)
    if (Array.isArray(Bot?.uin)) {
      return Bot.uin.some((u) => String(u) === id)
    }
    return String(Bot?.uin) === id
  }

  /** 删除好友。不可逆，需对方重新添加 */
  async deleteFriend(userId, botId) {
    if (!userId) {
      throw new GuobaError('参数 userId 不能为空')
    }
    // Bot 自己也在好友列表里，删掉会让机器人失去给自己发消息的能力
    if (this.#isSelf(userId)) {
      throw new GuobaError('不能删除 Bot 自己的账号')
    }
    const user = this.#pick('friend', userId, botId)
    // Satori / OPQBot 等适配器未实现该操作，先判空避免抛 not a function
    if (typeof user?.delete !== 'function') {
      throw new GuobaError('当前适配器不支持删除好友')
    }
    await user.delete()
    return {userId: Number(userId) || userId}
  }

  /** 退出群聊。isDismiss 为解散群（仅群主可用） */
  async quitGroup(groupId, isDismiss = false, botId) {
    if (!groupId) {
      throw new GuobaError('参数 groupId 不能为空')
    }
    const group = this.#pick('group', groupId, botId)
    if (typeof group?.quit !== 'function') {
      throw new GuobaError('当前适配器不支持退出群聊')
    }
    await group.quit(!!isDismiss)
    return {groupId: Number(groupId) || groupId, isDismiss: !!isDismiss}
  }

  getFriendList() {
    return toPairsMap(Bot.getFriendMap?.() || Bot.getFriendList())
  }

  getFriendCount() {
    return (Bot.getFriendMap?.() || Bot.getFriendList()).size
  }

  getGroupList() {
    return toPairsMap(Bot.getGroupMap?.() || Bot.getGroupList())
  }

  getGroupCount() {
    return (Bot.getGroupMap?.() || Bot.getGroupList()).size
  }

  /* ---------------- 群发 ---------------- */

  /**
   * 起一个群发任务，立刻返回 taskId，实际发送在后台按间隔逐个进行。
   *
   * 不做成同步接口：几百个目标乘上发送间隔要好几分钟，HTTP 早超时了；
   * 前端拿 taskId 轮询进度，也能中途叫停。
   *
   * @param type     'friend' | 'group'
   * @param targets  [{id, botId, name}]，botId 决定用哪个账号发
   * @param msg      消息内容（纯文本）
   * @param interval 每条之间的间隔毫秒数
   */
  startBroadcast(type, targets, msg, interval = DEFAULT_INTERVAL) {
    if (type !== 'friend' && type !== 'group') {
      throw new GuobaError(`不支持的发送类型：${type}`)
    }
    msg = typeof msg === 'string' ? msg.trim() : ''
    if (!msg) {
      throw new GuobaError('消息内容不能为空')
    }
    const list = this.#normalizeTargets(targets)
    if (list.length === 0) {
      throw new GuobaError('请至少选择一个发送目标')
    }
    if (list.length > MAX_TARGETS) {
      throw new GuobaError(`单次最多群发 ${MAX_TARGETS} 个目标，当前 ${list.length} 个`)
    }
    interval = Number(interval)
    if (!Number.isFinite(interval)) {
      interval = DEFAULT_INTERVAL
    }
    interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(interval)))

    const id = `bc-${++this.#taskSeq}`
    const task = {
      id,
      type,
      msg,
      interval,
      total: list.length,
      sent: 0,
      failed: 0,
      /** running | done | canceled */
      status: 'running',
      canceling: false,
      startAt: Date.now(),
      endAt: null,
      /** 只记失败的，成功的没什么可看 */
      errors: [],
    }
    this.#tasks.set(id, task)
    this.#gcTasks()
    // 后台跑，异常兜住，别让未捕获的 rejection 打到进程上
    this.#runBroadcast(task, list).catch((e) => {
      task.status = 'done'
      task.endAt = Date.now()
      logger.error('[Guoba] 群发任务异常：', e)
    })
    return this.getBroadcastTask(id)
  }

  /** 校验并去重目标，顺带记下名字，失败列表里好认人 */
  #normalizeTargets(targets) {
    const seen = new Set()
    const list = []
    for (const raw of Array.isArray(targets) ? targets : []) {
      const id = Number(raw?.id) || raw?.id
      if (!id) continue
      const key = String(id)
      if (seen.has(key)) continue
      seen.add(key)
      list.push({
        id,
        botId: raw?.botId ?? null,
        name: typeof raw?.name === 'string' ? raw.name.slice(0, 40) : '',
      })
    }
    return list
  }

  async #runBroadcast(task, list) {
    for (let i = 0; i < list.length; i++) {
      if (task.canceling) {
        task.status = 'canceled'
        break
      }
      const item = list[i]
      try {
        const target = this.#pick(task.type, item.id, item.botId)
        if (!target?.sendMsg) {
          throw new Error('未找到可用的发送对象')
        }
        await target.sendMsg(task.msg)
        task.sent++
      } catch (e) {
        task.failed++
        // 失败详情只留前 50 条，几百个目标全挂时不至于把内存堆满
        if (task.errors.length < 50) {
          task.errors.push({id: item.id, name: item.name, error: e?.message || String(e)})
        }
      }
      // 最后一个发完不用再等
      if (i < list.length - 1 && !task.canceling) {
        await sleep(task.interval)
      }
    }
    if (task.status === 'running') {
      task.status = 'done'
    }
    task.endAt = Date.now()
    logger.mark(
      `[Guoba] 群发${task.status === 'canceled' ? '已取消' : '完成'}：` +
      `成功 ${task.sent}，失败 ${task.failed}，共 ${task.total}`,
    )
  }

  /** 查询任务进度 */
  getBroadcastTask(taskId) {
    const task = this.#tasks.get(taskId)
    if (!task) {
      throw new GuobaError('任务不存在或已过期')
    }
    const {canceling, ...view} = task
    return view
  }

  /**
   * 请求停止任务。当前这条已经发出去的收不回来，
   * 只是不再往下发，所以是「取消中 → 下一轮生效」。
   */
  cancelBroadcast(taskId) {
    const task = this.#tasks.get(taskId)
    if (!task) {
      throw new GuobaError('任务不存在或已过期')
    }
    if (task.status === 'running') {
      task.canceling = true
    }
    return this.getBroadcastTask(taskId)
  }

  /** 清掉结束够久的任务 */
  #gcTasks() {
    const now = Date.now()
    for (const [id, task] of this.#tasks) {
      if (task.endAt && now - task.endAt > TASK_TTL) {
        this.#tasks.delete(id)
      }
    }
  }
}