import {cfg} from '#guoba.platform'
import {WebShot} from '#guoba.utils'

/**
 * 网页截图：群里发个网址，截一张图预览。
 *
 * **默认关闭**，要用得先去锅巴面板「网页截图」里打开 —— 这个功能会让服务器去访问
 * 群友随手发的任意地址，默认开着不合适。
 *
 * 逻辑都在 utils/webShot.js，这里只管开关、取配置、回消息。
 */
export class GuobaWebShot extends plugin {

  constructor() {
    super({
      name: '锅巴网页截图',
      dsc: '群里发网页地址，截图预览网页内容',
      event: 'message',
      /**
       * 跟碎月那版保持一致的 1006。
       * 别调小：视频解析类插件（抖音、B 站链接）priority 比这个小，
       * 抢在它们前面会把该解析的链接截成图
       */
      priority: 1006,
      rule: [
        {
          reg: '^(?:(http|https):\\/\\/)?((?:[\\w-]+\\.)+[a-z0-9]+)((?:\\/[^\\/?#]*)+)?(\\?[^#]+)?(#.+)?$',
          fnc: 'webShot'
        },
        {
          reg: '^#*百度(.*)$',
          fnc: 'baiduWeb'
        }
      ]
    })
  }

  /** 取配置，缺的字段拿默认值兜住 */
  get config() {
    return {...WebShot.DEFAULT_CONFIG, ...(cfg.get('webShot') || {})}
  }

  /** 群友发链接 → 安全校验 → 截图 */
  async webShot(e) {
    const config = this.config
    // 关掉的时候要静默放行，让别的插件还能处理这条消息
    if (!config.enable) return false

    // 正则允许不带协议的裸域名，只在完全没写协议时补全
    let raw = e.msg.trim()
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw

    const check = await WebShot.checkUrl(raw, config)
    if (!check.ok) {
      await this.reply(check.reason)
      return true
    }

    try {
      await this.reply(segment.image(await WebShot.screenshot(check.url, config)))
    } catch (err) {
      await this.replyError(err, check.url)
    }
    return true
  }

  /** #百度 关键词 → 截搜索结果页，或跳进第一个匹配的结果 */
  async baiduWeb(e) {
    const config = this.config
    if (!config.enable) return false

    const words = e.msg.replace(/#|百度/gm, '').replace(/，| |,/g, ',').split(',').filter(Boolean)
    const [searchKey, keyWd] = words.length > 1 ? words : [words[0], '']
    const weburl = `https://www.baidu.com/s?wd=${encodeURIComponent(searchKey || '')}`

    try {
      await this.reply(segment.image(await WebShot.baiduScreenshot(weburl, keyWd, config)))
    } catch (err) {
      await this.replyError(err, weburl)
    }
    return true
  }

  /** 失败和「不值当发图」分开说：后者不是故障，日志记一行就够，别按报错刷栈 */
  async replyError(err, url) {
    if (err.unworthy) {
      logger.mark(`[Guoba] 网页截图不发图(${err.kind}) ${url} ${err.message}`)
      await this.reply(WebShot.UNWORTHY_TIP[err.kind] || '这个网页没截到有用的内容，就不发图了')
      return
    }
    logger.error(`[Guoba] 网页截图失败 ${url}: `, err)
    if (/最终地址被拦截|ERR_BLOCKED_BY_CLIENT/.test(String(err.message))) {
      await this.reply('这个网页会跳到内网地址，不解析哦')
    } else {
      await this.reply('截图失败了，网页可能打不开或加载超时')
    }
  }
}
