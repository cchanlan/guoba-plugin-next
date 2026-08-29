import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 运行日志。
 *
 * 日志由 LogService 在进程内接管 stdout / stderr 收集，存在内存里，这里只做查询。
 * 前端拿上次的 cursor 来要增量，一秒一次轮询，不用维护长连接，经反代也不会被缓冲卡住。
 */
export class LogController extends ApiController {

  logService = autowired('logService')

  constructor(guobaApp) {
    super('/log', guobaApp)
  }

  registerRouters() {
    this.get('/tail', this.tail)
    this.get('/status', this.status)
    this.post('/clear', this.clear)
    this.post('/send-image', this.sendImage)
    this.get('/clean', this.getClean)
    this.put('/clean', this.saveClean)
    this.post('/clean/run', this.runClean)
  }

  /** 日志文件的定时清理设置（连当前占用一起给，页面上要显示能清多少） */
  async getClean() {
    return Result.ok(this.logService.getCleanSettings())
  }

  async saveClean(req) {
    return Result.ok(await this.logService.saveCleanSettings(req.body), '已保存')
  }

  /** 立刻按当前设置清一次磁盘上的日志文件 */
  async runClean() {
    return Result.ok(this.logService.cleanNow(), '清理完成')
  }

  /** 把日志渲染成图私聊发给主人。前端只传行数据，图由服务端用出图模板渲染 */
  async sendImage(req) {
    return Result.ok(await this.logService.sendImage(req.body))
  }

  /**
   * 取日志。
   * `cursor` 为上次返回的游标，不传则取最后 limit 行；level / keyword 为筛选条件。
   */
  async tail(req) {
    const {cursor, limit, level, keyword} = req.query ?? {}
    return Result.ok(this.logService.query(cursor, {limit, level, keyword}))
  }

  async status() {
    return Result.ok(this.logService.status())
  }

  /** 只清面板里缓存的日志，磁盘上的日志文件不动 */
  async clear() {
    return Result.ok(this.logService.clear(), '已清空')
  }
}
