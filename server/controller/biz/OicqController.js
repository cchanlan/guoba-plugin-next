import {autowired, Pager, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'
import {groupAvatarUrl, userAvatarUrl} from '../../service/both/model/avatar.js'
import {ensureContacts} from '../../service/both/model/bots.js'

/** QQ相关操作 */
export class OicqController extends ApiController {

  oicqService = autowired('oicqService')

  constructor(guobaApp) {
    super('/oicq', guobaApp)
  }

  registerRouters() {
    this.get('/pick/user', this.pickUser)
    this.get('/pick/group', this.pickGroup)

    // 群发是后台任务，起任务后靠轮询查进度，可中途叫停
    this.post('/broadcast', this.startBroadcast)
    this.get('/broadcast/:taskId', this.getBroadcast)
    this.post('/broadcast/:taskId/cancel', this.cancelBroadcast)
    // 均为不可逆操作，用 delete 语义并要求前端二次确认
    this.delete('/friend', this.deleteFriend)
    this.delete('/group', this.quitGroup)

    // 列表里每项都带算好的 avatar（QQBot 的 openid 前端拼不出来）
    this.get('/friend/list', this.queryFriendList)
    this.get('/friend/count', async () => Result.ok(await this.oicqService.getFriendCount()))

    this.get('/group/list', this.queryGroupList)
  }

  /** 获取一个QQ用户信息 */
  async pickUser(req) {
    let {qq} = req.query
    if (!qq) {
      return Result.error(`参数 qq 不能为空`)
    }
    let user = await this.oicqService.pickUser(qq)
    return Result.ok(user)
  }

  /** 删除好友（不可逆） */
  async deleteFriend(req) {
    let {userId, botId} = req.body ?? {}
    let data = await this.oicqService.deleteFriend(userId, botId)
    return Result.ok(data, '已删除该好友')
  }

  /** 起一个群发任务，立刻返回任务信息，实际发送在后台进行 */
  async startBroadcast(req) {
    let {type, targets, msg, interval} = req.body ?? {}
    let task = this.oicqService.startBroadcast(type, targets, msg, interval)
    return Result.ok(task, `已开始群发，共 ${task.total} 个目标`)
  }

  /** 查询群发进度 */
  async getBroadcast(req) {
    return Result.ok(this.oicqService.getBroadcastTask(req.params.taskId))
  }

  /** 停止群发，已发出的收不回来，只是不再往下发 */
  async cancelBroadcast(req) {
    let task = this.oicqService.cancelBroadcast(req.params.taskId)
    return Result.ok(task, '已请求停止群发')
  }

  /** 退出群聊（不可逆） */
  async quitGroup(req) {
    let {groupId, isDismiss, botId} = req.body ?? {}
    let data = await this.oicqService.quitGroup(groupId, isDismiss, botId)
    return Result.ok(data, data.isDismiss ? '已解散该群' : '已退出该群')
  }

  /** 获取一个QQ群组信息 */
  async pickGroup(req) {
    let {groupId} = req.query
    if (!groupId) {
      return Result.error(`参数 groupId 不能为空`)
    }
    let group = await this.oicqService.pickGroup(groupId)
    return Result.ok(group)
  }

  async queryGroupList(req) {
    let {pageNo, pageSize, group_id, query_group_id, query_name} = req.query
    pageNo = !pageNo ? 1 : Number.parseInt(pageNo)
    pageSize = !pageSize ? 10 : Number.parseInt(pageSize)

    // 缓存空着先补一次，否则协议端刚起来时列表是空的（见 ensureContacts）
    await ensureContacts('group')
    let groupList = Bot.getGroupMap?.() || Bot.getGroupList()
    let list = []
    let filter = (_) => true
    // 根据 group_id 模糊查询
    if (query_group_id || query_name) {
      filter = (item) => {
        let flag = true
        if (query_group_id) {
          flag = String(item.group_id).includes(query_group_id)
        }
        // 根据群名称或备注模糊筛选
        if (query_name && flag) {
          flag = String(item.group_name).includes(query_name)
        }
        return flag
      }
    }
    // 根据group_id过滤
    let groupId = group_id ? group_id.split(',').map(u => Number(u) || u) : null
    if (groupId && groupId.length > 0) {
      pageNo = 1
      pageSize = groupId.length
      filter = (item) => groupId.includes(item.group_id)
    }

    for (let [, item] of groupList) {
      if (filter(item)) {
        list.push(item)
      }
    }

    let page = new Pager(list, pageNo, pageSize).toJSON()
    // 头像地址在后端算：QQBot 是 openid，得配上账号的 appid 才拼得出来（见 model/avatar.js）
    page.records = page.records.map((item) => ({
      ...item,
      avatar: groupAvatarUrl(item.group_id, item.avatar),
    }))
    return Result.ok(page)
  }

  async queryFriendList(req) {
    let {pageNo, pageSize, user_id, query_qq, query_name} = req.query
    pageNo = !pageNo ? 1 : Number.parseInt(pageNo)
    pageSize = !pageSize ? 10 : Number.parseInt(pageSize)

    await ensureContacts('friend')
    let friendList = Bot.getFriendMap?.() || Bot.getFriendList()
    let list = []
    let filter = (_) => true
    // 根据 qq 模糊查询
    if (query_qq || query_name) {
      filter = (item) => {
        let flag = true
        if (query_qq) {
          flag = String(item.user_id).includes(query_qq)
        }
        // 根据昵称或备注模糊筛选
        if (query_name && flag) {
          flag = String(item.nickname).includes(query_name) || String(item.remark).includes(query_name)
        }
        return flag
      }
    }
    // 根据user_id过滤
    let userId = user_id ? user_id.split(',').map(u => Number(u) || u) : null
    if (userId && userId.length > 0) {
      pageNo = 1
      pageSize = userId.length
      filter = (item) => userId.includes(item.user_id)
    }

    for (let [, item] of friendList) {
      if (filter(item)) {
        list.push(item)
      }
    }

    let page = new Pager(list, pageNo, pageSize).toJSON()
    // 同上：好友表里 QQBot 存的是 openid，头像得靠 appid 拼
    page.records = page.records.map((item) => ({
      ...item,
      avatar: userAvatarUrl(item.user_id, item.bot_id, item.avatar),
    }))
    return Result.ok(page)
  }

}
