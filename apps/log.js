import {autowired} from '#guoba.framework'
import {formatLogText, makeForwardMsg, mergeLogLines, renderLogImage} from '#guoba.utils'

/**
 * 运行日志默认发多少条。
 *
 * 一条日志在图上大约 110px 高，30 条就快 3500px 了 —— 再长会超过 QQ 那边约 4096 的
 * 长边上限被压缩，字就糊了。要更多条自己在指令后面加数字。
 */
const DEFAULT_LIMIT = 30
/** 错误日志默认发多少条 —— 错误往往带一长串堆栈，条数少点才看得清 */
const DEFAULT_ERROR_LIMIT = 10
/** 手动指定条数的上限：再多图就太长了，宿主截图也有高度上限 */
const MAX_LIMIT = 100
/** 向 LogService 多要几倍的行：续行（堆栈）会被合并，行数不等于条数 */
const LINE_FACTOR = 3
/** LogService.query 单次能给的最大行数 */
const MAX_LINES = 2000

/**
 * 锅巴日志。
 *
 * 日志取自锅巴的 LogService（进程内接管 stdout / stderr 收下来的，info 及以下也有，
 * 比磁盘上的 command.log 全），出图跟面板里「发给主人」共用一套模板。
 */
export class GuobaLog extends plugin {

  logService = autowired('logService')

  constructor() {
    super({
      name: '锅巴日志',
      dsc: '把锅巴收集的运行日志渲染成图片',
      event: 'message',
      priority: 100,
      rule: [
        {
          reg: '^#锅巴(运行|错误)?日志\\s*(\\d+)?$',
          fnc: 'sendLogImage',
          permission: 'master',
        },
      ],
    })
  }

  async sendLogImage() {
    const isError = this.e.msg.includes('错误')
    const num = this.e.msg.match(/\d+/)
    const fallbackLimit = isError ? DEFAULT_ERROR_LIMIT : DEFAULT_LIMIT
    const count = Math.min(Math.max(num ? Number(num[0]) : fallbackLimit, 1), MAX_LIMIT)

    let lines
    try {
      const res = this.logService.query(undefined, {
        limit: Math.min(count * LINE_FACTOR, MAX_LINES),
        level: isError ? 'error' : 'all',
      })
      lines = res.lines
    } catch (err) {
      // autowired 是懒解析的代理，服务没起来时取属性就抛
      logger.debug(`[Guoba] 取日志失败：${err?.message}`)
      return this.reply('锅巴服务似乎没有启动，取不到日志~')
    }

    /*
     * 级别筛选是「该级别及以上」，而 mark 在 log4js 里级别最高、任何筛选下都保留
     * （云崽用它打启动信息）。要「错误日志」时那些 mark 是噪音，再滤一遍。
     */
    if (isError) {
      lines = lines.filter((it) => it.level === 'error' || it.level === 'fatal')
    }

    const items = mergeLogLines(lines, count)
    if (!items.length) {
      return this.reply(isError ? '暂无错误日志~' : '暂无日志数据~')
    }

    const title = isError ? '锅巴错误日志' : '锅巴日志'
    const res = await renderLogImage(items, {title})
    if (res?.image) {
      return this.reply(res.image)
    }

    // 渲染器不可用或出图失败，退回文本，日志本身不能因为出不了图就看不到
    return this.reply(await makeForwardMsg(this.e, [formatLogText(items)], title))
  }
}
