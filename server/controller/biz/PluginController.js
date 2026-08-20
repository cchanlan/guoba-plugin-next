import {autowired, Result} from '#guoba.framework';
import {ApiController, GuobaSupportMap, cfg} from '#guoba.platform'

/**
 * 按路径取值，同时支持嵌套格式（{ a: { b: 1 } }）和扁平格式（{ "a.b": 1 }）。
 * 扁平格式优先：若对象本身以 path 为 key 则直接返回。
 */
function getFieldPath(obj, path) {
  if (obj == null || path == null) return undefined
  if (Object.hasOwn(obj, path)) return obj[path]
  const parts = path.split('.')
  let cur = obj
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * 根据schema field将嵌套对象还原为扁平格式 { field: value }。
 *
 * 新版锅巴UI使用lodash.set把带点号的field（如 "apps.avatarList"）展开为嵌套对象，
 * 而旧版插件setConfigData期望的是扁平格式 { "apps.avatarList": value }。
 * 此函数根据schema定义把嵌套对象还原为扁平格式，保证向下兼容。
 * 若数据本身已是扁平格式则原样保留。
 */
function flattenConfigData(data, schemas) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  if (!schemas || !schemas.length) return data
  const result = {}
  for (const schema of schemas) {
    const field = schema?.field
    if (!field) continue
    const value = getFieldPath(data, field)
    if (value !== undefined) {
      result[field] = value
    }
  }
  return result
}

export default class PluginController extends ApiController {

  pluginService = autowired('pluginService')
  pluginUpdateService = autowired('pluginUpdateService')

  constructor(guobaApp) {
    super('/plugin', guobaApp)
  }

  registerRouters() {
    // 获取plugin列表
    this.get('/list', this.getPlugins)
    // 获取plugin readme
    this.get('/readme', this.getPluginReadme)

    // 安装plugin
    this.put('/install', this.installPlugin)
    // 卸载plugin
    this.put('/uninstall', this.uninstallPlugin)

    // 更新：list 只读本地 git 状态（快），check 才联网 fetch；两个耗时操作都是后台任务 + 轮询
    this.get('/update/list', this.updateList)
    this.post('/update/check', this.updateCheck)
    this.post('/update/run', this.updateRun)
    this.get('/update/task', this.updateTask)
    this.post('/update/cancel', this.updateCancel)
    this.post('/update/rollback', this.updateRollback)

    // 获取plugin icon（直接显示图片）
    this.get('/s/:pluginName/icon', this.getPluginIcon)
    // 获取plugin配置数据
    this.get('/s/:pluginName/config', this.getPluginConfig)
    // 设置plugin配置数据
    this.put('/s/:pluginName/config', this.setPluginConfig)

    // 执行操作
    this.post('/do/:pluginName/action', this.doAction)
  }

  /** 插件的 git 状态。不联网，behind 是上次 fetch 时的数据 */
  async updateList() {
    return Result.ok(await this.pluginUpdateService.list())
  }

  /** 起一个检查更新任务（联网 fetch），立刻返回，进度靠 /update/task 轮询 */
  async updateCheck(req) {
    const {names} = req.body ?? {}
    return Result.ok(this.pluginUpdateService.check(names))
  }

  /** 起一个更新任务 */
  async updateRun(req) {
    const {names, mode, npmInstall, restart} = req.body ?? {}
    return Result.ok(this.pluginUpdateService.update({names, mode, npmInstall, restart}))
  }

  /** 任务状态 + 增量日志 */
  async updateTask(req) {
    return Result.ok(this.pluginUpdateService.taskStatus(req.query?.cursor))
  }

  /** 取消正在跑的任务 */
  async updateCancel() {
    return Result.ok(this.pluginUpdateService.cancel(), '已请求取消')
  }

  /** 回滚到本次更新之前的 commit */
  async updateRollback(req) {
    const {name} = req.body ?? {}
    const data = await this.pluginUpdateService.rollback(name)
    return Result.ok(data, `已回滚到 ${data.commit}，重启后生效`)
  }

  /**
   * 获取插件列表
   * @param req.query.force 是否清空缓存强制刷新
   * @return {Promise<Result>}
   */
  async getPlugins(req) {
    let {force} = req.query
    force = force === 'true'
    let data = await this.pluginService.getPlugins(force)
    return Result.ok(data)
  }

