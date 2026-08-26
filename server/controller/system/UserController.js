import {Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'
import {botAvatarUrl} from '../../service/both/model/avatar.js'
import {mainBot} from '../../service/both/model/bots.js'

export class UserController extends ApiController {
  constructor(guobaApp) {
    super('/user', guobaApp)
  }

  registerRouters() {
    this.get('/getLoginUser', this.getLoginUser)
  }

  // 获取登录用户
  async getLoginUser(req) {
    /**
     * 昵称和头像取同一个账号，而且只认真账号（见 model/bots.js 的 mainBot）。
     *
     * 不能拿账号列表的第一项：stdin 不用登录，注册得比真账号早，多半就排在最前 ——
     * 那样顶栏显示的是它的昵称「标准输入」，头像也退化成一个「标」字。
     * 也不能读 `Bot.nickname`：TRSS 会把它重定向到随机一个在线账号
     * （lib/bot.js 的 uin.toJSON 每 60 秒换一次），多账号时页面上的昵称会自己跳，
     * 只有 stdin 在线时又绕回「标准输入」。
     *
     * 真账号都没上线就留空，前端会退回显示登录用户名。
     */
    const main = mainBot()
    const username = req.decodeToken?.()?.username || main?.uin || ''
    return Result.ok({
      userId: username,
      username,

      // 昵称还没就绪的适配器给的是空串，退到账号号码 —— 它同样指向机器人本体
      realName: main?.nickname || main?.uin || '',
      avatar: botAvatarUrl(main?.uin),
      desc: '',
      homePath: '/home',
      roles: [
        {roleName: '超级管理员', value: 'sa'},
      ],
    })
  }
}