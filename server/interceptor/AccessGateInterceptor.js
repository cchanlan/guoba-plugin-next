import { autowired, Interceptor, Result } from '#guoba.framework'
import { Constant } from '#guoba.platform'
import { normalizeAuthPath } from '../utils/authPath.js'

/**
 * 二级密码拦截器。
 *
 * 排在 TokenInterceptor（priority 100）之后，此时登录态已经校验过：
 * 只有下面这些功能需要额外的解锁凭证；运行日志 / 沙盒在冻结时由
 * AccessFreezeInterceptor 统一拒绝，这里不用重复处理。
 */

/** 需要二级密码的功能 */
const PROTECTED = [
  /^\/api\/file(\/|$)/,
  /^\/api\/data(\/|$)/,
  /^\/api\/term(\/|$)/,
  /^\/api\/chat(\/|$)/,
  // 媒体票据能换出备份下载 / 聊天图片，签发本身必须先过二级密码
  /^\/api\/media-ticket(\/|$)/,
  // 账号管理：Bot 账号 / 好友群列表 / 广播
  /^\/api\/oicq(\/|$)/,
  // 登录安全：改登录密码、可信 IP / 设备都在这里
  /^\/api\/login\/security(\/|$)/,
  // 装插件 / 改插件配置 / 插件动作 = 落地可执行代码
  // 路由默认不启用 strict，/install/ 这种尾斜杠也会命中，必须一起拦
  /^\/api\/plugin\/install(\/|$)/,
  /^\/api\/plugin\/uninstall(\/|$)/,
  /^\/api\/plugin\/update(\/|$)/,
  /^\/api\/plugin\/do(\/|$)/,
  // 用 .* 而不是 [^/]+：%2F 解码后会多出斜杠，插件名非法但路由仍能命中
  /^\/api\/plugin\/s\/.*\/config(\/|$)/,
  // 喵喵帮助的写入类接口（配置、皮肤、备份）；图片与列表读取不拦
  /^\/api\/plugin\/miao\/help\/?$/,
  /^\/api\/plugin\/miao\/help\/preview\/?$/,
  /^\/api\/plugin\/miao\/help\/theme\/config\/?$/,
  /^\/api\/plugin\/miao\/help\/theme\/action(_put)?\/?$/,
  /^\/api\/plugin\/miao\/help\/backup(\/|$)/,
  // 备份还原会覆盖代码和配置
  /^\/api\/backup(\/|$)/,
  // 配置写入能改主人、端口、密钥
  /^\/api\/config(\/|$)/,
  // 系统：全盘目录树、建目录、重启锅巴
  /^\/api\/sys(\/|$)/,
  // 运行日志：读取、清空、清理策略与转发
  /^\/api\/log(\/|$)/,
  // 重启机器人
  /^\/api\/bot(\/|$)/,
  // 沙盒会走一遍插件链路；asset 是 <img> 直接引用，不拦
  /^\/api\/sandbox\/(defaults|rules|match|send)\/?$/,
  // 自定义页面的管理端；asset 由 iframe 直连，不拦
  /^\/api\/custom-page\/store(\/|$)/,
  /^\/api\/custom-page\/reload\/?$/,
]

export default class AccessGateInterceptor extends Interceptor {

  accessGateService = autowired('accessGateService')

  async handler(req, res, next) {
    // 媒体票据（备份下载 / 聊天图片）签发时已经验过二级密码，换票请求不再重复要求
    if (req.authViaTicket) {
      next()
      return
    }
    const path = this.#relativePath(req)
    if (!PROTECTED.some(reg => reg.test(path))) {
      next()
      return
    }

    let status
    try {
      status = await this.accessGateService.checkAccess(req)
    } catch (err) {
      // 校验本身出错时绝不放行，宁可让人刷新重试
      logger.error('[Guoba] 二级密码校验失败')
      logger.error(err)
      return this.#reject(res, Constant.GATE_REQUIRED_CODE, '无法校验二级密码，请刷新重试')
    }

    if (status.needPassword) {
      return this.#reject(res, Constant.GATE_REQUIRED_CODE, '此功能需要二级密码')
    }
    req.gateVerified = status.verified === true
    next()
  }

  #reject(res, code, message, result = {}) {
    // 直接 new Result：Result.error 的参数顺序在框架里有点绕，这里要的是
    // {ok:false, code, result, message} 这个固定结构
    const body = new Result(code, result, message, 403)
    res.status(body.httpStatus).json(body.toJSON())
  }

  /**
   * 归一化到 /api/... 开头的小写路径。
   *
   * Express 路由不区分大小写，二级密码的判定也必须跟着不区分，
   * 否则 /API/file/list 会绕过二级密码（已被实际利用过）。
   */
  #relativePath(req) {
    return normalizeAuthPath(req)
  }

  static priority = 200
}
