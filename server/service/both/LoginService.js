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
