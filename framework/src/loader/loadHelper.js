import express from 'express'
import multer from 'multer'

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
  // 上传文件
  const upload = multer({dest: 'data/upload_tmp/'})
  // 用正则而不是字符串通配符：'*' 在 express 5（path-to-regexp v8）注册时就抛 Missing parameter
  // name，服务直接起不来；'*splat' 反过来在 express 4 匹配不上，multipart 请求会一路裸奔到业务
  // 路由，body 解析不了（表现为发消息报「消息内容不能为空」）。
  // /.*/ 在两个版本里都能匹配所有 POST；multer 对非 multipart 请求直接 next，不影响 JSON 接口。
  app.post(/.*/, upload.any(), function (req, res, next) {
    next()
  })
}
