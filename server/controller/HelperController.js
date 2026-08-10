import {autowired, Result} from '#guoba.framework'
import {ApiController, cfg} from '#guoba.platform'
import net from 'net'

const RedisDecorator = await Guoba.GID('#/decorator/RedisDecorator.js')

/**
 * 工具类Controller
 */
export default class HelperController extends ApiController {

  helperService = autowired('helperService')

  constructor(guobaApp) {
    super('/helper', guobaApp)
  }

  registerRouters() {
    // 中转请求，绕过跨域和防盗链
    this.all('/transit', this.transitRequest)
    // 获取天气信息（缓存6小时）
    this.get('/city_weather', this.getCityWeather, [
      new RedisDecorator('city_weather:${config.getCity()}', {EX: 60 * 60 * 6, getCity: this.getCity}),
    ])
    // 本地尝试释放端口
    // 假设用户关闭yunzai时，没有关干净，导致端口号被异常占用
    // 此时另一方启动的锅巴可以尝试调用此接口，来关闭当前的端口占用
    // 安全性：仅限 localhost 访问
    this.delete('/release_port', this.tryReleasePort)
    // 天气城市的读取与切换
    this.get('/city', this.getCityInfo)
    this.post('/city', this.setCity)
    // 城市候选（供前端搜索选择）
    this.get('/city/options', this.getCityOptions)
  }

  transitRequest(req, res) {
    return this.helperService.transitRequest(req, res)
  }

  getCity() {
    return cfg.get('base.city')
  }

  /** 当前配置的城市 */
  getCityInfo() {
    return Result.ok({city: this.getCity()})
  }

  /** 切换城市。缓存 key 里带城市名，换了城市自然命中不同 key，无需手动清理 */
  setCity(req) {
    const city = String(req.body?.city ?? '').trim()
    if (!city) {
      return Result.error('城市不能为空', 400)
    }
    if (!this.helperService.isCitySupported(city)) {
      return Result.error(`城市 ${city} 不存在或不支持`, 400)
    }
    cfg.set('base.city', city)
    return Result.ok({city})
  }

  /** 全部可选城市名，前端本地搜索 */
  getCityOptions() {
    return Result.ok(this.helperService.getCityNames())
  }

  async getCityWeather() {
    try {
      let city = this.getCity()
      return Result.ok({
        weather: await this.helperService.getWeather(city),
      })
    } catch (e) {
      logger.error(e)
      let msg = e.message || e
      return Result.error(msg)
    }
  }

  tryReleasePort(req) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      return Result.noAuth()
    }
    logger.mark('[Guoba] 服务已在另一处启动，正在尝试停止当前服务……')
    setTimeout(() => {
      Guoba.server.close(err => {
        if (err) {
          logger.mark('[Guoba] 服务停止失败')
          logger.error(err)
        } else {
          logger.mark('[Guoba] 已停止当前服务，您如果想要多开锅巴，请更改不同的端口号~')
        }
      })
    }, 10)
    return Result.ok()
  }
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) {
    return false
  }

  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackAddress(normalized.substring(7))
  }
  if (!net.isIPv4(normalized)) {
    return false
  }
  return normalized.split('.')[0] === '127'
}
