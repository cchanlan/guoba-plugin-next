import fs from 'fs'
import path from 'path'
import {autowired, Service} from '#guoba.framework'
import {_paths, Constant, CustomPagesMap} from '#guoba.platform'
import {PAGE_FILES} from './CustomPageStoreService.js'

/** 页面 id 只允许这些字符，避免拼进 URL 或路由时出岔子 */
const ID_RE = /^[A-Za-z0-9_-]+$/
/** 静态资源放行的后缀，其余一律 403 */
const ALLOW_EXT = new Set([
  '.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.map',
])
/** 约定式描述符文件，按顺序取第一个存在的 */
const DESC_FILES = ['index.js', 'pages.js', 'pages.json', 'page.js', 'page.json']
/**
 * 插件放页面的子目录名，按顺序取第一个存在的。
 * `webadapter` 是 QQBot-Web-Adapter 的约定，有插件照着它写，一并认下来。
 */
const PAGE_DIRS = ['guoba', 'webadapter']
/**
 * 面板内建页面的接口前缀段，接口挂在 `/api/custom/_page/<页面id>` 下。
 * 带下划线是为了跟插件目录名区分开，同名的插件目录会被跳过。
 */
const STORE_OWNER = '_page'

/**
 * 注入到 iframe 入口 HTML 里的兼容层。
 *
 * 页面照 QQBot-Web-Adapter 老写法拼接口地址时，多半漏了 custom/{插件名} 两段，
 * 也没带登录凭证；锅巴把插件接口挂在 /api/custom/{插件名} 下，且 /api/* 一律鉴权。
 * 与其让每个插件都改一遍，不如在下发 HTML 时补一层：
 *  - 页面 fetch 的地址以本页面已知路由结尾、但前缀不对 → 重写到 /api/custom/{插件名}
 *    下，并补上 token 请求头；前缀本来就对的请求原样放行
 *  - 暴露 window.__GUOBA__ = {apiBase, token, tokenKey}，页面可直接拿来拼地址
 *
 * 只拦 fetch，不碰页面自己的跳转、表单提交。__GUOBA_CFG__ 由服务端注入。
 */
const COMPAT_SHIM = `(function () {
  if (window.__GUOBA__) return
  var cfg = __GUOBA_CFG__
  var q = new URLSearchParams(location.search)
  window.__GUOBA__ = { apiBase: cfg.apiBase, token: q.get('token') || '', tokenKey: cfg.tokenKey }

  var origFetch = window.fetch
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      var u
      try { u = new URL(input, location.href) } catch (e) { u = null }
      if (u && u.origin === location.origin) {
        var mine = u.pathname.indexOf(cfg.apiBase) === 0
        if (!mine) {
          for (var i = 0; i < cfg.routes.length; i++) {
            // 老约定拼出来的形状是 <挂载前缀>/api<路由>，按这个精确认，免得误伤别的地址
            if (u.pathname.endsWith('/api' + cfg.routes[i])) {
              input = cfg.apiBase + cfg.routes[i] + u.search
              mine = true
              break
            }
          }
        }
        // 锅巴的 /api/* 一律鉴权，页面自己没带就替它补上
        if (mine) {
          init = Object.assign({}, init)
          var headers = new Headers(init.headers)
          if (!headers.has(cfg.tokenKey)) headers.set(cfg.tokenKey, window.__GUOBA__.token)
          init.headers = headers
        }
      }
    }
    return origFetch.call(this, input, init)
  }
})()`

/**
 * owner 是接口的路径段（插件名，或面板页面的 `_page/<页面id>`），
 * 每段都要单独编码 —— 整体编码会把分隔用的 `/` 也转义掉。
 */
function apiPathOf(owner) {
  const seg = String(owner).split('/').map(encodeURIComponent).join('/')
  return `/api/custom/${seg}`
}

/**
 * 插件自定义页面。
 *
 * 每个插件在自己目录下建 `guoba/`（兼容 `webadapter/`）子目录，锅巴启动时
 * 逐个插件目录去找这两个子目录：
 * - 有 `index.js` 且导出 `init(ctx)` → 调用它，插件可注册页面 + 自定义接口
 * - 否则读 `page.json` / `pages.js` 之类的描述符文件，只注册页面
 *
 * 页面注册进 CustomPagesMap 后，会出现在侧边栏，前端按 html / src 两种模式渲染。
 * `label` 里记下来源目录，接口地址、报错提示也带上它，插件按哪个目录写都自洽。
 */
