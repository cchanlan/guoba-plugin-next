import jwt from 'jsonwebtoken'
import {autowired, Interceptor, Result} from "#guoba.framework";
import {_paths, cfg, Constant} from "#guoba.platform";

// 弱令牌（只能用来访问静态资源等）
const liteInclude = [
  new RegExp('^/api/plugin/miao/help/theme/.+'),
  new RegExp('^/api/custom-page/asset/[^/]+/.+'),
]

// 需要拦截的路径
const include = [
  new RegExp('^/api/.*'),
  ...liteInclude,
]

// 不需要拦截的路径
const exclude = [
  new RegExp('^/api/login'),
  new RegExp('^/api/helper/transit'),
  new RegExp('^/api/helper/release_port'),
  new RegExp('^/api/plugin/s/.+/icon'),
]

/**
 * Token校验拦截器
 * @param app
 */
export default class TokenInterceptor extends Interceptor {

  systemService = autowired('systemService')

  constructor(app) {
    super(app)
  }

  async handler(req, res, next) {
    if (!include.find(reg => this.check(reg, req))) {
      next()
    } else if (exclude.find(reg => this.check(reg, req))) {
      next()
    } else {
      // 从query里获取token
      let token = req.query?.token
      if (!token) {
        token = req.headers[Constant.TOKEN_KEY]
      }
      // iframe 里的 css/js 由浏览器按相对路径请求，带不上请求头，只能从Cookie里取。
      // 浏览器会自动携带Cookie，所以只在弱令牌路径上认它，不给其他接口留CSRF口子。
      let fromCookie = false
      if (!token && liteInclude.find(reg => this.check(reg, req))) {
        token = this.#readCookie(req, Constant.LITE_TOKEN_COOKIE)
        fromCookie = !!token
      }
      if (token) {
        // 判断是否是弱令牌
        if (token.length === 8 && token === this.systemService.getLiteToken()) {
          if (liteInclude.find(reg => this.check(reg, req))) {
            next()
            return
          }
        } else if (fromCookie) {
          // Cookie里只该放弱令牌，放了别的一律不认
        } else {
          let redisKey = Constant.REDIS_PREFIX + 'access-token:' + token
          let redisToken = await redis.get(redisKey)
          if (redisToken) {
            try {
              jwt.verify(redisToken, cfg.getJwtSecret())
              next()
              return
            } catch {
            }
          }
        }
      }
      let result = Result.noLogin()
      res.status(result.httpStatus).json(result.toJSON())
    }
  }

  /** 读一个Cookie，只这一处用得上，就不引 cookie-parser 了 */
  #readCookie(req, name) {
    const raw = req.headers?.cookie
    if (!raw) return null
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=')
      if (idx < 0) continue
      if (part.slice(0, idx).trim() === name) {
        return decodeURIComponent(part.slice(idx + 1).trim())
      }
    }
    return null
  }

  /**
   * 检查是否reg是否通过校验，兼容自定义前缀
   * @param {RegExp} reg
   * @param {Request} req
   */
  check(reg, req) {
    const {realMountPrefix} = _paths.server
    let {path} = req
    if (path.startsWith(realMountPrefix)) {
      path = path.substring(realMountPrefix.length)
    }
    return reg.test(path)
  }

  static priority = 100
}
