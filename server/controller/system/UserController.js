import {Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'
import {botAvatarUrl} from '../../service/both/model/avatar.js'
import {listBots} from '../../service/both/model/bots.js'

export class UserController extends ApiController {
  constructor(guobaApp) {
    super('/user', guobaApp)
  }

  registerRouters() {
    this.get('/getLoginUser', this.getLoginUser)
  }

  // 获取登录用户
  async getLoginUser(req) {
    const username = req.decodeToken?.()?.username || Bot.uin
    /**
     * 昵称和头像取同一个账号。
     * 直接读 `Bot.nickname` 会走 TRSS 的属性重定向，落到随机一个在线账号上
     * （lib/bot.js 的 uin.toJSON 每 60 秒换一次），多账号时页面上的昵称会自己跳。
     */
    const [main] = listBots()
    return Result.ok({
      userId: username,
      username,

      realName: main?.nickname || Bot.nickname,
      avatar: botAvatarUrl(main?.uin),
      desc: '',
      homePath: '/home',
      roles: [
        {roleName: '超级管理员', value: 'sa'},
      ],
    })
  }
}