import express from 'express'
import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/** owner 里带这些字符会被 express 当成路由语法，直接拒绝挂载 */
const BAD_SEG = /[:*?+()\[\]]/

/**
 * 页面通过 `ctx.registerApi` 注册的接口，统一挂在 `/api/custom/{owner}` 下。
 * owner 是插件目录名，或面板内建页面的 `_page/{页面id}`。
 *
 * 组件加载顺序是「拦截器 → 服务 → 控制器」（framework/src/loader/loadComponents.js），
 * 本控制器的路由必然晚于 TokenInterceptor 注册，因此天然落在 `^/api/.*` 的鉴权范围内 ——
 * 插件不需要、也不应该自己处理登录校验。
 *
 * 页面的 handler 是原生 express 风格（自己往 res 写），所以这里绕开 RestController 的
 * Result 包装，直接用子 Router 挂载。
 */
export class CustomApiController extends ApiController {

  customPageService = autowired('customPageService')

  constructor(guobaApp) {
    super('/custom', guobaApp)
  }

  registerRouters() {
    /** 已挂载的路由签名，避免 reload 时重复挂同一个路径 */
    this.mounted = new Set()
    this.apiRouter = express.Router()
    this.router.use(this.apiRouter)
    // 插件扫描是异步的，控制器构造时接口还没登记完，这里只能等它
    this.mounting = this.mountApis().catch((e) => {
      logger.error('[Guoba] 挂载自定义接口失败：', e)
    })
  }

  /** 把登记的接口挂到子 Router 上，可重复调用（只挂新增的） */
  async mountApis() {
    const service = autowired('customPageService')
    await service.loading
    for (const {owner, label, method, route} of service.apis) {
      const key = `${method} ${owner} ${route}`
      if (this.mounted.has(key)) continue
      if (BAD_SEG.test(owner)) {
        logger.warn(`[Guoba] 「${label}」的接口前缀含特殊字符，未挂载`)
        this.mounted.add(key)
        continue
      }
      try {
        this.apiRouter[method](`/${owner}${route}`, this.#dispatch(owner, method, route))
        this.mounted.add(key)
      } catch (e) {
        logger.error(`[Guoba] 挂载「${label}」接口 ${method.toUpperCase()} ${route} 失败：`, e.message || e)
        this.mounted.add(key)
      }
    }
  }

  /**
   * 路由指向的是一个固定的转发函数，真正的 handler 每次请求时才从 service 里取。
   * 这样重新扫描后新的 handler 立刻生效，也不用去 express 的路由栈里摘旧的。
   */
  #dispatch(owner, method, route) {
    return (req, res, next) => {
      const api = this.customPageService.apis.find(
        (a) => a.owner === owner && a.method === method && a.route === route,
      )
      // 重新扫描后这个接口被去掉了，当成没这条路由
      if (!api) return next()
      // 依次执行给的 handler，保持 express 的 next() 语义；
      // handler 可能是 async，抛错要自己接住，否则 express 4 收不到
      let i = 0
      const step = (err) => {
        if (err) return this.#fail(api.label, route, err, res, next)
        const fn = api.handlers[i++]
        if (!fn) return next()
        Promise.resolve()
          .then(() => fn(req, res, step))
          .catch((e) => this.#fail(api.label, route, e, res, next))
      }
      step()
    }
  }

  #fail(label, route, e, res, next) {
    logger.error(`[Guoba] 「${label}」接口 ${route} 执行出错：`, e)
    if (res.headersSent) return next(e)
    const result = Result.error(e?.message || '接口执行出错')
    res.status(result.httpStatus).json(result.toJSON())
  }
}