export default class CustomPageService extends Service {

  storeService = autowired('customPageStoreService')

  constructor(app) {
    super(app)
    /** 插件注册的自定义接口，由 CustomApiController 消费 */
    this.apis = []
    // 组件是同步依次实例化的（framework/src/loader/loadComponents.js），
    // 推到微任务里跑，等 customPageStoreService 也进了容器再加载
    this.loading = Promise.resolve().then(() => this.loadAll())
  }

  get pluginsPath() {
    return path.join(_paths.root, 'plugins')
  }

  /** 重新扫描，改完页面不用重启整个 Bot */
  async reload() {
    this.loading = this.loadAll()
    await this.loading
  }

  /** 加载面板内建页面 + 扫描所有插件的 guoba/ 目录 */
  async loadAll() {
    CustomPagesMap.clear()
    this.apis = []
    // 先加载面板里建的页面，id 撞车时插件页面让位给用户自己建的
    await this.loadStorePages()
    let names = []
    try {
      names = fs.readdirSync(this.pluginsPath)
    } catch (e) {
      logger.warn('[Guoba] 扫描插件目录失败：', e.message || e)
      return
    }
    for (const name of names) {
      const dir = this.#findPageDir(name)
      // 没有页面目录的插件占大多数，静默跳过
      if (!dir) continue
      try {
        await this.loadPlugin(name, dir)
      } catch (e) {
        logger.error(`[Guoba] 加载「${name}」自定义页面失败：`, e.message || e)
      }
    }
    const count = CustomPagesMap.size
    if (count > 0) {
      logger.mark(`[Guoba] 已加载 ${count} 个自定义页面`)
    }
  }

