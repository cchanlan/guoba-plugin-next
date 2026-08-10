import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 自定义页面。
 *
 * 页面有两个来源：插件自己的 `guoba/` 目录，以及主人在面板里建的（存 data 目录，
 * 见 CustomPageStoreService）。前者只读，后者能在面板里增删改。
 *
 * 页面本身由前端 `/custom/:id` 容器渲染，这里只提供页面清单、静态资源与管理接口。
 * 资源路径特意做成 `/asset/:id/:file`，iframe 里写相对路径（`style.css`）
 * 就能被浏览器解析到同一目录下，写页面的人无需关心挂载前缀；
 * 页面 id 也不占用第一段路径，不会跟 list / reload 之类撞车。
 */
export class CustomPageController extends ApiController {

  customPageService = autowired('customPageService')
  customPageStoreService = autowired('customPageStoreService')

  constructor(guobaApp) {
    super('/custom-page', guobaApp)
  }

  registerRouters() {
    this.get('/list', this.getList)
    this.get('/detail/:id', this.getPage)
    this.get('/asset/:id/:file', this.getAsset)
    this.post('/reload', this.reload)
    // 面板内建页面的管理
    this.get('/store/list', this.storeList)
    this.get('/store/detail/:id', this.storeDetail)
    this.post('/store/save', this.storeSave)
    this.delete('/store/:id', this.storeRemove)
  }

  /** 已注册的全部自定义页面 */
  async getList() {
    await this.customPageService.loading
    const service = this.customPageService
    return Result.ok(service.getPages().map((page) => service.toView(page)))
  }

  /** 单个页面信息，前端据此决定渲染方式 */
  async getPage(req) {
    await this.customPageService.loading
    const page = this.customPageService.getPage(req.params.id)
    if (!page) {
      return Result.error('页面不存在或已被移除')
    }
    return Result.ok(page)
  }

  /** 重新扫描，改完页面不用重启整个 Bot */
  async reload() {
    const count = await this.#reload()
    return Result.ok(count, '已重新加载自定义页面')
  }

  /** 页面引用的静态文件，只放行描述符里声明过的 */
  async getAsset(req, res) {
    await this.customPageService.loading
    const {id, file} = req.params
    const ret = this.customPageService.resolveAsset(id, file)
    if (ret.error) {
      return Result.error(ret.error, ret.status)
    }
    // iframe 的入口 HTML 要注入兼容脚本，不能直接 sendFile
    if (ret.isEntry) {
      res.type('html').send(this.customPageService.readEntryHtml(ret.page, ret.path))
      return Result.VOID
    }
    res.sendFile(ret.path)
    return Result.VOID
  }

  /* ---------------- 面板内建页面的管理 ---------------- */

  /** 面板里建的页面清单，只有这些能编辑 */
  async storeList() {
    return Result.ok(this.customPageStoreService.list())
  }

  /** 页面描述符 + 各文件内容，编辑器用 */
  async storeDetail(req) {
    const data = this.#store(() => this.customPageStoreService.read(req.params.id))
    if (data instanceof Result) return data
    if (!data) return Result.error('页面不存在')
    return Result.ok(data)
  }

  /**
   * 新建或保存页面。
   * `create` 为真时是新建，撞了已有 id（含插件注册的）就报错，免得覆盖别人的页面。
   */
  async storeSave(req) {
    const {id, create, ...data} = req.body ?? {}
    const store = this.customPageStoreService
    const ret = this.#store(() => {
      if (create) {
        if (store.exists(id)) throw new Error(`页面 id「${id}」已存在`)
        const exist = this.customPageService.getPage(id)
        if (exist) throw new Error(`页面 id「${id}」已被「${exist.label || '其他页面'}」占用`)
      } else if (!store.exists(id)) {
        throw new Error('页面不存在，可能已被删除')
      }
      return store.save(id, data)
    })
    if (ret instanceof Result) return ret
    await this.#reload()
    return Result.ok(ret, create ? '页面已创建' : '页面已保存')
  }

  async storeRemove(req) {
    const ret = this.#store(() => this.customPageStoreService.remove(req.params.id))
    if (ret instanceof Result) return ret
    if (!ret) return Result.error('页面不存在')
    await this.#reload()
    return Result.ok(true, '页面已删除')
  }

  /** 存储层的校验（非法 id、写盘失败等）统一转成可读的错误返回 */
  #store(fn) {
    try {
      return fn()
    } catch (e) {
      return Result.error(e?.message || '操作失败')
    }
  }

  /** 重新加载页面，顺带把新增的接口补挂上 */
  async #reload() {
    await this.customPageService.reload()
    // 已挂过的路径会跳过，handler 每次请求时重新查表，所以改动即时生效
    await autowired('customApiController').mountApis()
    return this.customPageService.getPages().length
  }
}
