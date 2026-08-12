import {Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

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
    return Result.ok({
      userId: username,
      username,

      realName: Bot.nickname,
      avatar: '',
      desc: '',
      homePath: '/home',
      roles: [
        {roleName: '超级管理员', value: 'sa'},
      ],
    })
  }
}