import fs from 'fs'
import path from 'path'
import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/** 页面 id 只允许这些字符 —— 它同时是磁盘上的目录名，必须严格限制 */
const ID_RE = /^[A-Za-z0-9_-]+$/
/** 前端 /custom/ 下已占用的路径，不能拿来当页面 id */
const RESERVED_IDS = new Set(['manage'])
/** 面板里可编辑的文件，固定这几个，不接受前端传文件名 */
export const PAGE_FILES = {
  html: 'index.html',
  css: 'style.css',
  js: 'script.js',
  api: 'api.js',
}
/** 描述符文件名，与插件目录约定保持一致 */
const META_FILE = 'page.json'
/** 单个文件的大小上限，防手滑贴进来一整个库把内存吃满 */
const MAX_SIZE = 512 * 1024

/**
 * 面板内建的自定义页面的存储。
 *
 * 用户在锅巴里点「新建页面」，页面就落在 `data/guoba/custom-pages/<id>/` 下：
 *
 * ```
 * data/guoba/custom-pages/my-page/
 * ├── page.json     ← 标题、图标、渲染模式
 * ├── index.html    ← 完整 HTML（frame 模式）或 HTML 片段（html 模式）
 * ├── style.css
 * ├── script.js
 * └── api.js        ← 可选，导出 init(ctx) 注册自定义接口
 * ```
 *
 * 目录结构跟插件的 `guoba/` 目录同构，所以 CustomPageService 能用同一套逻辑加载，
 * 页面也照样出现在侧边栏。文件名全部由这里写死，前端只提交内容。
 */
export default class CustomPageStoreService extends Service {

  /** 面板内建页面的存放根目录 */
  get rootDir() {
    return path.join(_paths.data, 'guoba', 'custom-pages')
  }

  /**
   * 拼出某个页面的目录，顺带校验 id。
   * id 来自前端，先用白名单正则挡掉 `..` 和分隔符，再校验拼接结果没跑出 rootDir。
   */
  dirOf(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new Error('页面 id 只允许字母、数字、下划线和中划线')
    }
    const root = this.rootDir
    const dir = path.join(root, id)
    if (!dir.startsWith(root + path.sep)) {
      throw new Error('非法的页面 id')
    }
    return dir
  }

  /** 全部面板内建页面的描述符，读不出来的目录跳过 */
  list() {
    let names = []
    try {
      names = fs.readdirSync(this.rootDir)
    } catch {
      // 还没建过任何页面，目录不存在是正常的
      return []
    }
    const list = []
    for (const name of names) {
      const meta = this.readMeta(name)
      if (meta) list.push(meta)
    }
    return list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  }

  /** 读描述符，顺便把 id 与目录名对齐，避免手改文件后对不上 */
  readMeta(id) {
    let dir
    try {
      dir = this.dirOf(id)
    } catch {
      return null
    }
    const file = path.join(dir, META_FILE)
    try {
      if (!fs.statSync(dir).isDirectory()) return null
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        id,
        title: String(raw.title || id),
        icon: raw.icon || '',
        mode: raw.mode === 'frame' ? 'frame' : 'html',
        priority: Number(raw.priority) || 100,
      }
    } catch {
      return null
    }
  }

  /** 描述符 + 各文件内容，给编辑器用 */
  read(id) {
    const meta = this.readMeta(id)
    if (!meta) return null
    const dir = this.dirOf(id)
    const files = {}
    for (const [key, name] of Object.entries(PAGE_FILES)) {
      files[key] = this.#readFile(path.join(dir, name))
    }
    return {...meta, ...files}
  }

  #readFile(file) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  exists(id) {
    return !!this.readMeta(id)
  }

  /**
   * 新建或覆盖一个页面。
   *
   * @param id 页面 id，同时是目录名
   * @param data {{title, icon, mode, priority, html, css, js, api}}
   */
  save(id, data = {}) {
    const dir = this.dirOf(id)
    if (RESERVED_IDS.has(id)) {
      throw new Error(`页面 id「${id}」是面板保留字，换一个吧`)
    }
    const title = String(data.title ?? '').trim()
    if (!title) throw new Error('请填写页面标题')

    const meta = {
      id,
      title,
      icon: String(data.icon ?? '').trim(),
      mode: data.mode === 'frame' ? 'frame' : 'html',
      priority: Number(data.priority) || 100,
    }
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    for (const [key, name] of Object.entries(PAGE_FILES)) {
      const text = data[key] == null ? '' : String(data[key])
      if (text.length > MAX_SIZE) {
        throw new Error(`${name} 内容超过 ${MAX_SIZE / 1024}KB，请精简后再保存`)
      }
      fs.writeFileSync(path.join(dir, name), text, 'utf8')
    }
    return meta
  }

  /** 删掉整个页面目录。目录由 dirOf 校验过，只可能是 rootDir 下的一层 */
  remove(id) {
    const dir = this.dirOf(id)
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, {recursive: true, force: true})
    return true
  }
}
