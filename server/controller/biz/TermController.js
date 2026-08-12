import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 终端。
 *
 * 命令在面板进程所在环境执行，等同服务器 shell —— 只有登录面板的人能碰
 * （TokenInterceptor 全局鉴权）。危险命令的确认由前端弹框。
 */
export class TermController extends ApiController {

  termService = autowired('termService')

  constructor(guobaApp) {
    super('/term', guobaApp)
  }

  registerRouters() {
    this.post('/exec', this.exec)
    this.get('/tail', this.tail)
    this.post('/interrupt', this.interrupt)
    this.post('/restart', this.restart)
    this.get('/status', this.status)
  }

  /** 执行一条命令，写入 shell 的 stdin */
  async exec(req) {
    const {cmd} = req.body ?? {}
    return Result.ok(this.termService.exec(cmd))
  }

  /** 增量拉取输出，cursor 游标 */
  async tail(req) {
    const {cursor} = req.query ?? {}
    return Result.ok(this.termService.query(cursor))
  }

  /** 中断当前前台进程（键盘 Ctrl+C 的等价） */
  async interrupt() {
    return Result.ok(this.termService.interrupt())
  }

  /** 重启 shell 会话（清空输出） */
  async restart() {
    return Result.ok(this.termService.restart())
  }

  /** 会话信息 */
  async status() {
    return Result.ok(this.termService.status())
  }

}
