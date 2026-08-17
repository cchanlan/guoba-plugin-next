import path from 'node:path'
import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 备份与还原。
 *
 * 搬家用：勾选要带走的配置 / 数据 / 插件 → 打成一个 zip → 下载；到新机器上传同一个包，
 * 勾选要还原的内容，插件按清单自动 clone 回来。
 *
 * 打包和还原都是长任务，接口只负责起任务，进度靠前端轮询 `/task`（游标增量拿日志，
 * 同终端页）。下载要能直接写进 `<a href>`，所以 token 走 query（TokenInterceptor 支持）。
 */
export class BackupController extends ApiController {

  backupService = autowired('backupService')

  constructor(guobaApp) {
    super('/backup', guobaApp)
  }

  registerRouters() {
    this.get('/scan', this.scan)
    this.get('/list', this.list)
    this.post('/create', this.create)
    this.get('/task', this.task)
    this.post('/cancel', this.cancel)
    this.get('/download', this.download)
    this.post('/upload', this.upload)
    this.get('/inspect', this.inspect)
    this.post('/restore', this.restore)
    this.post('/remove', this.remove)
    this.get('/settings', this.getSettings)
    this.post('/settings', this.saveSettings)
  }

  /** 扫描可备份的条目。force=true 跳过 60 秒缓存 */
  async scan(req) {
    const force = req.query?.force === 'true'
    return Result.ok(await this.backupService.scan(force))
  }

  /** 服务器上已有的备份包 */
  async list() {
    return Result.ok(this.backupService.list())
  }

  /** 新建备份，立刻返回任务初态 */
  async create(req) {
    const {keys, note} = req.body ?? {}
    return Result.ok(await this.backupService.create({keys, note}), '已开始备份')
  }

  /** 任务状态 + 增量日志 */
  async task(req) {
    return Result.ok(this.backupService.taskStatus(req.query?.cursor))
  }

  async cancel() {
    const ok = this.backupService.cancel()
    return Result.ok(ok, ok ? '已请求取消' : '当前没有进行中的任务')
  }

  /** 下载备份包 */
  async download(req, res) {
    const abs = this.backupService.absOf(req.query?.file)
    res.download(abs, path.basename(abs))
    return Result.VOID
  }

  /** 上传外部备份包，multipart，文件在 req.files（multer 已处理） */
  async upload(req) {
    const saved = await this.backupService.saveUpload(req.files)
    return Result.ok(saved, `已上传 ${saved.length} 个备份包`)
  }

  /** 还原前预览包内容：条目清单 + 插件清单（标出本地已装 / 缺失） */
  async inspect(req) {
    return Result.ok(await this.backupService.inspect(req.query?.file))
  }

  /** 还原，立刻返回任务初态 */
  async restore(req) {
    const {file, keys, plugins, autoNpmInstall, autoRestart} = req.body ?? {}
    const task = await this.backupService.restore({
      file, keys, plugins, autoNpmInstall, autoRestart,
    })
    return Result.ok(task, '已开始还原')
  }

  /** 删除备份包 */
  async remove(req) {
    this.backupService.remove(req.body?.file)
    return Result.ok(true, '已删除')
  }

  async getSettings() {
    return Result.ok(this.backupService.getSettings())
  }

  async saveSettings(req) {
    return Result.ok(await this.backupService.saveSettings(req.body ?? {}), '已保存')
  }

}