  async getPluginReadme(req) {
    let {link, force} = req.query
    force = force === 'true'
    let text = await this.pluginService.getReadmeText(link, force)
    return Result.ok(text)
  }

  async installPlugin(req) {
    let {link, autoRestart = true, autoNpmInstall = true} = req.body
    if (!link || typeof link !== 'string') {
      return Result.error('link不能为空')
    }
    link = link.trim()
    if (/[;&|`$(){}#!<>]/.test(link)) {
      return Result.error('链接包含非法字符')
    }
    const whitelist = cfg.get('base.gitInstallWhitelist') || ['github.com', 'gitee.com', 'gitlab.com', 'gitcode.com']
    let parsed
    try {
      parsed = new URL(link)
    } catch {
      return Result.error('无效的仓库地址')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return Result.error('仅支持 http/https 协议')
    }
    const hostname = parsed.hostname.toLowerCase()
    if (!whitelist.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
      return Result.error(`不允许从 ${hostname} 安装插件，请在锅巴设置中添加白名单`)
    }
    let text = await this.pluginService.installPlugin(link, autoRestart, autoNpmInstall)
    // 服务层返回 {status, message}，status 为 error 时要转成失败，否则前端会当成安装成功
    if (text?.status === 'error') {
      return Result.error(text.message || '插件安装失败')
    }
    return Result.ok(text, text?.message || '插件安装成功')
  }

  async uninstallPlugin(req) {
    let {name} = req.body
    name = name?.toString?.()?.trim?.()
    if (!name) {
      return Result.error('name不能为空')
    }
    let nameArr = name.split(',')
    if (nameArr.length === 0) {
      return Result.error('name不能为空')
    }
    if (nameArr.includes('miao-plugin')) {
      return Result.error('抱歉，由于miao-plugin是重要插件，不能卸载！')
    }
    let text = await this.pluginService.uninstallPluginBatch(nameArr)
    if (text?.status === 'error') {
      return Result.error(text.message || '插件卸载失败')
    }
    return Result.ok(text, text?.message || '插件卸载成功')
  }

  getSupport(pluginName) {
    let supportObject = GuobaSupportMap.get(pluginName)
    if (!supportObject) {
      throw '该插件不支持锅巴'
    }
    return supportObject
  }

  // 获取插件icon（如果有）
  getPluginIcon(req, res) {
    let {pluginName} = req.params
    let supportObject = this.getSupport(pluginName)
    let {pluginInfo} = supportObject
    if (!pluginInfo || !pluginInfo.iconPath) {
      return Result.error('该插件没有配置iconPath')
    }
    res.sendFile(pluginInfo.iconPath)
    return Result.VOID
  }

  // 获取插件配置数据（如果有）
  async getPluginConfig(req) {
    let {pluginName} = req.params
    let supportObject = this.getSupport(pluginName)
    let {configInfo} = supportObject
    let getConfigData = configInfo?.getConfigData
    if (typeof getConfigData !== 'function') {
      return Result.error('该插件没有配置getConfigData')
    }
    return Result.ok(await getConfigData())
  }

  // 设置插件配置数据
  async setPluginConfig(req) {
    let {pluginName} = req.params
    let supportObject = this.getSupport(pluginName)
    let {configInfo} = supportObject
    let setConfigData = configInfo?.setConfigData
    if (typeof setConfigData !== 'function') {
      return Result.error('该插件没有配置setConfigData')
    }
    // 将新版锅巴UI提交的嵌套对象按schema还原为扁平格式，兼容旧版插件setConfigData
    const flatData = flattenConfigData(req.body, configInfo?.schemas)
    let flag = await setConfigData(flatData, {Result})
    if (flag instanceof Result) {
      return flag
    }
    return Result.ok(flag, '保存成功~')
  }

  // 执行插件的 action
  async doAction(req) {
    const {pluginName} = req.params
    const body = req.body
    const supportObject = this.getSupport(pluginName)
    const {configInfo} = supportObject
    const actions = configInfo?.actions
    if (!actions) {
      return Result.error('没有配置 actions')
    }
    const action = actions[body.action]
    if (!action) {
      return Result.error(`action "${body.action}" 不存在`)
    }
    if (typeof action !== 'function') {
      return Result.error(`action "${body.action}" 不是一个方法`)
    }
    return action(body.args, {Result})
  }

}
