import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 沙盒调试。
 *
 * 在面板里伪造一条消息喂给插件加载器，把回复截下来显示，不发到真实 QQ。
 */
export class SandboxController extends ApiController {

  sandboxService = autowired('sandboxService')

  constructor(guobaApp) {
    super('/sandbox', guobaApp)
  }

  registerRouters() {
    this.get('/defaults', this.getDefaults)
    this.get('/rules', this.getRules)
    this.post('/match', this.match)
    this.post('/send', this.send)
    // <img src> 直接引用，token 走 query（TokenInterceptor 支持）
    this.get('/asset/:id', this.getAsset)
  }

  /** 账号列表与默认场景，前端首次打开时拉一次 */
  async getDefaults() {
    return Result.ok(this.sandboxService.getDefaults())
  }

  /** 已加载插件的命令规则 */
  async getRules() {
    return Result.ok(this.sandboxService.listRules())
  }

  /** 只做正则匹配预览，不执行任何插件 */
  async match(req) {
    const {text, isGroup} = req.body ?? {}
    return Result.ok(this.sandboxService.matchRules(text, isGroup))
  }

  /** 发一条沙盒消息，返回捕获到的回复 */
  async send(req) {
    const {scene, text, images} = req.body ?? {}
    return Result.ok(await this.sandboxService.runMessage({scene, text, images}))
  }

  /** 回传回复里的图片 / 语音 / 文件 */
  async getAsset(req, res) {
    const asset = this.sandboxService.getAsset(req.params.id)
    res.type(asset.mime)
    // 资源 id 是内容哈希，同一 URL 内容不变，可以放心缓存
    res.set('Cache-Control', 'private, max-age=1800, immutable')
    res.send(asset.buffer)
    return Result.VOID
  }

}
