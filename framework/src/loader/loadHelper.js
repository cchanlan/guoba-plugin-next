import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import {cfg, Constant} from '#guoba.platform'

/**
 * 一些辅助工具
 * @param {GuobaApplication} guobaApp
 */
export function useHelper(guobaApp) {
  const {app, _args} = guobaApp
  if (_args.staticPath) {
    // 静态资源
    app.set('views', _args.staticPath)
    app.use(_args.prefix, express.static(_args.staticPath))
    app.get('/robots.txt', (req, res) => {
      res.type('text/plain').send('User-agent: *\nDisallow: /\n')
    })
  }
  // parse application/json
  app.use(express.json({limit: '50mb'}))
  app.use(express.urlencoded({limit: '50mb', extended: true}))

  // 上传文件。
  //
  // 这里有两个必须同时成立的限制，缺一个就是洞：
  // 1) 只处理锅巴自己 API 路径下的 multipart。这个中间件跑在路由之前，如果对所有 POST
  //    生效，未登录往 /guoba/任意路径 传文件也会先落到磁盘上（实测过：回 404，但文件已写出）。
  // 2) 必须带着有效的面板令牌。鉴权在路由层才做，中间件不等鉴权就落盘的话，
  //    没有令牌的人也能反复上传把磁盘灌满。
  // 另外 limits 一定要给：单文件 500MB，最多 200 个文件（上传整个文件夹时前端按 50 个一批发）。
  /** 剩余磁盘空间（字节）；拿不到就返回 null，按「放行」处理，别把正常上传卡死 */
  const freeDiskBytes = (dir) => {
    try {
      // statfsSync 是 Node 18.15+ 的同步接口，Linux / Windows 都有
      const st = fs.statfsSync(dir)
      const blockSize = Number(st.bsize ?? st.bsize ?? 0)
      const freeBlocks = Number(st.bavail ?? st.bfree ?? 0)
      if (!blockSize || !freeBlocks) return null
      return blockSize * freeBlocks
    } catch {
      return null
    }
  }
  /** 上传前至少留这么多空闲：低于它就拒绝，磁盘写满整个 Bot 会跟着崩 */
  const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
  /** 单次上传请求的总量上限（4GB）：面板上传的是配置和插件，不是搬系统镜像 */
  const MAX_UPLOAD_REQUEST_BYTES = 4 * 1024 * 1024 * 1024

  const upload = multer({
    dest: 'data/upload_tmp/',
    limits: {
      fileSize: 500 * 1024 * 1024,
      files: 200,
      fields: 100,
      parts: 400,
    },
  })
  const mountRoot = cfg.serverMountPath.mountRoot
  const prefixes = [_args.prefix, mountRoot].filter(Boolean)

  /** 去掉挂载前缀后的路径，用 originalUrl 避免受重写中间件影响 */
  const stripMount = (url) => {
    let p = String(url || '').split('?')[0]
    for (const prefix of prefixes) {
      if (p.length >= prefix.length && p.toLowerCase().startsWith(prefix.toLowerCase())) {
        const rest = p.slice(prefix.length)
        if (rest === '' || rest.startsWith('/')) {
          p = rest || '/'
          break
        }
      }
    }
    return p
  }

  const hasAccessToken = async (req) => {
    const token = req.headers?.[Constant.TOKEN_KEY]
    if (!token || typeof token !== 'string') return false
    if (typeof redis === 'undefined' || !redis?.get) return true
    try {
      return !!(await redis.get(Constant.REDIS_PREFIX + 'access-token:' + token))
    } catch {
      // redis 挂了就别落盘，宁可让请求在鉴权层被拒
      return false
    }
  }

  // 用正则而不是字符串通配符：'*' 在 express 5（path-to-regexp v8）注册时就抛 Missing parameter
  // name，服务直接起不来；'*splat' 反过来在 express 4 匹配不上，multipart 请求会一路裸奔到业务
  // 路由，body 解析不了（表现为发消息报「消息内容不能为空」）。
  // /.*/ 在两个版本里都能匹配所有 POST；multer 对非 multipart 请求直接 next，不影响 JSON 接口。
  app.post(/.*/, async (req, res, next) => {
    const apiPath = stripMount(req.originalUrl || req.url)
    // 文件管理必须先完成登录和二级验证，再接收文件；由其上传入口单独处理 multipart。
    if (!/^\/api(\/|$)/i.test(apiPath) || /^\/api\/file(\/|$)/i.test(apiPath) || !(await hasAccessToken(req))) {
      next()
      return
    }
    // 磁盘快满时直接拒绝：上传把根分区写满，redis 落盘、日志写入、插件读配置全都会失败，
    // 表现就是整个 Bot 崩掉。这里按「剩余空间」兜底，而不是只靠单文件上限。
    const free = freeDiskBytes('.')
    if (free !== null && free < MIN_FREE_BYTES) {
      res.status(507).json({ok: false, code: 507, message: '服务器磁盘空间不足，已拒绝上传', result: null})
      return
    }
    // 单请求总量也要卡住：20 个 500MB 的文件就是 10GB，一个请求就能把盘写满。
    // Content-Length 是请求头里最直接的信号；分块上传（没有这个头）时仍由单文件上限兜底。
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_REQUEST_BYTES) {
      res.status(413).json({ok: false, code: 413, message: '单次上传总量过大，请分批上传', result: null})
      return
    }
    upload.any()(req, res, next)
  }, function (req, res, next) {
    next()
  })
}
