import {Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'
import {BotActions} from '#guoba.utils'

/** Bot相关操作 */
export class BotController extends ApiController {

  constructor(guobaApp) {
    super('/bot', guobaApp)
  }

  registerRouters() {
    this.post('/restart', this.doRestart)
  }

  async doRestart() {
    // 不能在这里同步重启：Bot.restart() 在 Linux 上是 process.execve，直接替换当前进程，
    // 这条请求的响应永远送不出去 —— 前端（尤其经反代时）会看到 502，尽管 Bot 其实已经重启了。
    // 先把 200 发回去，重启交给一个延迟任务。
    setTimeout(() => {
      BotActions.doRestart().catch((err) => {
        logger.error(`[Guoba] 重启失败：${err?.stack ?? err}`)
      })
    }, 500)
    return Result.ok({}, '正在重启，请稍候几秒…')
  }

}
