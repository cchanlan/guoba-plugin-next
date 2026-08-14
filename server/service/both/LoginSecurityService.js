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
    const device = this.verifyDevice(req)
    return {
      configured: this.configured,
      // IP 认得出、或者浏览器里那份设备凭证还有效，都不用再走验证码
      captchaRequired: this.configured ? !this.isTrusted(ip) && !device : false,
      ip: ip || '未知',
      deviceTrusted: !!device,
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
    if (!Array.isArray(cfg.get('auth.trustedDevices'))) cfg.set('auth.trustedDevices', [])
    // 设置凭证的人就是本人，直接信任当前IP和当前浏览器，退出后重新登录无需再走验证码
    let device
    if (req) {
      const ip = getClientIp(req)
      const ua = typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
      this.addTrustedIp(ip, ua)
      device = this.issueDevice(req, this.verifyDevice(req, false))
    }
    return {configured: true, username, device}
  }

  /** 主人在聊天里发起的凭证重置：清空账号密码，回到初始化登录流程 */
  resetCredentials() {
    cfg.set('auth.username', '')
    cfg.set('auth.passwordHash', '')
    cfg.set('auth.trustedIps', [])
    cfg.set('auth.trustedDevices', [])
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

  /* ---------------- 可信设备 ---------------- */

  /**
   * 请求头里带的设备信息。
   *
   * id/secret 是浏览器 localStorage 里存的长期凭证，跟 IP 无关；
   * fp/info 是浏览器指纹，**只用来展示和事后审计**，不参与放行判定
   * —— 浏览器升级、改缩放、换显示器都会让它变，客户端也能随便伪造。
   */
  readDeviceHeaders(req) {
    const pick = (key) => {
      const v = req?.headers?.[key]
      return typeof v === 'string' ? v.trim() : ''
    }
    // header 只认 latin1，中文摘要由前端 encodeURIComponent 过
    let info = pick(Constant.DEVICE_INFO_HEADER)
    if (info) {
      try {
        info = decodeURIComponent(info)
      } catch {
        // 编码坏了就当没有，别影响登录
      }
    }
    return {
      id: pick(Constant.DEVICE_ID_HEADER).slice(0, 64),
      secret: pick(Constant.DEVICE_SECRET_HEADER).slice(0, 128),
      fp: pick(Constant.DEVICE_FP_HEADER).slice(0, 64),
      info: info.slice(0, 200),
      ua: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 200) : '',
    }
  }

  getTrustedDevices() {
    const raw = this.auth.trustedDevices
    if (!Array.isArray(raw)) return []
    return raw
      .map(item => {
        if (!item || typeof item.id !== 'string' || typeof item.secretHash !== 'string') return null
        if (!item.id || !item.secretHash) return null
        return {
          id: item.id,
          secretHash: item.secretHash,
          name: typeof item.name === 'string' ? item.name : '',
          fp: typeof item.fp === 'string' ? item.fp : '',
          ua: typeof item.ua === 'string' ? item.ua : '',
          ip: typeof item.ip === 'string' ? item.ip : '',
          createdAt: Number(item.createdAt) || 0,
          lastAt: Number(item.lastAt) || 0,
        }
      })
      .filter(Boolean)
  }

  #hashSecret(secret) {
    return crypto.createHash('sha256').update(String(secret)).digest('hex')
  }

  #sameHash(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  }

  #saveDevices(list) {
    // 只留最近用过的若干台，按最后使用时间淘汰
    const kept = [...list]
      .sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt))
      .slice(0, Constant.TRUSTED_DEVICE_MAX)
    cfg.set('auth.trustedDevices', kept)
  }

  /**
   * 校验浏览器带来的设备凭证。
   * @param req 请求
   * @param touch 命中后是否更新最后使用时间（带写盘节流）
   * @return 命中的记录，没命中返回 null
   */
  verifyDevice(req, touch = true) {
    const {id, secret, fp, info, ua} = this.readDeviceHeaders(req)
    if (!id || !secret) return null
    const devices = this.getTrustedDevices()
    const hit = devices.find(d => d.id === id && this.#sameHash(d.secretHash, this.#hashSecret(secret)))
    if (!hit) return null
    const now = Date.now()
    // 过期就地清掉，免得配置里堆一堆早就不用的
    if (hit.lastAt && now - hit.lastAt > Constant.TRUSTED_DEVICE_TTL * 1000) {
      this.#saveDevices(devices.filter(d => d.id !== id))
      return null
    }
    if (touch && now - (hit.lastAt || 0) > Constant.TRUSTED_DEVICE_TOUCH_GAP) {
      hit.lastAt = now
      // 指纹/UA/IP 变了也照原样记下来，只为了让人在面板上看出是哪台、有没有异常
      if (fp) hit.fp = fp
      if (info) hit.name = info
      if (ua) hit.ua = ua
      const ip = normalizeClientIp(getClientIp(req))
      if (ip) hit.ip = ip
      this.#saveDevices(devices.map(d => (d.id === id ? hit : d)))
    }
    return hit
  }

  /**
   * 签发（或轮换）设备凭证。
   *
   * 每次登录成功都换一份新 secret：万一旧的被人抄走了，也只能用到下一次登录为止。
   * @return {{id: string, secret: string}} 明文凭证，只在这一次响应里给出去
   */
  issueDevice(req, existing = null) {
    const {id, fp, info, ua} = this.readDeviceHeaders(req)
    const now = Date.now()
    // 这是长期凭证，随机数得是密码学安全的，不能用 randomString（底层是 Math.random）
    const deviceId = existing?.id || id || crypto.randomBytes(12).toString('hex')
    const secret = crypto.randomBytes(32).toString('hex')
    const ip = normalizeClientIp(getClientIp(req)) || ''
    const record = {
      id: deviceId,
      secretHash: this.#hashSecret(secret),
      name: info || ua || '未知设备',
      fp,
      ua,
      ip,
      createdAt: existing?.createdAt || now,
      lastAt: now,
    }
    this.#saveDevices([...this.getTrustedDevices().filter(d => d.id !== deviceId), record])
    return {id: deviceId, secret}
  }

  revokeDevice(id) {
    const target = typeof id === 'string' ? id : ''
    this.#saveDevices(this.getTrustedDevices().filter(d => d.id !== target))
    return this.getSecurity()
  }

  clearDevices() {
    cfg.set('auth.trustedDevices', [])
    return this.getSecurity()
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
    // 设备凭证有效就跳过验证码 —— IP 会漂，浏览器里那份不会
    const known = this.verifyDevice(req, false)
    if (!this.isTrusted(ip) && !known) {
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
    // 每次登录都换一份新的设备凭证，前端存下来，下次换了IP也不用验证码
    return {token: loginService.signToken(username), device: this.issueDevice(req, known)}
  }

  getSecurity() {
    return {
      configured: this.configured,
      username: this.configured ? this.auth.username : '',
      trustedIps: this.getTrustedIpRecords(),
      // 不返回 secretHash，面板上只需要看得出是哪台、什么时候用过
      trustedDevices: this.getTrustedDevices().map(({secretHash, ...rest}) => rest),
    }
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
