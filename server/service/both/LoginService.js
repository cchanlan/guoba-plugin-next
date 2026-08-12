import jwt from 'jsonwebtoken'
import {GuobaError, Service} from '#guoba.framework';
import {cfg, Constant} from "#guoba.platform";
import {getAllWebAddress, randomString, sendToMaster} from '#guoba.utils'

export class LoginService extends Service {
  constructor(app) {
    super(app)
  }

  /** 注册并保存Token */
  signToken(username) {
    let token = jwt.sign({username}, cfg.getJwtSecret())
    // 将token存入redis
    let redisKey = this.getRedisKey(token)
    redis.set(redisKey, token, {EX: 3600 * 24})
    return token
  }

  logout(token) {
    if (token) {
      let redisKey = this.getRedisKey(token)
      redis.del(redisKey)
    }
  }

  /** 仅获取面板地址，不签发任何令牌（已启用账号密码登录时用） */
  async getWebAddress() {
    return getAllWebAddress()
  }

  async setQuickLogin(username) {
    let {redisKey, code} = this.getQuickLoginRedisKey(null)
    let token = this.signToken(username)
    redis.set(redisKey, token, {EX: 180})
    // 地址保持干净，不再拼接临时令牌路径，令牌单独发送，在登录页输入即可
    let webAddress = await getAllWebAddress()
    return {webAddress, code}
  }

  async getQuickLogin(code) {
    if (!code) {
      throw new GuobaError('登录失败')
    }
    let {redisKey} = this.getQuickLoginRedisKey(code)
    let token = await redis.get(redisKey)
    if (token) {
      redis.del(redisKey)
      return {token}
    }
    throw new GuobaError('登录失败')
  }

  /* ---------------- 聊天确认登录 ---------------- */

  /** 待确认登录请求的有效期（秒） */
  static CONFIRM_EXPIRE = 120

  getConfirmRedisKey(id) {
    return `${Constant.REDIS_PREFIX}login-confirm:${id}`
  }

  /**
   * 前端发起一个待确认的登录请求，等主人发「#锅巴确认登录」批准。
   * @param ip 请求来源IP，供主人核对
   */
  async createConfirmRequest(ip) {
    const id = randomString(16)
    // 4位短码，同时有多个请求等待时用来区分
    const code = randomString(4).toUpperCase()
    const data = {id, code, ip: ip || '未知', status: 'pending', token: ''}
    await redis.set(this.getConfirmRedisKey(id), JSON.stringify(data), {
      EX: LoginService.CONFIRM_EXPIRE,
    })
    return {id, code, expire: LoginService.CONFIRM_EXPIRE}
  }

  /** 取出所有还在等待确认的请求 */
  async listPendingConfirms() {
    const keys = await redis.keys(this.getConfirmRedisKey('*'))
    const list = []
    for (const key of keys ?? []) {
      try {
        const data = JSON.parse(await redis.get(key))
        if (data?.status === 'pending') list.push(data)
      } catch {
        // 坏数据直接忽略
      }
    }
    return list
  }

  /** 前端轮询：批准后返回token，该token只能取一次 */
  async pollConfirmRequest(id) {
    if (!id) throw new GuobaError('登录请求不存在或已过期')
    const key = this.getConfirmRedisKey(id)
    const raw = await redis.get(key)
    if (!raw) throw new GuobaError('登录请求不存在或已过期')
    const data = JSON.parse(raw)
    if (data.status === 'approved') {
      await redis.del(key)
      return {status: 'approved', token: data.token}
    }
    return {status: 'pending', token: ''}
  }

  /**
   * 主人确认登录。
   * @param username 主人标识，用于签发token
   * @param code 可选的短码；同时有多个待确认请求时必须指定
   * @return {Promise<{ok: boolean, reason?: string, ip?: string, codes?: string[]}>}
   */
  async confirmLogin(username, code) {
    const pending = await this.listPendingConfirms()
    if (pending.length === 0) {
      return {ok: false, reason: 'none'}
    }
    let target
    if (code) {
      target = pending.find(i => i.code === String(code).toUpperCase())
      if (!target) return {ok: false, reason: 'code', codes: pending.map(i => i.code)}
    } else if (pending.length > 1) {
      // 不确定该批准哪个，让主人带上短码，避免误批准他人的请求
      return {ok: false, reason: 'multi', codes: pending.map(i => i.code)}
    } else {
      target = pending[0]
    }
    target.status = 'approved'
    target.token = this.signToken(username)
    // 保留原有过期时间：批准后前端还得来取一次
    await redis.set(this.getConfirmRedisKey(target.id), JSON.stringify(target), {
      EX: LoginService.CONFIRM_EXPIRE,
    })
    return {ok: true, ip: target.ip, code: target.code}
  }

  getQuickLoginRedisKey(code) {
    if (!code) {
      code = randomString(6)
    }
    return {
      code,
      redisKey: `${Constant.REDIS_PREFIX}login-quick:${code}`,
    }
  }

  async codeLoginRequest() {
    let redisKey = `${Constant.REDIS_PREFIX}login-code`
    let code = await redis.get(redisKey)
    if (code) {
      throw new GuobaError('当前验证码还未失效，请稍后再试')
    } else {
      code = randomString(16)
    }
    await redis.set(redisKey, code, {EX: 300})
    return code
  }

  /**
   * 把登录验证码私聊发给主人。
   * 文案与验证码分成两条，方便手机端长按复制。
   * @return {Promise<number>} 收到消息的主人数量
   */
  async sendCodeToMaster(code) {
    try {
      let count = await sendToMaster('[锅巴面板] 您正在请求验证码登录，验证码五分钟内有效：')
      if (count > 0) {
        await sendToMaster(code)
        await sendToMaster('若非本人操作请忽略，并检查登录地址是否泄露。')
      }
      return count
    } catch (err) {
      logger.error('[Guoba] 验证码私发主人失败')
      logger.error(err)
      return 0
    }
  }

  async codeLoginCheck(code) {
    if (!code || typeof code !== 'string') {
      return false
    }
    let redisKey = `${Constant.REDIS_PREFIX}login-code`
    let redisCode = await redis.get(redisKey)
    if (!redisCode) {
      return false
    }
    if (redisCode === code) {
      await redis.del(redisKey)
      return await this.signToken('admin')
    }
    return false
  }

  getRedisKey(token) {
    return `${Constant.REDIS_PREFIX}access-token:${token}`
  }
}
