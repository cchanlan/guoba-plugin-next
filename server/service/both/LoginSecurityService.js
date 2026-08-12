import crypto from 'crypto'
import { Service, GuobaError } from '#guoba.framework'
import { cfg, Constant } from '#guoba.platform'
import { randomString, sendToMaster } from '#guoba.utils'
import { getClientIp, normalizeClientIp } from '../../utils/clientIp.js'
import { hashPassword, validatePassword, validateUsername, verifyPassword } from '../../utils/passwordHash.js'

export class LoginSecurityService extends Service {
  get auth() {
    const auth = cfg.get('auth')
    return auth && typeof auth === 'object' ? auth : {}
  }

  get configured() {
    return validateUsername(this.auth.username) && typeof this.auth.passwordHash === 'string' && this.auth.passwordHash.length > 0
  }

  getTrustedIpRecords() {
    const raw = this.auth.trustedIps
    if (!Array.isArray(raw)) return []
    return raw.map(item => {
      if (typeof item === 'string') {
        const ip = normalizeClientIp(item)
        return ip ? {ip} : null
      }
      if (item && typeof item.ip === 'string') {
        const ip = normalizeClientIp(item.ip)
        return ip ? {ip, device: item.device || undefined} : null
      }
      return null
    }).filter(Boolean)
  }

  // 向后兼容：仍可获取纯 IP 字符串列表
  getTrustedIps() {
    return this.getTrustedIpRecords().map(r => r.ip)
  }

  isTrusted(ip) {
    return !!ip && this.getTrustedIpRecords().some(r => r.ip === ip)
  }

  getStatus(req) {
    const ip = getClientIp(req)
    return {
      configured: this.configured,
      captchaRequired: this.configured ? !this.isTrusted(ip) : false,
      ip: ip || '未知',
    }
  }

  setCredentials(username, password, currentPassword = '', req = null) {
    username = typeof username === 'string' ? username.trim() : ''
    if (!validateUsername(username)) throw new GuobaError('用户名长度必须为1至64位')
    if (!validatePassword(password)) throw new GuobaError('密码须为8至128位')
    if (this.configured && !verifyPassword(currentPassword, this.auth.passwordHash)) {
      throw new GuobaError('当前密码错误')
    }
    cfg.set('auth.username', username)
    cfg.set('auth.passwordHash', hashPassword(password))
    if (!Array.isArray(cfg.get('auth.trustedIps'))) cfg.set('auth.trustedIps', [])
    // 设置凭证的人就是本人，直接信任当前IP，退出后重新登录无需再走验证码
    if (req) {
      const ip = getClientIp(req)
      const device = typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
      this.addTrustedIp(ip, device)
    }
    return {configured: true, username}
  }

  /** 主人在聊天里发起的凭证重置：清空账号密码，回到初始化登录流程 */
  resetCredentials() {
    cfg.set('auth.username', '')
    cfg.set('auth.passwordHash', '')
    cfg.set('auth.trustedIps', [])
  }

  captchaKey(ip) {
    const digest = crypto.createHash('sha256').update(ip).digest('hex')
    return `${Constant.REDIS_PREFIX}login-captcha:${digest}`
  }

  cooldownKey(ip) {
    return `${this.captchaKey(ip)}:cooldown`
  }

  attemptsKey(ip) {
    return `${this.captchaKey(ip)}:attempts`
  }

  passwordAttemptsKey(ip) {
    return `${this.captchaKey(ip)}:password-attempts`
  }

  globalCaptchaKey() {
    return `${Constant.REDIS_PREFIX}login-captcha:global`
  }

