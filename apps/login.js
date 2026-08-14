import { autowired } from '#guoba.framework'
import { makeForwardMsg } from '#guoba.utils'
import { cfg } from '#guoba.platform'

export class GuobaLogin extends plugin {
  loginService = autowired('loginService')
  loginSecurityService = autowired('loginSecurityService')

  constructor (e) {
    super({
      name: '锅巴登录',
      dsc: '锅巴快捷登录',
      event: 'message',
      priority: 100,
      rule: [
        {
          reg: '^#?锅巴(登录|登陆)$',
          fnc: 'login'
        },
        {
          // 忘记密码时由主人重置：清空账号密码和可信IP，回到初始化登录流程
          reg: '^#?锅巴重置(登录|登陆|密码)$',
          fnc: 'resetLogin'
        }
      ]
    }, e)
  }

  async resetLogin () {
    if (!this.e.isMaster) return false
    if (!this.loginSecurityService.configured) {
      return this.reply('当前尚未设置账号密码，无需重置。')
    }
    this.loginSecurityService.resetCredentials()
    return this.reply(
      '登录凭证已重置，账号密码、可信IP和可信设备已全部清空。\n'
      + '现在可以发送“#锅巴登录”获取登录地址，在登录页点击“获取登录令牌”，令牌会私聊发给主人，登录后请尽快在“账号管理 - 登录安全”中重新设置账号密码。'
    )
  }

  async login () {
    if (!this.e.isMaster) return false
    const configured = this.loginSecurityService.configured

    let webAddress
    try {
      // 无论是否已配置账号，都只发面板地址，不签发任何免密令牌
      webAddress = await this.loginService.getWebAddress()
    } catch (e) {
      console.error(e)
      return this.reply(
        '锅巴服务启动失败，可能是端口号占用，或者依赖没有安装完整，请发送“#锅巴帮助”获取相关帮助信息。'
      )
    }

    const onlyCustomAddress = cfg.get('base.onlyCustomAddress')
    const { custom, local, remote } = webAddress
    const message = configured
      ? ['这是锅巴面板的地址，请使用用户名密码登录：']
      : ['欢迎回来主人~\n这是您的登录地址：']

    // 文案与网址分条发送，方便手机端长按复制
    const pushAddress = (title, list) => {
      message.push(title)
      if (list.length > 0) {
        message.push(...list)
      } else {
        message.push('获取失败……')
      }
    }

    if (onlyCustomAddress) {
      if (custom && custom.length > 0) {
        pushAddress('自定义地址：', custom)
      } else {
        message.push('当前启用了“仅发送自定义地址”，但未配置自定义地址。')
      }
    } else {
      if (custom && custom.length > 0) {
        pushAddress('自定义地址：', custom)
      }
      if (local) {
        pushAddress('内网地址：', local)
      }
      if (remote) {
        pushAddress('外网地址：', remote)
      }
    }

    if (configured) {
      message.push('若忘记密码，可发送“#锅巴重置密码”清空凭证重新初始化。')
    } else {
      message.push(
        '尚未设置账号密码，请打开登录页点击“获取登录令牌”，令牌会私聊发给主人（五分钟内有效）。\n'
        + '登录后请尽快在“账号管理 - 登录安全”里设置用户名和密码。'
      )
    }

    if (this.e?.platform) {
      message.push('[请在后台查看地址]')
      for (const item of message) {
        console.log(item)
        this.e.reply(item)
      }
      return
    }

    if (this.e.isGroup && !cfg.get('base.loginInGroup')) {
      try {
        await Bot.pickUser(this.e.user_id).sendMsg(
          await this.e.runtime.common.makeForwardMsg(this.e, message)
        )
        await this.reply(
          configured
            ? '当前已启用用户名密码登录，面板地址已私聊发送给主人~'
            : '地址已发送至主人的私信了~'
        )
      } catch (e) {
        logger.error(e)
        await this.reply('消息发送失败~请加Bot的好友或者私聊发送#锅巴登录')
      }
    } else {
      if (configured) {
        await this.reply('当前已启用用户名密码登录，请使用以下地址打开面板：')
      }
      await this.reply(await makeForwardMsg(this.e, message))
    }
  }
}
