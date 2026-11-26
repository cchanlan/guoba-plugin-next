import fs from 'node:fs'
import os from 'node:os'
import multer from 'multer'
import path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {autowired, GuobaError, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 文件管理。
 *
 * 所有操作限定在 Yunzai 根目录内（FileService 里校验）。入参 path 一律是相对根的路径，
 * 根本身传空串。下载链接使用短期媒体票据。
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
    this.post('/delete-batch', this.removeBatch)
    this.post('/upload', this.upload)
    this.get('/download', this.download)
    this.get('/dir-size', this.dirSize)
    this.get('/download-dir', this.downloadDir)
  }

  /** 列目录 */
  async list(req) {
    return Result.ok(this.fileService.list(req.query?.path))
  }

  /** 读文本文件内容 */
  async read(req) {
    return Result.ok(await this.fileService.read(req.query?.path))
  }

  /** 保存文本文件 */
  async save(req) {
    const {path: rel, content} = req.body ?? {}
    return Result.ok(await this.fileService.save(rel, content, req.gateVerified))
  }

  /** 新建文件夹 */
  async mkdir(req) {
    const {path: rel} = req.body ?? {}
    return Result.ok(this.fileService.mkdir(rel, req.gateVerified))
  }

  /** 新建文件 */
  async create(req) {
    const {path: rel, content} = req.body ?? {}
    return Result.ok(this.fileService.create(rel, content, req.gateVerified))
  }

  /** 重命名 */
  async rename(req) {
    const {path: rel, newName} = req.body ?? {}
    return Result.ok(this.fileService.rename(rel, newName, req.gateVerified))
  }

  /** 删除（递归） */
  async remove(req) {
    const {path: rel} = req.body ?? {}
    return Result.ok(this.fileService.remove(rel, req.gateVerified))
  }

  /**
   * 批量删除。
   *
   * 逐项删、逐项记结果：一项不存在或被权限拦住时，不该把整单打断 ——
   * 前端勾了 50 个，其中一个刚被别人删掉，剩下 49 个还是要删。
   * 最后把失败项带回去，由页面告诉用户哪几个没删成。
   */
  async removeBatch(req) {
    const {paths} = req.body ?? {}
    if (!Array.isArray(paths) || !paths.length) {
      return Result.ok({deleted: [], failed: []})
    }
    const deleted = []
    const failed = []
    for (const rel of paths) {
      try {
        this.fileService.remove(rel, req.gateVerified)
        deleted.push(rel)
      } catch (err) {
        failed.push({path: String(rel ?? ''), message: err?.message ?? String(err)})
      }
    }
    return Result.ok({deleted, failed})
  }

  /** 只在鉴权之后接收 multipart；使用本次请求独享的临时目录。 */
  async upload(req, res) {
    if (!req.is('multipart/form-data')) throw new GuobaError('请先选择要上传的文件')
    const tmpRoot = os.tmpdir()
    if (Number(req.headers['content-length']) > 4 * 1024 ** 3) {
      return Result.error('单次上传总量过大，请分批上传', 413)
    }
    let available
    try {
      const stat = await fs.promises.statfs?.(tmpRoot)
      if (stat) available = stat.bavail * stat.bsize
    } catch {
      // 个别平台不支持 statfs，由上传大小限制兜底。
    }
    if (available !== undefined && available < 2 * 1024 ** 3) {
      return Result.error('服务器临时磁盘空间不足', 507)
    }
    const tmp = await fs.promises.mkdtemp(path.join(tmpRoot, 'guoba-file-upload-'))
    try {
      const parse = multer({
        dest: tmp,
        limits: {fileSize: 500 * 1024 ** 2, files: 200, fields: 100, parts: 400},
      }).array('files', 200)
      await new Promise((resolve, reject) => parse(req, res, err => err ? reject(err) : resolve()))
      const {path: rel, relPaths} = req.body ?? {}
      let list = []
      if (relPaths != null && relPaths !== '') {
        try {
          list = JSON.parse(relPaths)
          if (!Array.isArray(list)) throw new Error()
        } catch {
          throw new GuobaError('上传文件夹路径格式不合法')
        }
      }
      return Result.ok(await this.fileService.upload(rel, req.files, list, req.gateVerified))
    } catch (err) {
      if (err instanceof multer.MulterError) throw new GuobaError('上传未完成，请检查文件大小与数量后重试')
      throw err
    } finally {
      await fs.promises.rm(tmp, {recursive: true, force: true}).catch(err => {
        logger.error(`[Guoba] 文件上传临时目录清理失败：${err.code || err.message}`)
      })
    }
  }

  /** 使用已经校验过的描述符下载；不要交给另一层按路径重新打开。 */
  async download(req, res) {
    const {handle, stat, name} = await this.fileService.openDownload(req.query?.path)
    try {
      const lastModified = stat.mtime.toUTCString()
      res.set({'Accept-Ranges': 'bytes', 'Last-Modified': lastModified, 'Cache-Control': 'private, no-store'})
      const ifRange = req.get('If-Range')
      const ranges = !ifRange || ifRange === lastModified ? req.range(stat.size) : undefined
      if (ranges === -1 && /^bytes=/i.test(req.get('Range') || '')) {
        res.set('Content-Range', `bytes */${stat.size}`).status(416).end()
        return Result.VOID
      }
      res.attachment(name)
      let streamOptions = {autoClose: false}
      let length = stat.size
      if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
        const {start, end} = ranges[0]
        streamOptions = {...streamOptions, start, end}
        length = end - start + 1
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      } else if (length > 0) {
        streamOptions = {...streamOptions, start: 0, end: length - 1}
      }
      res.set('Content-Length', String(length))
      if (!length) res.end()
      else await pipeline(handle.createReadStream(streamOptions), res)
    } catch (err) {
      if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.error(`[Guoba] 下载失败：${err?.code || err?.message}`)
      res.destroy()
    } finally {
      await handle.close().catch(() => {})
    }
    return Result.VOID
  }

  /** 算文件夹占用（页面上点一下才算，慢是正常的） */
  async dirSize(req) {
    return Result.ok(await this.fileService.dirSize(req.query?.path))
  }

  /**
   * 打包下载文件夹。
   *
   * zip 是边遍历边生成的，长度事先不知道，所以没有 Content-Length，靠 chunked 传输；
   * 也正因为头一发出去就没法改，出错只能掐断连接 —— 浏览器那边表现为下载失败。
   */
  async downloadDir(req, res) {
    const {name, stream} = this.fileService.zipDir(req.query?.path)
    // attachment 会顺带按扩展名把 Content-Type 设成 application/zip，中文包名也编码好
    res.attachment(name)
    try {
      await pipeline(stream, res)
    } catch (err) {
      // 客户端中途取消（ERR_STREAM_PREMATURE_CLOSE）是常事，不用当错误报
      if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.error(`[Guoba] 打包下载失败：${err?.stack ?? err}`)
      }
      res.destroy()
    }
    return Result.VOID
  }

}