  async requestCaptcha(req, loginService) {
    const ip = getClientIp(req)
    if (!ip) throw new GuobaError('无法识别访问来源')
    if (this.isTrusted(ip)) throw new GuobaError('当前IP无需验证码')
    const locked = await redis.get(this.attemptsKey(ip))
    if (locked === 'locked') throw new GuobaError('验证码尝试次数过多，请稍后再试')
    const globalCount = await redis.incr(this.globalCaptchaKey())
    if (globalCount === 1) await redis.expire(this.globalCaptchaKey(), Constant.LOGIN_CAPTCHA_COOLDOWN)
    if (globalCount > Constant.LOGIN_CAPTCHA_GLOBAL_LIMIT) {
      throw new GuobaError('验证码请求过于频繁，请稍后再试')
    }
    const cooldown = await redis.set(this.cooldownKey(ip), '1', {NX: true, EX: Constant.LOGIN_CAPTCHA_COOLDOWN})
    if (!cooldown) throw new GuobaError('验证码请求过于频繁，请稍后再试')
    const code = randomString(16)
    const digest = crypto.createHash('sha256').update(code).digest('hex')
    await redis.set(this.captchaKey(ip), digest, {EX: Constant.LOGIN_CAPTCHA_TTL})
    const count = await loginService.sendCodeToMaster(code)
    if (count <= 0) {
      await redis.del(this.captchaKey(ip), this.cooldownKey(ip))
      throw new GuobaError('验证码未能私聊发送给主人，请检查主人账号和 Bot 私聊状态')
    }
    return {pushed: count, expire: Constant.LOGIN_CAPTCHA_TTL}
  }

  async checkCaptcha(ip, code) {
    const key = this.captchaKey(ip)
    const expected = await redis.get(key)
    if (!expected || typeof code !== 'string' || !code) return false
    const actual = crypto.createHash('sha256').update(code.trim()).digest('hex')
    if (crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      await redis.del(key, this.attemptsKey(ip))
      return true
    }
    const attempts = await redis.incr(this.attemptsKey(ip))
    if (attempts >= Constant.LOGIN_CAPTCHA_MAX_ATTEMPTS) {
      await redis.set(this.attemptsKey(ip), 'locked', {EX: Constant.LOGIN_CAPTCHA_LOCK_TTL})
    } else {
      await redis.expire(this.attemptsKey(ip), Constant.LOGIN_CAPTCHA_LOCK_TTL)
    }
    return false
  }

  async addTrustedIp(ip, device) {
    ip = normalizeClientIp(ip)
    if (!ip) return
    const records = this.getTrustedIpRecords()
    if (!records.some(r => r.ip === ip)) {
      const entry = {ip}
      if (device) entry.device = String(device).slice(0, 200)
      cfg.set('auth.trustedIps', [...records, entry])
    }
  }

  async login(req, body, loginService) {
    const ip = getClientIp(req)
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = body?.password
    const captcha = body?.captcha
    if (!ip) throw new GuobaError('无法识别访问来源')
    if (!this.configured) throw new GuobaError('请先由主人配置登录账号和密码')
    const passwordKey = this.passwordAttemptsKey(ip)
    if (await redis.get(passwordKey) === 'locked') throw new GuobaError('登录尝试次数过多，请稍后再试')
    if (!validateUsername(username) || !validatePassword(password)
      || username !== this.auth.username || !verifyPassword(password, this.auth.passwordHash)) {
      const attempts = await redis.incr(passwordKey)
      if (attempts >= Constant.LOGIN_PASSWORD_MAX_ATTEMPTS) {
        await redis.set(passwordKey, 'locked', {EX: Constant.LOGIN_PASSWORD_LOCK_TTL})
      } else {
        await redis.expire(passwordKey, Constant.LOGIN_PASSWORD_LOCK_TTL)
      }
      throw new GuobaError('用户名或密码错误')
    }
    await redis.del(passwordKey)
    if (!this.isTrusted(ip)) {
      if (!await this.checkCaptcha(ip, captcha)) {
        const status = captcha ? '验证码错误或已失效' : '请先获取并输入验证码'
        if (!captcha) return {captchaRequired: true, error: status}
        throw new GuobaError(status)
      }
      const device = typeof req.headers?.['user-agent'] === 'string'
        ? req.headers['user-agent']
        : undefined
      await this.addTrustedIp(ip, device)
    }
    return {token: loginService.signToken(username)}
  }

  getSecurity() {
    return {configured: this.configured, username: this.configured ? this.auth.username : '', trustedIps: this.getTrustedIpRecords()}
  }

  revokeIp(ip) {
    const target = normalizeClientIp(ip)
    cfg.set('auth.trustedIps', this.getTrustedIpRecords().filter(r => r.ip !== target))
    return this.getSecurity()
  }

  clearIps() {
    cfg.set('auth.trustedIps', [])
    return this.getSecurity()
  }
}
