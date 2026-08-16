import chalk from 'chalk';
import {autowired, Result} from '#guoba.framework';
import {ApiController} from '#guoba.platform'

export class LoginController extends ApiController {

  loginService = autowired('loginService')
  loginSecurityService = autowired('loginSecurityService')

  constructor(guobaApp) {
    super('', guobaApp)
  }

  registerRouters() {
    this.get('/login/status', this.status)
    this.post('/login', this.login)
    this.post('/logout', this.logout)
    this.post('/login/captcha/request', this.captchaRequest)
    // 尚未配置账号时的初始化入口（配置完成后自动停用）
    this.post('/login/code/request', this.codeLoginRequest)
    this.post('/login/code/check', this.codeLoginCheck)
    this.get('/login/security', this.security)
    this.put('/login/security/credentials', this.setCredentials)
    this.delete('/login/security/trusted-ips/:ip', this.revokeIp)
    this.delete('/login/security/trusted-ips', this.clearIps)
    this.delete('/login/security/trusted-devices/:id', this.revokeDevice)
    this.delete('/login/security/trusted-devices', this.clearDevices)
  }

  async status(req) {
    return Result.ok(this.loginSecurityService.getStatus(req))
  }

  async login(req) {
    const result = await this.loginSecurityService.login(req, req.body, this.loginService)
    if (result?.captchaRequired) {
      return Result.error(428, result, result.error, 428)
    }
    return Result.ok(result)
  }

  async captchaRequest(req) {
    const result = await this.loginSecurityService.requestCaptcha(req, this.loginService)
    return Result.ok(result, '验证码已发送给主人')
  }

  async security() {
    return Result.ok(this.loginSecurityService.getSecurity())
  }

  async setCredentials(req) {
    const {username, password, currentPassword} = req.body ?? {}
    return Result.ok(this.loginSecurityService.setCredentials(username, password, currentPassword, req), '登录凭证已保存')
  }

  async revokeIp(req) {
    return Result.ok(this.loginSecurityService.revokeIp(req.params.ip), '已撤销该IP')
  }

  async clearIps() {
    return Result.ok(this.loginSecurityService.clearIps(), '已清空可信IP')
  }

  async revokeDevice(req) {
    return Result.ok(this.loginSecurityService.revokeDevice(req.params.id), '已撤销该设备')
  }

  async clearDevices() {
    return Result.ok(this.loginSecurityService.clearDevices(), '已清空可信设备')
  }

  async logout(req) {
    let {token} = req.body
    this.loginService.logout(token)
    return Result.ok(null, '注销成功')
  }

  async codeLoginRequest() {
    if (this.loginSecurityService.configured) return Result.error('旧版验证码登录已停用，请使用用户名和密码')
    const code = await this.loginService.codeLoginRequest()
    if (code) {
      logger.mark('[Guoba] '
        + chalk.yellow('您正在请求初始化验证码，若没有输出验证码，请将日志级别调整为 ')
        + chalk.green('info')
        + chalk.yellow(' 或以上')
      )
      logger.info('#'.repeat(54))
      logger.info('# ' + chalk.green('[Guoba] 初始化验证码') + '                             #')
      logger.info('# 您的初始化验证码为: ' + chalk.yellow(code) + '                 #')
      logger.info('# 验证码五分钟内有效且失效前不会再次打印，请尽快输入 #')
      logger.info('#'.repeat(54))
      const pushed = await this.loginService.sendCodeToMaster(code)
      return Result.ok({pushed}, '验证码已发送给主人')
    }
    return Result.error('code generate failed')
  }

  async codeLoginCheck(req) {
    if (this.loginSecurityService.configured) return Result.error('旧版验证码登录已停用，请使用用户名和密码')
    let {code} = req.body
    code = typeof code === 'string' ? code.trim() : code
    const token = await this.loginService.codeLoginCheck(code)
    if (token) {
      logger.mark('[Guoba] 初始化验证码登录成功，请在配置管理中设置用户名和密码')
      return Result.ok({token})
    }
    return Result.error('验证码错误或已失效')
  }

}
