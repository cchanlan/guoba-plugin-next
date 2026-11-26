import crypto from 'crypto'
import { autowired, GuobaError, Service } from '#guoba.framework'
import { cfg, Constant } from '#guoba.platform'
import { sendToMasterUser, sendToOneMaster } from '#guoba.utils'
import { getClientIp } from '../../utils/clientIp.js'
import { hashPassword, validatePassword, verifyPassword } from '../../utils/passwordHash.js'

/**
 * 二级密码。
 *
 * 登录之后，进入文件管理 / 数据浏览 / 终端 / 消息记录还要再输一次这把密码。
 * 任何一次输错都会作废当前登录会话并私聊通知主人；
 * 连续输错 3 次整个面板冻结，只能由主人在聊天里发送 #锅巴解冻 恢复。
 *
 * 解锁凭证是一把随机串，存在 sessionStorage 里随请求头发上来；
 * 服务端把它和当前登录令牌绑定，重新登录后旧凭证自动失效。
 */

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export class AccessGateService extends Service {

  accessFreezeService = autowired('accessFreezeService')
  loginSecurityService = autowired('loginSecurityService')

  get auth() {
    const auth = cfg.get('auth')
    return auth && typeof auth === 'object' ? auth : {}
  }

  /** 二级密码是否已设置 */
  get configured() {
    return typeof this.auth.gatePasswordHash === 'string' && this.auth.gatePasswordHash.length > 0
  }

  /** 登录账号是否已设置（设置二级密码的前提） */
  get loginConfigured() {
    return typeof this.auth.passwordHash === 'string' && this.auth.passwordHash.length > 0
  }

  getLoginToken(req) {
    const fromHeader = req?.headers?.[Constant.TOKEN_KEY]
    if (typeof fromHeader === 'string' && fromHeader) return fromHeader
    const fromQuery = req?.query?.token
    return typeof fromQuery === 'string' ? fromQuery : ''
  }

  /** 解锁凭证：请求头优先，图片/下载这类只能靠 query */
  getGateToken(req) {
    const fromHeader = req?.headers?.[Constant.GATE_TOKEN_KEY]
    if (typeof fromHeader === 'string' && fromHeader) return fromHeader
    const fromQuery = req?.query?.gateToken
    return typeof fromQuery === 'string' ? fromQuery : ''
  }

  gateTokenKey(token) {
    return `${Constant.REDIS_PREFIX}gate-token:${token}`
  }

  attemptsKey(ip) {
    return `${Constant.REDIS_PREFIX}gate:${sha256(ip)}:attempts`
  }

  /** 解锁凭证是否仍然有效（并与当前登录令牌绑定） */
  async isUnlocked(req) {
    const loginToken = this.getLoginToken(req)
    const gateToken = this.getGateToken(req)
    if (!loginToken || !gateToken) return false
    const key = this.gateTokenKey(gateToken)
    const raw = await redis.get(key)
    if (!raw) return false
    // 「记住」的凭证带 r: 前缀，绑定关系还是同一份登录令牌
    const bound = String(raw).startsWith('r:') ? String(raw).slice(2) : String(raw)
    if (bound !== sha256(loginToken)) return false
    this.#renew(gateToken)
    return true
  }

  /** 静默续期，失败不影响本次放行 */
  #renew(gateToken) {
    try {
      const key = this.gateTokenKey(gateToken)
      const promise = (async () => {
        // value 前缀 r: 表示「记住」签发的长期凭证，按长期 TTL 续，别续成 12 小时把它吃掉
        const current = typeof redis.get === 'function' ? await redis.get(key) : null
        if (!current) return
        const longLived = String(current).startsWith('r:')
        const ttl = longLived ? Constant.GATE_UNLOCK_REMEMBER_TTL : Constant.GATE_UNLOCK_TTL
        if (!longLived && typeof redis.ttl === 'function') {
          const remain = await redis.ttl(key)
          if (remain < 0 || remain > Constant.GATE_UNLOCK_RENEW_GAP) return
        }
        if (typeof redis.expire === 'function') {
          await redis.expire(key, ttl)
        } else {
          await redis.set(key, current, { EX: ttl })
        }
      })()
      Promise.resolve(promise).catch(() => {})
    } catch {
      // 续期是副作用，任何异常都不该把一次合法请求打成失败
    }
  }

  /** 未配置密码可以放行普通操作，但不代表此请求已通过二级验证。 */
  async checkAccess(req) {
    if (!this.configured) return { needPassword: false, verified: false }
    const verified = await this.isUnlocked(req)
    return { needPassword: !verified, verified }
  }

  async getStatus(req) {
    const configured = this.configured
    const unlocked = configured ? await this.isUnlocked(req) : true
    const {ipTrusted, deviceTrusted} = this.#trustedSource(req)
    return {
      configured,
      unlocked,
      // 锁定状态由全局冻结接管，保留字段兼容前端
      locked: false,
      lockSeconds: 0,
      // 可信来源才允许「记住这台设备」
      ipTrusted,
      deviceTrusted,
      trusted: ipTrusted || deviceTrusted,
    }
  }

  /** 来源是不是可信 IP / 可信设备（失败一律按不可信处理） */
  #trustedSource(req) {
    try {
      const ipTrusted = !!this.loginSecurityService?.isTrusted?.(getClientIp(req))
      const deviceTrusted = !!this.loginSecurityService?.verifyDevice?.(req, false)
      return {ipTrusted, deviceTrusted}
    } catch {
      return {ipTrusted: false, deviceTrusted: false}
    }
  }

  /** 校验二级密码并签发解锁凭证 */
  async unlock(req, body) {
    const ip = getClientIp(req)
    if (!ip) throw new GuobaError('无法识别访问来源')
    if (!this.configured) throw new GuobaError('尚未设置二级密码')
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!verifyPassword(password, this.auth.gatePasswordHash)) {
      const failure = await this.#recordFailure(req, ip)
      // 输错就踹：这次登录立刻作废，前端下一次请求会被 401 送回登录页
      await this.#kickSession(req)
      if (failure.frozen) {
        const error = new GuobaError('二级密码错误次数过多，锅巴已冻结，请主人发送 #锅巴解冻 恢复')
        error.gateKicked = true
        error.frozen = true
        throw error
      }
      this.#notifyOwner(req, ip)
      const error = new GuobaError('二级密码错误，已退出登录')
      error.gateKicked = true
      throw error
    }
    await this.#clearAttempts(ip)
    const loginToken = this.getLoginToken(req)
    if (!loginToken) throw new GuobaError('登录态失效')
    // 只有在可信设备 / 可信 IP 上才允许「记住」，其他地方最多解锁 12 小时
    const {ipTrusted, deviceTrusted} = this.#trustedSource(req)
    const remember = body?.remember === true && (ipTrusted || deviceTrusted)
    const ttl = remember ? Constant.GATE_UNLOCK_REMEMBER_TTL : Constant.GATE_UNLOCK_TTL
    const gateToken = crypto.randomBytes(32).toString('hex')
    await redis.set(this.gateTokenKey(gateToken), (remember ? 'r:' : '') + sha256(loginToken), { EX: ttl })
    return { gateToken, remember, ttl }
  }

  /** 让当前登录令牌立即失效（不影响其它设备上的登录） */
  async #kickSession(req) {
    const loginToken = this.getLoginToken(req)
    if (!loginToken) return
    try {
      await redis.del(`${Constant.REDIS_PREFIX}access-token:${loginToken}`)
    } catch (error) {
      logger.error('[Guoba] 踢出登录会话失败')
      logger.error(error)
    }
  }

  /** 二级密码输错时私聊通知主人 */
  #notifyOwner(req, ip) {
    try {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
        + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
      const lines = [
        '[锅巴面板] 二级密码输入错误，当前登录已被强制退出。',
        `时间：${time}`,
        `来源 IP：${ip || '未知'}`,
      ]
      const ua = req?.headers?.['user-agent']
      if (typeof ua === 'string' && ua) {
        lines.push(`设备：${ua.length > 160 ? ua.slice(0, 160) + '…' : ua}`)
      }
      const message = lines.join('\n')
      const target = cfg.get('auth.securityMaster')
      // 指定了安全通知接收人时只发给他，发送失败也不改发其他主人
      Promise.resolve(target
        ? sendToMasterUser(message, target)
        : sendToOneMaster(message)).catch(() => {})
    } catch (error) {
      // 通知失败只记日志，不能影响「输错就踢」本身的流程
      logger.error('[Guoba] 二级密码错误通知发送失败')
      logger.error(error)
    }
  }

  /** 二级密码被设置 / 修改 / 重置 / 关闭时私聊通知主人 */
  #notifyCredentialChange(action, req) {
    try {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
        + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
      const lines = [
        `[锅巴面板] 二级密码${action}。`,
        `时间：${time}`,
        `来源 IP：${getClientIp(req) || '未知'}`,
      ]
      const ua = req?.headers?.['user-agent']
      if (typeof ua === 'string' && ua) {
        lines.push(`设备：${ua.length > 160 ? ua.slice(0, 160) + '…' : ua}`)
      }
      const message = lines.join('\n')
      const target = cfg.get('auth.securityMaster')
      // 指定了安全通知接收人时只发给他，发送失败也不改发其他主人
      Promise.resolve(target
        ? sendToMasterUser(message, target)
        : sendToOneMaster(message)).catch(() => {})
    } catch (error) {
      // 通知失败只记日志，不能影响密码本身已经改好的结果
      logger.error('[Guoba] 二级密码变更通知发送失败')
      logger.error(error)
    }
  }

  /** 失败一次；到第 3 次整个面板冻结 */
  async #recordFailure(req, ip) {
    const attempts = await redis.incr(this.attemptsKey(ip))
    if (attempts >= Constant.FREEZE_MAX_ATTEMPTS) {
      await this.accessFreezeService.freeze('二级密码连续输错 3 次', {
        ip,
        ua: req?.headers?.['user-agent'],
      })
      await redis.del(this.attemptsKey(ip))
      return { frozen: true }
    }
    await redis.expire(this.attemptsKey(ip), Constant.GATE_PASSWORD_ATTEMPT_WINDOW)
    return { frozen: false, attempts }
  }

  async #clearAttempts(ip) {
    if (!ip) return
    await redis.del(this.attemptsKey(ip))
  }

  /** 删除一批 key，老宿主可能没有 keys/scan，清不掉也不影响主流程 */
  async #deleteByPattern(pattern) {
    try {
      const keys = await redis.keys?.(pattern)
      if (Array.isArray(keys) && keys.length) {
        await Promise.all(keys.map(key => redis.del(key)))
      }
    } catch {
      // 忽略
    }
  }

  /** 所有解锁凭证作废（改密码 / 关密码时用） */
  async #clearTokens() {
    await this.#deleteByPattern(`${Constant.REDIS_PREFIX}gate-token:*`)
  }

  /** 清掉解锁凭证与所有 IP 的失败计数 */
  async #clearAll() {
    await this.#clearTokens()
    await this.#deleteByPattern(`${Constant.REDIS_PREFIX}gate:*`)
  }

  /** 设置或修改二级密码，需要验证当前登录密码 */
  async setPassword(currentPassword, password, req) {
    if (!this.loginConfigured) throw new GuobaError('请先设置登录账号密码')
    const wasConfigured = this.configured
    await this.loginSecurityService.verifyPasswordForSensitiveAction(req, currentPassword)
    if (!validatePassword(password)) throw new GuobaError('二级密码须为8至128位')
    if (verifyPassword(password, this.auth.passwordHash)) throw new GuobaError('二级密码不能与登录密码相同')
    cfg.set('auth.gatePasswordHash', hashPassword(password))
    await this.#clearAll()
    this.#notifyCredentialChange(wasConfigured ? '已修改' : '已设置', req)
    // 设置完不给当前会话发解锁凭证：下一次进入敏感页面必须真正输入二级密码
    return { configured: true, unlocked: false, locked: false, lockSeconds: 0 }
  }

  /** 关闭二级密码，需要验证当前登录密码 */
  async clearPassword(currentPassword, req) {
    if (!this.loginConfigured) throw new GuobaError('请先设置登录账号密码')
    await this.loginSecurityService.verifyPasswordForSensitiveAction(req, currentPassword)
    cfg.set('auth.gatePasswordHash', '')
    await this.#clearAll()
    this.#notifyCredentialChange('已关闭', req)
    return { configured: false, unlocked: true, locked: false, lockSeconds: 0 }
  }

  /**
   * 忘记二级密码时的兜底：用登录密码直接重置。
   *
   * 只有已登录的会话才能调到这里；登录密码错误同样计入失败次数，
   * 连错 3 次照样冻结整个面板。
   */
  async resetPassword(req, loginPassword, password) {
    if (!this.loginConfigured) throw new GuobaError('请先设置登录账号密码')
    if (!this.configured) throw new GuobaError('尚未设置二级密码')
    await this.loginSecurityService.verifyPasswordForSensitiveAction(req, loginPassword)
    if (!validatePassword(password)) throw new GuobaError('新二级密码须为8至128位')
    if (verifyPassword(password, this.auth.passwordHash)) throw new GuobaError('二级密码不能与登录密码相同')
    cfg.set('auth.gatePasswordHash', hashPassword(password))
    await this.#clearAll()
    this.#notifyCredentialChange('已通过登录密码重置', req)
    // 重置后同样不自动解锁，用新密码重新验证
    return { configured: true, unlocked: false, locked: false, lockSeconds: 0 }
  }
}
