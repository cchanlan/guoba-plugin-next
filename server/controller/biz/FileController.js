import path from 'node:path'
import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 文件管理。
 *
 * 所有操作限定在 Yunzai 根目录内（FileService 里校验）。入参 path 一律是相对根的路径，
 * 根本身传空串。下载要能直接写进 <a href>，token 走 query（TokenInterceptor 支持）。
 */
export class FileController extends ApiController {

  fileService = autowired('fileService')

  constructor(guobaApp) {
    super('/file', guobaApp)
  }

  registerRouters() {
    this.get('/list', this.list)
    this.get('/read', this.read)
    this.post('/save', this.save)
    this.post('/mkdir', this.mkdir)
    this.post('/create', this.create)
    this.post('/rename', this.rename)
    this.post('/delete', this.remove)
    this.post('/upload', this.upload)
    this.get('/download', this.download)
  }

  /** 列目录 */
  async list(req) {
    return Result.ok(this.fileService.list(req.query?.path))
  }

  /** 读文本文件内容 */
  async read(req) {
    return Result.ok(this.fileService.read(req.query?.path))
  }

  /** 保存文本文件 */
  async save(req) {
    const {path: rel, content} = req.body ?? {}
    return Result.ok(this.fileService.save(rel, content))
  }

  /** 新建文件夹 */
  async mkdir(req) {
    const {path: rel} = req.body ?? {}
    return Result.ok(this.fileService.mkdir(rel))
  }

  /** 新建文件 */
  async create(req) {
    const {path: rel, content} = req.body ?? {}
    return Result.ok(this.fileService.create(rel, content))
  }

  /** 重命名 */
  async rename(req) {
    const {path: rel, newName} = req.body ?? {}
    return Result.ok(this.fileService.rename(rel, newName))
  }

  /** 删除（递归） */
  async remove(req) {
    const {path: rel} = req.body ?? {}
    return Result.ok(this.fileService.remove(rel))
  }

  /** 上传，multipart：path 字段 = 目标目录，文件在 req.files（multer 已处理） */
  async upload(req) {
    const {path: rel} = req.body ?? {}
    return Result.ok(await this.fileService.upload(rel, req.files))
  }

  /** 下载 */
  async download(req, res) {
    const abs = this.fileService.downloadAbs(req.query?.path)
    res.download(abs, path.basename(abs))
    return Result.VOID
  }

}
