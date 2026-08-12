import chalk from 'chalk';
import {autowired, Result} from '#guoba.framework';
import {ApiController} from '#guoba.platform'
import { getClientIp } from '../../utils/clientIp.js'

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
    // 兼容旧版：仅在尚未配置账号时作为初始化入口
    this.post('/login/quick', this.quickLogin)
    this.post('/login/code/request', this.codeLoginRequest)
    this.post('/login/code/check', this.codeLoginCheck)
    // 聊天确认登录：旧版兼容入口
    this.post('/login/confirm/request', this.confirmRequest)
    this.post('/login/confirm/poll', this.confirmPoll)
    this.get('/login/security', this.security)
    this.put('/login/security/credentials', this.setCredentials)
    this.delete('/login/security/trusted-ips/:ip', this.revokeIp)
    this.delete('/login/security/trusted-ips', this.clearIps)
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

  async confirmRequest(req) {
    const ip = getClientIp(req)
    const data = await this.loginService.createConfirmRequest(ip)
    logger.mark(`[Guoba] 收到登录确认请求(${data.code})，来自 ${ip || '未知IP'}，发送“#锅巴确认登录”即可登录`)
    return Result.ok(data)
  }

  async confirmPoll(req) {
    const {id} = req.body
    return Result.ok(await this.loginService.pollConfirmRequest(id))
  }

  async logout(req) {
    let {token} = req.body
    this.loginService.logout(token)
    return Result.ok('注销成功')
  }

  async quickLogin(req) {
    if (this.loginSecurityService.configured) return Result.error('快捷登录已停用，请使用用户名和密码')
    let {code} = req.body
    return Result.ok(await this.loginService.getQuickLogin(code))
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
