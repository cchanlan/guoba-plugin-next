import { autowired } from '#guoba.framework'
import { makeForwardMsg } from '#guoba.utils'
import { cfg } from '#guoba.platform'

export class GuobaLogin extends plugin {
  loginService = autowired('loginService')

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
          // 网页上点了「聊天登录」后，发这个即可直接进面板；同时有多个请求时可带短码
          reg: '^#?锅巴确认(登录|登陆)\\s*([A-Za-z0-9]{4})?$',
          fnc: 'confirmLogin'
        }
      ]
    }, e)
  }

  async confirmLogin () {
    if (!this.e.isMaster) return false

    const code = this.e.msg.match(/([A-Za-z0-9]{4})\s*$/)?.[1]
    let result
    try {
      result = await this.loginService.confirmLogin(this.e.user_id, code)
    } catch (err) {
      logger.error(err)
      return this.reply('确认登录失败，请查看控制台日志。')
    }

    if (result.ok) {
      return this.reply(`已确认登录（${result.code}）~\n来自 ${result.ip}，网页会自动进入面板。`)
    }
    switch (result.reason) {
      case 'none':
        return this.reply('当前没有等待确认的登录请求，请先在网页上点击“聊天登录”。')
      case 'multi':
        return this.reply(
          `有 ${result.codes.length} 个登录请求在等待确认：${result.codes.join('、')}\n`
          + '请发送“#锅巴确认登录 短码”指定其中一个。'
        )
      case 'code':
        return this.reply(
          `没找到短码为 ${code} 的登录请求。\n当前等待确认的：${result.codes.join('、')}`
        )
      default:
        return this.reply('确认登录失败，请重试。')
    }
  }

  async login () {
    if (!this.e.isMaster) return false

    let webAddress
    try {
      webAddress = await this.loginService.setQuickLogin(this.e.user_id)
    } catch (e) {
      console.error(e)
      return this.reply(
        '锅巴服务启动失败，可能是端口号占用，或者依赖没有安装完整，请发送“#锅巴帮助”获取相关帮助信息。'
      )
    }

    const onlyCustomAddress = cfg.get('base.onlyCustomAddress')
    const { custom, local, remote } = webAddress
    const message = ['欢迎回来主人~\n这是您的登录地址：']

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

    message.push(
      '临时令牌3分钟内有效（请勿轻易告知他人哦），使用过后会立即失效，若登录成功将会在使用者的浏览器上生成个24小时内有效的令牌，过期后需要重新登录~'
    )

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
        await this.reply('地址已发送至主人的私信了~')
      } catch (e) {
        logger.error(e)
        await this.reply('消息发送失败~请加Bot的好友或者私聊发送#锅巴登录')
      }
    } else {
      await this.reply(await makeForwardMsg(this.e, message))
    }
  }
}
