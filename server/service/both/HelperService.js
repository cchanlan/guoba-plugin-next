import path from 'path'
import fetch from 'node-fetch'
import {Result, Service, GuobaError} from '#guoba.framework';
import {_paths} from '#guoba.platform'
import {readJson} from '#guoba.utils'

export default class HelperService extends Service {
  constructor(app) {
    super(app)
  }

  /** 转发请求 */
  async transitRequest(req, res) {
    let {url} = req.query
    if (!url) {
      return Result.error('url不能为空', 400)
    }
    url = decodeURIComponent(url)
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return Result.error('无效的URL', 400)
    }
    const hostname = parsed.hostname.toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local') ||
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)
    ) {
      return Result.error('禁止访问内部地址', 403)
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return Result.error('仅支持 http/https 协议', 400)
    }
    for (const [name, value] of Object.entries(req.query)) {
      if (name === 'url') {
        continue
      }
      parsed.searchParams.append(name, value)
    }
    let response = await fetch(parsed.toString(), {
      method: req.method,
      body: req.method === 'GET' ? undefined : req.body,
    })
    if (!response.ok) {
      return Result.error('请求失败', response.status)
    }
    for (const [key, value] of response.headers.entries()) {
      // 去掉压缩头
      if (key.toLowerCase() === 'content-encoding') {
        continue
      }
      res.setHeader(key, value)
    }
    let buffer = await response.arrayBuffer()
    buffer = Buffer.from(buffer)
    return buffer
  }

  /** 城市名 → 城市编码，文件不小，读一次缓存住 */
  getCityMap() {
    if (!this._cityMap) {
      let cityJsonPath = path.join(_paths.pluginResources, 'json/city.json')
      this._cityMap = readJson(cityJsonPath)
    }
    return this._cityMap
  }

  /** 全部可选城市名 */
  getCityNames() {
    return Object.keys(this.getCityMap())
  }

  /** 是否是支持的城市（9 位编码也算） */
  isCitySupported(city) {
    if (/^\d{9}$/.test(city)) {
      return true
    }
    return Boolean(this.getCityMap()[city])
  }

  /** 获取天气（中国天气网） */
  async getWeather(city) {
    let cityCode
    if (/^\d{9}$/.test(city)) {
      cityCode = city
    } else {
      cityCode = this.getCityMap()[city]
      if (!cityCode) {
        return `城市${city}不存在或不支持`
      }
    }
    // 原 data/cityinfo 接口已下线：它现在照样返回 200，但内容是一整页 HTML，
    // 直接 response.json() 会抛 SyntaxError。改用仍在服务的 dingzhi 接口，
    // 返回体是 JSONP 风格的 `var cityDZ<code> ={...};var alarmDZ<code> ={...}`，
    // 需要自己把第一段 JSON 抠出来。不带 Referer 会拿到残缺内容。
    let url = `http://d1.weather.com.cn/dingzhi/${cityCode}.html`
    let response
    try {
      response = await fetch(url, {
        headers: {
          'Referer': 'http://www.weather.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        },
      })
    } catch (e) {
      logger.error(e)
      throw new GuobaError('天气接口查询失败，请稍后再试')
    }
    if (response.status !== 200) {
      throw new GuobaError('天气接口查询失败：' + response.status)
    }
    let text = await response.text()
    let matched = text.match(/=\s*(\{.*?\});/)
    let res
    try {
      res = matched ? JSON.parse(matched[1]) : null
    } catch (e) {
      res = null
    }
    if (!res) {
      logger.warn('[Guoba] 天气接口返回格式异常：', text.slice(0, 200))
      throw new GuobaError('获取天气数据失败，请稍后再试')
    }
    // noinspection SpellCheckingInspection
    let {weatherinfo: weatherInfo} = res
    if (weatherInfo) {
      // temp 是白天最高温、tempn 是夜间最低温，均自带 ℃ 单位
      let {cityname, temp, tempn, weather} = weatherInfo
      return `${cityname}今日${weather}，最低温${tempn}，最高温${temp}`
    } else {
      logger.warn('获取天气数据失败', res)
      throw new GuobaError('获取天气数据失败，请稍后再试')
    }
  }

  /** 获取天气 */
  async getWeather_old(city) {
    let url = `http://wthrcdn.etouch.cn/weather_mini?city=${city}`
    let response
    try {
      response = await fetch(url)
    } catch (e) {
      throw new GuobaError('天气接口查询失败，请稍后再试')
    }
    let res = await response.json()
    let {status, data} = res
    if (status === 1000) {
      return data
    } else if (status === 1002) {
      throw new GuobaError(`城市：${city} 数据不存在`)
    } else {
      logger.warn('获取天气数据失败', res)
      throw new GuobaError('获取天气数据失败，请稍后再试')
    }
  }

}