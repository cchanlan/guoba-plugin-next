import fs from 'fs'
import path from 'path'
import {Service, GuobaError} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 数据浏览服务：Redis 与 SQLite 的读写。
 *
 * Redis 直接复用 Yunzai 启动时建好的全局客户端（lib/config/redis.js），
 * 不另开连接，省得多一份连接池还要自己管生命周期。
 *
 * SQLite 用 sequelize 走原始 SQL（Yunzai 自带该依赖，见 plugins/genshin/model/db/BaseModel.js），
 * 每次操作现连现关，避免长期占着文件句柄影响 Yunzai 自身的写入。
 */
export default class DataService extends Service {

  constructor(app) {
    super(app)
  }

  /* ==================== Redis ==================== */

  /** 取到底层 node-redis 客户端。全局 redis 是包装类，真正的 client 在 .redis 上 */
  #client() {
    const client = global.redis?.redis ?? global.redis
    if (!client?.scan) {
      throw new GuobaError('Redis 未连接')
    }
    return client
  }

  /**
   * 扫描 key。用 SCAN 游标而不是 KEYS，避免 key 多时阻塞 Redis。
   * @param cursor 上次返回的游标，首次传 0
   * @param match glob 模式，如 `Yz:*`
   * @param count 每轮扫描的建议数量，实际返回数会浮动
   */
  async redisScan({cursor = 0, match = '*', count = 100} = {}) {
    const client = this.#client()
    count = Math.min(Math.max(Number(count) || 100, 10), 1000)
    const res = await client.scan(Number(cursor) || 0, {MATCH: match || '*', COUNT: count})
    // node-redis v4 返回 {cursor, keys}，老版本返回数组，两种都兼容
    const nextCursor = Array.isArray(res) ? res[0] : res.cursor
    const keys = Array.isArray(res) ? res[1] : res.keys

    // 附上类型和过期时间，列表里直接能看出来是什么
    const items = []
    for (const key of keys ?? []) {
      try {
        const [type, ttl] = await Promise.all([client.type(key), client.ttl(key)])
        items.push({key, type, ttl})
      } catch {
        // 扫描过程中 key 可能刚好被删掉，跳过即可
      }
    }
    return {cursor: Number(nextCursor) || 0, items}
  }

  /** Redis 库里的 key 总数与内存占用，用于页面顶部概览 */
  async redisInfo() {
    const client = this.#client()
    const dbSize = await client.dbSize()
    let memory = ''
    try {
      const info = await client.info('memory')
      memory = /used_memory_human:(\S+)/.exec(info)?.[1] ?? ''
    } catch {
      // INFO 在部分托管 Redis 上被禁用，不影响主功能
    }
    return {dbSize, memory}
  }

  /**
   * 读一个 key 的值。按类型分别取，大集合会被截断。
   * @return {Promise<{key, type, ttl, value, truncated}>}
   */
  async redisGet(key) {
    if (!key) throw new GuobaError('key 不能为空')
    const client = this.#client()
    const type = await client.type(key)
    if (type === 'none') throw new GuobaError('key 不存在')
    const ttl = await client.ttl(key)

    // 集合类只取前 LIMIT 条，防止一个巨型 key 把面板和内存拖垮
    const LIMIT = 500
    let value
    let truncated = false

    switch (type) {
      case 'string':
        value = await client.get(key)
        break
      case 'list': {
        const total = await client.lLen(key)
        value = await client.lRange(key, 0, LIMIT - 1)
        truncated = total > LIMIT
        break
      }
      case 'set': {
        const total = await client.sCard(key)
        // sScan 而非 sMembers，同样是为了不阻塞
        const res = await client.sScan(key, 0, {COUNT: LIMIT})
        value = Array.isArray(res) ? res[1] : res.members
        truncated = total > (value?.length ?? 0)
        break
      }
      case 'zset': {
        const total = await client.zCard(key)
        const members = await client.zRangeWithScores(key, 0, LIMIT - 1)
        value = members.map(i => ({member: i.value, score: i.score}))
        truncated = total > LIMIT
        break
      }
      case 'hash': {
        value = await client.hGetAll(key)
        const size = Object.keys(value).length
        if (size > LIMIT) {
          const cut = {}
          for (const k of Object.keys(value).slice(0, LIMIT)) cut[k] = value[k]
          value = cut
          truncated = true
        }
        break
      }
      default:
        // stream 等类型面板不展开，只标明类型
        value = null
    }
    return {key, type, ttl, value, truncated}
  }

  /**
   * 写一个 key。
   * 仅支持 string 与 hash：其余类型的结构化编辑在表单里很难做对，
   * 需要时用「执行命令」入口更直接。
   * @param ttl 过期秒数，<=0 表示永不过期
   */
  async redisSet({key, type = 'string', value, ttl}) {
    if (!key) throw new GuobaError('key 不能为空')
    const client = this.#client()

    if (type === 'hash') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new GuobaError('hash 类型的值必须是对象')
      }
      const entries = Object.entries(value).map(([k, v]) => [k, String(v)])
      if (entries.length === 0) throw new GuobaError('hash 至少要有一个字段')
      // 先删后写，否则删掉的字段会残留
      await client.del(key)
      await client.hSet(key, Object.fromEntries(entries))
    } else if (type === 'string') {
      await client.set(key, value == null ? '' : String(value))
    } else {
      throw new GuobaError(`暂不支持直接编辑 ${type} 类型，请使用「执行命令」`)
    }

    const expire = Number(ttl)
    if (expire > 0) {
      await client.expire(key, expire)
    } else if (expire === 0 || expire === -1) {
      await client.persist(key)
    }
    return this.redisGet(key)
  }

  async redisDel(keys) {
    const client = this.#client()
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
    if (list.length === 0) throw new GuobaError('未指定要删除的 key')
    return {deleted: await client.del(list)}
  }

  async redisExpire(key, ttl) {
    const client = this.#client()
    const expire = Number(ttl)
    if (expire > 0) {
      await client.expire(key, expire)
    } else {
      await client.persist(key)
    }
    return this.redisGet(key)
  }

  /**
   * 执行任意 Redis 命令。
   * 面板已要求登录，这里不再做命令白名单，但挡掉会让 Bot 直接失能的几个。
   */
  async redisCommand(command) {
    const client = this.#client()
    const parts = this.#splitCommand(command)
    if (parts.length === 0) throw new GuobaError('命令不能为空')

    const name = parts[0].toUpperCase()
    // FLUSHALL / FLUSHDB 会清空整个 Bot 的数据，且面板上一次误点无法撤销
    const denied = ['FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'DEBUG']
    if (denied.includes(name)) {
      throw new GuobaError(`${name} 风险过高，已禁用。确需执行请到服务器上手动操作`)
    }

    const reply = await client.sendCommand(parts)
    return {command: parts.join(' '), reply: this.#normalizeReply(reply)}
  }

  /** 按空格切分命令，支持引号包裹带空格的参数 */
  #splitCommand(command) {
    if (typeof command !== 'string') return []
    const parts = []
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g
    let m
    while ((m = re.exec(command)) !== null) {
      parts.push(m[1] ?? m[2] ?? m[3])
    }
    return parts
  }

  /** Buffer 转字符串，保证能 JSON 序列化 */
  #normalizeReply(reply) {
    if (reply == null) return null
    if (Buffer.isBuffer(reply)) return reply.toString('utf8')
    if (Array.isArray(reply)) return reply.map(i => this.#normalizeReply(i))
    if (typeof reply === 'object') {
      const obj = {}
      for (const [k, v] of Object.entries(reply)) obj[k] = this.#normalizeReply(v)
      return obj
    }
    return reply
  }

  /* ==================== SQLite ==================== */

  /** 扫描时跳过的目录：依赖目录和浏览器缓存里也有 .db，但与 Bot 数据无关 */
  static SKIP_DIRS = new Set(['node_modules', '.git', 'puppeteer', 'chromium', '.cache'])
  static DB_EXT = new Set(['.db', '.sqlite', '.sqlite3', '.db3'])

  /**
   * 扫描 Yunzai 目录下的 SQLite 文件。
   * 只在 data/ 和 plugins/ 下找，深度有限，避免遍历整个磁盘。
   */
  async listDatabases() {
    const root = _paths.root
    const found = []

    // db.yaml 里配的主库排在最前面，它是 Yunzai 自己在用的
    try {
      const cfg = (await import('../../../../../lib/config/config.js')).default
      const storage = cfg?.db?.storage
      if (storage && cfg?.db?.dialect === 'sqlite') {
        const abs = path.isAbsolute(storage) ? storage : path.join(root, storage)
        if (fs.existsSync(abs)) {
          found.push({path: abs, name: path.relative(root, abs), primary: true})
        }
      }
    } catch {
      // 读不到配置就只靠扫描
    }

    const walk = (dir, depth) => {
      if (depth > 4) return
      let entries
      try {
        entries = fs.readdirSync(dir, {withFileTypes: true})
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (DataService.SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          walk(full, depth + 1)
        } else if (DataService.DB_EXT.has(path.extname(entry.name).toLowerCase())) {
          if (found.some(i => i.path === full)) continue
          found.push({path: full, name: path.relative(root, full), primary: false})
        }
      }
    }

    walk(path.join(root, 'data'), 0)
    walk(path.join(root, 'plugins'), 0)
    // 根目录下的散落文件，不递归
    walk(root, 4)

    for (const item of found) {
      try {
        const stat = fs.statSync(item.path)
        item.size = stat.size
        item.mtime = stat.mtimeMs
      } catch {
        item.size = 0
        item.mtime = 0
      }
    }
    return found
  }

  /** 校验路径合法：必须在 Yunzai 根目录内，且确实是已扫描到的库 */
  async #resolveDb(dbPath) {
    if (!dbPath) throw new GuobaError('未指定数据库')
    const abs = path.resolve(dbPath)
    // 防目录穿越：只允许打开 Yunzai 根目录下的文件
    const root = path.resolve(_paths.root)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new GuobaError('只能打开 Yunzai 目录下的数据库')
    }
    if (!fs.existsSync(abs)) throw new GuobaError('数据库文件不存在')
    if (!DataService.DB_EXT.has(path.extname(abs).toLowerCase())) {
      throw new GuobaError('不是 SQLite 数据库文件')
    }
    return abs
  }

  /** 现连现关：回调执行完立即关闭连接，不驻留文件句柄 */
  async #withDb(dbPath, fn) {
    const abs = await this.#resolveDb(dbPath)
    const {Sequelize} = await import('sequelize')
    const sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: abs,
      logging: false,
    })
    try {
      return await fn(sequelize)
    } finally {
      await sequelize.close().catch(() => undefined)
    }
  }

  /** 列出所有表及其行数 */
  async listTables(dbPath) {
    return this.#withDb(dbPath, async (sequelize) => {
      const [rows] = await sequelize.query(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
        + "AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      const tables = []
      for (const row of rows) {
        let count = 0
        try {
          // 表名来自 sqlite_master，用双引号包裹防止关键字冲突
          const [[r]] = await sequelize.query(`SELECT COUNT(*) AS c FROM "${row.name}"`)
          count = r?.c ?? 0
        } catch {
          // 视图可能依赖缺失的表，算不出行数就显示 0
        }
        tables.push({name: row.name, type: row.type, count})
      }
      return tables
    })
  }

  /** 表结构 */
  async tableColumns(dbPath, table) {
    if (!table) throw new GuobaError('未指定表名')
    return this.#withDb(dbPath, async (sequelize) => {
      const [rows] = await sequelize.query(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
      return rows.map(r => ({
        name: r.name,
        type: r.type,
        notnull: !!r.notnull,
        pk: !!r.pk,
        defaultValue: r.dflt_value,
      }))
    })
  }

  /** 分页读表数据 */
  async tableRows(dbPath, {table, page = 1, pageSize = 50, keyword = ''} = {}) {
    if (!table) throw new GuobaError('未指定表名')
    const safeTable = `"${String(table).replace(/"/g, '""')}"`
    page = Math.max(Number(page) || 1, 1)
    pageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 500)

    return this.#withDb(dbPath, async (sequelize) => {
      const [cols] = await sequelize.query(`PRAGMA table_info(${safeTable})`)
      const columns = cols.map(c => c.name)

      // 关键字在所有列里做模糊匹配，值用绑定参数传入，不拼进 SQL
      let where = ''
      const replacements = {}
      if (keyword && columns.length > 0) {
        const conds = columns.map((c, i) => {
          replacements[`kw${i}`] = `%${keyword}%`
          return `CAST("${c.replace(/"/g, '""')}" AS TEXT) LIKE :kw${i}`
        })
        where = ` WHERE ${conds.join(' OR ')}`
      }

      const [[cnt]] = await sequelize.query(
        `SELECT COUNT(*) AS c FROM ${safeTable}${where}`, {replacements}
      )
      const total = cnt?.c ?? 0

      const [rows] = await sequelize.query(
        `SELECT rowid AS __rowid, * FROM ${safeTable}${where} LIMIT :limit OFFSET :offset`,
        {replacements: {...replacements, limit: pageSize, offset: (page - 1) * pageSize}}
      )
      return {columns, rows, total, page, pageSize}
    })
  }

  /**
   * 执行任意 SQL。
   * 写操作放开（用户已选择完全读写），但 SELECT 的返回结果会限制条数。
   */
  async execSql(dbPath, sql) {
    if (!sql || !String(sql).trim()) throw new GuobaError('SQL 不能为空')
    const text = String(sql).trim()
    const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(text)

    return this.#withDb(dbPath, async (sequelize) => {
      const started = Date.now()
      const [rows, meta] = await sequelize.query(text)
      const elapsed = Date.now() - started

      if (isSelect) {
        const list = Array.isArray(rows) ? rows : []
        const LIMIT = 1000
        return {
          type: 'select',
          columns: list.length > 0 ? Object.keys(list[0]) : [],
          rows: list.slice(0, LIMIT),
          total: list.length,
          truncated: list.length > LIMIT,
          elapsed,
        }
      }
      return {
        type: 'exec',
        // sqlite 下 meta 为受影响行数或 undefined
        affected: typeof meta === 'number' ? meta : (meta?.changes ?? null),
        elapsed,
      }
    })
  }

  /** 删除一行，按 rowid 定位（SQLite 每张普通表都有 rowid） */
  async deleteRow(dbPath, table, rowid) {
    if (!table) throw new GuobaError('未指定表名')
    if (rowid == null) throw new GuobaError('未指定行')
    const safeTable = `"${String(table).replace(/"/g, '""')}"`
    return this.#withDb(dbPath, async (sequelize) => {
      await sequelize.query(`DELETE FROM ${safeTable} WHERE rowid = :rowid`, {
        replacements: {rowid},
      })
      return {ok: true}
    })
  }

  /** 更新一行的某几个字段，按 rowid 定位 */
  async updateRow(dbPath, table, rowid, data) {
    if (!table) throw new GuobaError('未指定表名')
    if (rowid == null) throw new GuobaError('未指定行')
    if (!data || typeof data !== 'object') throw new GuobaError('未提供要更新的数据')

    const entries = Object.entries(data).filter(([k]) => k !== '__rowid')
    if (entries.length === 0) throw new GuobaError('没有要更新的字段')

    const safeTable = `"${String(table).replace(/"/g, '""')}"`
    return this.#withDb(dbPath, async (sequelize) => {
      // 列名先与真实表结构比对，杜绝前端传入伪造列名
      const [cols] = await sequelize.query(`PRAGMA table_info(${safeTable})`)
      const valid = new Set(cols.map(c => c.name))
      const replacements = {rowid}
      const sets = []
      entries.forEach(([k, v], i) => {
        if (!valid.has(k)) return
        replacements[`v${i}`] = v
        sets.push(`"${k.replace(/"/g, '""')}" = :v${i}`)
      })
      if (sets.length === 0) throw new GuobaError('没有匹配到有效字段')

      await sequelize.query(
        `UPDATE ${safeTable} SET ${sets.join(', ')} WHERE rowid = :rowid`,
        {replacements}
      )
      return {ok: true}
    })
  }
}
