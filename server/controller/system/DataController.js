import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 数据管理：Redis 与 SQLite 的浏览与编辑。
 *
 * 所有接口都在 /api 下，由 TokenInterceptor 统一校验登录态。
 */
export class DataController extends ApiController {

  dataService = autowired('dataService')

  constructor(guobaApp) {
    super('/data', guobaApp)
  }

  registerRouters() {
    // Redis
    this.get('/redis/info', this.redisInfo)
    this.get('/redis/scan', this.redisScan)
    this.get('/redis/get', this.redisGet)
    this.post('/redis/set', this.redisSet)
    this.post('/redis/expire', this.redisExpire)
    this.post('/redis/command', this.redisCommand)
    this.delete('/redis/keys', this.redisDel)

    // SQLite
    this.get('/db/list', this.dbList)
    this.get('/db/tables', this.dbTables)
    this.get('/db/columns', this.dbColumns)
    this.get('/db/rows', this.dbRows)
    this.post('/db/sql', this.dbSql)
    this.post('/db/row', this.dbUpdateRow)
    this.delete('/db/row', this.dbDeleteRow)
  }

  /* ---------------- Redis ---------------- */

  async redisInfo() {
    return Result.ok(await this.dataService.redisInfo())
  }

  async redisScan(req) {
    const {cursor, match, count} = req.query ?? {}
    return Result.ok(await this.dataService.redisScan({cursor, match, count}))
  }

  async redisGet(req) {
    return Result.ok(await this.dataService.redisGet(req.query?.key))
  }

  async redisSet(req) {
    const {key, type, value, ttl} = req.body ?? {}
    return Result.ok(await this.dataService.redisSet({key, type, value, ttl}), '保存成功')
  }

  async redisExpire(req) {
    const {key, ttl} = req.body ?? {}
    return Result.ok(await this.dataService.redisExpire(key, ttl), '已更新过期时间')
  }

  async redisCommand(req) {
    return Result.ok(await this.dataService.redisCommand(req.body?.command))
  }

  async redisDel(req) {
    const {keys} = req.body ?? {}
    const res = await this.dataService.redisDel(keys)
    return Result.ok(res, `已删除 ${res.deleted} 个 key`)
  }

  /* ---------------- SQLite ---------------- */

  async dbList() {
    return Result.ok(await this.dataService.listDatabases())
  }

  async dbTables(req) {
    return Result.ok(await this.dataService.listTables(req.query?.path))
  }

  async dbColumns(req) {
    const {path, table} = req.query ?? {}
    return Result.ok(await this.dataService.tableColumns(path, table))
  }

  async dbRows(req) {
    const {path, table, page, pageSize, keyword} = req.query ?? {}
    return Result.ok(await this.dataService.tableRows(path, {table, page, pageSize, keyword}))
  }

  async dbSql(req) {
    const {path, sql} = req.body ?? {}
    return Result.ok(await this.dataService.execSql(path, sql))
  }

  async dbUpdateRow(req) {
    const {path, table, rowid, data} = req.body ?? {}
    return Result.ok(await this.dataService.updateRow(path, table, rowid, data), '已更新')
  }

  async dbDeleteRow(req) {
    const {path, table, rowid} = req.body ?? {}
    return Result.ok(await this.dataService.deleteRow(path, table, rowid), '已删除')
  }
}
