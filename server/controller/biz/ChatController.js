import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 消息记录。
 *
 * 与沙盒相反，这里是真收真发：消息取自适配器与 QQ 服务端，发出去的会真的到群里。
 */
export class ChatController extends ApiController {

  chatService = autowired('chatService')

  constructor(guobaApp) {
    super('/chat', guobaApp)
  }

  registerRouters() {
    this.get('/status', this.status)
    this.get('/sessions', this.sessions)
    this.get('/history', this.history)
    this.get('/tail', this.tail)
    this.post('/send', this.send)
    this.post('/send-raw', this.sendRaw)
    this.post('/recall', this.recall)
    this.post('/resend', this.resend)
    this.post('/poke', this.poke)
    this.post('/read', this.read)
    this.post('/forward', this.forward)
    // 下面两个要能直接写进 <img src>，token 走 query（TokenInterceptor 支持）
    this.get('/asset/:id', this.getAsset)
    this.get('/proxy', this.proxy)
  }

  /** 缓冲状态，前端显示「内存里留了多少条」 */
  async status() {
    return Result.ok(this.chatService.status())
  }

  /** 会话列表（群 / 好友），带最后一条摘要与未读数 */
  async sessions(req) {
    const {type, botId, keyword, pageNo, pageSize} = req.query ?? {}
    return Result.ok(this.chatService.listSessions({type, botId, keyword, pageNo, pageSize}))
  }

  /** 拉历史消息，seq 为向上翻页的游标 */
  async history(req) {
    const {botId, type, id, seq, count} = req.query ?? {}
    return Result.ok(await this.chatService.getHistory({botId, type, id, seq, count}))
  }

  /** 实时增量，cursor + key */
  async tail(req) {
    const {key, cursor, rev} = req.query ?? {}
    return Result.ok(this.chatService.tail({key, cursor, rev}))
  }

  /** 发消息，会真的发到 QQ 上。图片走 multipart（锅巴全局挂的 multer 已把文件放进 req.files） */
  async send(req) {
    const {botId, type, id, text, images, replyTo, ats} = req.body ?? {}
    return Result.ok(await this.chatService.send({
      botId, type, id, text, images, replyTo, ats,
      files: req.files,
    }))
  }

  /** 发原始消息段数组 */
  async sendRaw(req) {
    const {botId, type, id, raw} = req.body ?? {}
    return Result.ok(await this.chatService.sendRaw({botId, type, id, raw}))
  }

  /** 撤回，只能撤 bot 自己发的且有时限 */
  async recall(req) {
    const {botId, type, id, messageId} = req.body ?? {}
    return Result.ok(await this.chatService.recall({botId, type, id, messageId}))
  }

  /** 复读：把内存里那条消息按段原样再发（图片取回字节、表情带 id） */
  async resend(req) {
    const {botId, type, id, messageId} = req.body ?? {}
    return Result.ok(await this.chatService.resend({botId, type, id, messageId}))
  }

  /** 戳一戳，群里是 pokeMember、私聊是 poke */
  async poke(req) {
    const {botId, type, id, userId} = req.body ?? {}
    return Result.ok(await this.chatService.poke({botId, type, id, userId}))
  }

  /** 清掉某个会话的未读 */
  async read(req) {
    const {key} = req.body ?? {}
    return Result.ok(this.chatService.markRead(key))
  }

  /** 展开合并转发，内容在 QQ 服务端，点开时才去取 */
  async forward(req) {
    const {botId, type, id, messageId} = req.body ?? {}
    return Result.ok(await this.chatService.getForward({botId, type, id, messageId}))
  }

  /** 回传自己发出去的那张图 */
  async getAsset(req, res) {
    const asset = this.chatService.getAsset(req.params.id)
    res.type(asset.mime)
    res.set('Cache-Control', 'private, max-age=1800')
    res.send(asset.buffer)
    return Result.VOID
  }

  /** QQ 直链的 rkey 过期后由服务端代拉一次，只放行消息里出现过的地址 */
  async proxy(req, res) {
    const {buffer, mime} = await this.chatService.proxy(req.query?.url)
    res.type(mime)
    // rkey 会过期，别缓存太久
    res.set('Cache-Control', 'private, max-age=300')
    res.send(buffer)
    return Result.VOID
  }

}