  /** 插件的页面目录，按 PAGE_DIRS 顺序取第一个真实存在的 */
  #findPageDir(pluginName) {
    for (const sub of PAGE_DIRS) {
      const dir = path.join(this.pluginsPath, pluginName, sub)
      try {
        if (fs.statSync(dir).isDirectory()) return dir
      } catch {
        // 目录不存在，试下一个
      }
    }
    return null
  }

  /** 加载在面板里建的页面，存储见 CustomPageStoreService */
  async loadStorePages() {
    let list = []
    try {
      list = this.storeService.list()
    } catch (e) {
      logger.warn('[Guoba] 读取面板自定义页面失败：', e.message || e)
      return
    }
    for (const meta of list) {
      try {
        await this.#loadStorePage(meta)
      } catch (e) {
        logger.error(`[Guoba] 加载面板页面「${meta.id}」失败：`, e.message || e)
      }
    }
  }

  /**
   * 单个面板页面。文件名固定，所以直接照着 PAGE_FILES 拼描述符，
   * 空文件不声明 —— 免得白搭一次 404 似的空请求。
   */
  async #loadStorePage(meta) {
    const dir = this.storeService.dirOf(meta.id)
    const notEmpty = (name) => {
      try {
        return fs.statSync(path.join(dir, name)).size > 0
      } catch {
        return false
      }
    }
    const def = {
      id: meta.id,
      title: meta.title,
      icon: meta.icon,
      priority: meta.priority,
      style: notEmpty(PAGE_FILES.css) ? PAGE_FILES.css : '',
      script: notEmpty(PAGE_FILES.js) ? PAGE_FILES.js : '',
    }
    if (meta.mode === 'frame') {
      def.src = PAGE_FILES.html
    } else {
      // 片段模式把 HTML 直接塞进描述符，由前端注入到面板文档里
      const html = notEmpty(PAGE_FILES.html)
        ? fs.readFileSync(path.join(dir, PAGE_FILES.html), 'utf8')
        : ''
      def.html = html || '<p>这个页面还没有内容，去「扩展页面 → 页面管理」里编辑它。</p>'
    }
    const scope = {
      source: 'store',
      pluginName: '',
      owner: `${STORE_OWNER}/${meta.id}`,
      label: `面板页面 ${meta.id}`,
      dir,
    }
    this.#addPage(scope, def)
    if (!notEmpty(PAGE_FILES.api)) return
    // api.js 由主人在面板里编写，跟插件的 guoba/index.js 同权限，在 Bot 进程内执行
    const filePath = path.join(dir, PAGE_FILES.api)
    const mod = await import('file://' + filePath + '?' + Date.now())
    if (typeof mod.init === 'function') {
      await mod.init(this.#createContext(scope))
    }
  }

  /**
   * 加载单个插件的页面目录。dir 由 #findPageDir 给定，可能是 guoba/ 或 webadapter/。
   * label 用目录名，多来源插件的报错一眼能看出是谁
   */
  async loadPlugin(pluginName, dir) {
    const file = DESC_FILES.find((f) => fs.existsSync(path.join(dir, f)))
    if (!file) return

    if (pluginName === STORE_OWNER) {
      logger.warn(`[Guoba] 插件目录名「${pluginName}」与面板内建页面的接口前缀冲突，已跳过`)
      return
    }
    const scope = {source: 'plugin', pluginName, owner: pluginName, label: pluginName, dir}
    const filePath = path.join(dir, file)
    if (file.endsWith('.json')) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      this.#addPages(scope, raw)
      return
    }

    // 带时间戳避免 ESM 缓存，方便改完热扫描
    const mod = await import('file://' + filePath + '?' + Date.now())
    if (typeof mod.init === 'function') {
      await mod.init(this.#createContext(scope))
      return
    }
    this.#addPages(scope, mod.default ?? mod.pages)
  }

  /**
   * 传给 init(ctx) 的上下文。
   * scope 描述页面的来源：`{source, pluginName, owner, dir, label}`，
   * owner 是接口挂载用的路径段（插件是插件名，面板页面是 `_page/<页面id>`）。
   */
  #createContext(scope) {
    const {pluginName, owner, dir} = scope
    return {
      pluginName: pluginName || scope.label,
      pluginDir: dir,
      /** 面板挂载前缀，前端拼绝对地址时用 */
      basePath: _paths.server.realMountPrefix,
      /** 自己的接口前缀，页面里拼请求地址时用 */
      apiBase: `${_paths.server.realMountPrefix}${apiPathOf(owner)}`,
      logger,
      registerPage: (def) => this.#addPage(scope, def),
      registerPages: (list) => this.#addPages(scope, list),
      registerApi: (method, route, ...handlers) =>
        this.#addApi(scope, method, route, handlers),
    }
  }

  #addPages(scope, raw) {
    const list = Array.isArray(raw) ? raw : (raw?.pages ?? (raw ? [raw] : []))
    for (const def of list) {
      this.#addPage(scope, def)
    }
  }

  /** 校验并登记一个页面 */
  #addPage(scope, def) {
    if (!def || typeof def !== 'object') return
    const {label, owner, dir} = scope
    const {id, title} = def
    if (!id || !ID_RE.test(id)) {
      logger.warn(`[Guoba] 「${label}」页面 id 非法：${id}，只允许字母数字下划线中划线`)
      return
    }
    if (!title) {
      logger.warn(`[Guoba] 「${label}」页面 ${id} 缺少 title`)
      return
    }
    if (!def.html && !def.src) {
      logger.warn(`[Guoba] 「${label}」页面 ${id} 必须提供 html 或 src`)
      return
    }
    const exist = CustomPagesMap.get(id)
    if (exist && exist.owner !== owner) {
      logger.warn(`[Guoba] 页面 id 冲突：${id} 已被「${exist.label}」占用，「${label}」的同名页面被忽略`)
      return
    }
    CustomPagesMap.set(id, {
      id,
      source: scope.source,
      pluginName: scope.pluginName,
      owner,
      label,
      dir,
      /** 该页面自定义接口的前缀，不含面板挂载前缀，前端拼请求地址时用 */
      apiPath: apiPathOf(owner),
      title: String(title),
      icon: def.icon || '',
      html: def.html || '',
      src: def.src || '',
      style: def.style || '',
      script: def.script || '',
      priority: Number(def.priority) || 100,
    })
  }

  /** 登记一个自定义接口，实际挂载由 CustomApiController 完成 */
  #addApi(scope, method, route, handlers) {
    const {label, owner} = scope
    const m = String(method || 'get').toLowerCase()
    if (!['get', 'post', 'put', 'delete', 'patch', 'all'].includes(m)) {
      logger.warn(`[Guoba] 「${label}」注册了不支持的请求方法：${method}`)
      return
    }
    if (typeof route !== 'string' || !route.startsWith('/')) {
      logger.warn(`[Guoba] 「${label}」接口路径必须以 / 开头：${route}`)
      return
    }
    const fns = handlers.filter((h) => typeof h === 'function')
    if (fns.length === 0) {
      logger.warn(`[Guoba] 「${label}」接口 ${route} 没有提供处理函数`)
      return
    }
    this.apis.push({owner, label, method: m, route, handlers: fns})
  }

  /** 侧边栏用的页面列表，按 priority 排序 */
  getPages() {
    return [...CustomPagesMap.values()].sort((a, b) => a.priority - b.priority)
  }

  /** 前端渲染用的单个页面信息 */
  getPage(id) {
    const page = CustomPagesMap.get(id)
    return page ? this.toView(page) : null
  }

  /** 抹掉 dir / owner 这类服务端内部字段，前端拼接接口地址用 apiPath */
  toView(page) {
    const {dir, owner, ...rest} = page
    return rest
  }

  /**
   * 解析静态资源的真实路径。
   *
   * 只放行描述符里声明过的文件（src / style / script），因此插件的页面目录
   * 不会被整个暴露出去；再叠加后缀白名单与目录穿越校验兜底。
   *
   * `isEntry` 标记这是 iframe 的入口 HTML，由调用方决定要不要注入兼容脚本。
   */
  resolveAsset(pageId, file) {
    const page = CustomPagesMap.get(pageId)
    if (!page) return {error: '页面不存在', status: 404}
    if (typeof file !== 'string' || !file || file.includes('..')) {
      return {error: '非法的文件名', status: 400}
    }
    const allow = [page.src, page.style, page.script].filter(Boolean)
    if (!allow.includes(file)) {
      return {error: '该文件未在页面描述符中声明', status: 403}
    }
    if (!ALLOW_EXT.has(path.extname(file).toLowerCase())) {
      return {error: '不支持的文件类型', status: 403}
    }
    const full = path.join(page.dir, file)
    // path.join 已能消解 ../，这里再校验一次前缀，防描述符自身写了越界路径
    if (!full.startsWith(page.dir + path.sep)) {
      return {error: '非法的文件路径', status: 403}
    }
    if (!fs.existsSync(full)) {
      return {error: '文件不存在', status: 404}
    }
    return {path: full, page, isEntry: !!page.src && page.src === file}
  }

  /**
   * iframe 入口 HTML —— 读出来并在最前面插入兼容脚本。
   *
   * 页面自己拼接口地址时，容易写成 `<挂载前缀>/api/<路由>`（QQBot-Web-Adapter 的
   * 老约定），而锅巴把插件接口挂在 `<挂载前缀>/api/custom/<插件名>/<路由>` 下；
   * 加上 `/api/*` 一律要带登录凭证，页面不加处理就是 404 或 401。
   * 与其让每个插件都改一遍，不如在下发时补上这一层。
   */
  readEntryHtml(page, filePath) {
    const html = fs.readFileSync(filePath, 'utf8')
    const shim = this.#buildShim(page)
    // 必须跑在页面自己的脚本之前，插到 <head> 里最靠前的位置；
    // 没有 head 的裸 HTML 片段就搁最前面
    const m = html.match(/<head\b[^>]*>/i) || html.match(/<html\b[^>]*>/i)
    if (!m) return shim + html
    const at = m.index + m[0].length
    return html.slice(0, at) + shim + html.slice(at)
  }

  /** 该 owner 注册过的接口路由，shim 拿它判断一个地址是不是本页面的接口 */
  #routesOf(owner) {
    const routes = []
    for (const api of this.apis) {
      if (api.owner === owner && !routes.includes(api.route)) routes.push(api.route)
    }
    return routes
  }

  #buildShim(page) {
    const conf = {
      apiBase: `${_paths.server.realMountPrefix}${page.apiPath}`,
      routes: this.#routesOf(page.owner),
      tokenKey: Constant.TOKEN_KEY,
    }
    // 转义 < 防 routes 里出现 </script> 把标签提前截断
    const json = JSON.stringify(conf).replace(/</g, '\\u003c')
    return `<script>${COMPAT_SHIM.replace('__GUOBA_CFG__', json)}</script>`
  }
}
