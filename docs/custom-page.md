# 自定义页面

给锅巴面板加自己的页面，页面出现在侧边栏「扩展页面」下，还能注册自己的接口（自带登录鉴权）。

页面有两种来源：

| | 建在哪 | 适合 |
| --- | --- | --- |
| **面板里建**（推荐） | 侧边栏「扩展页面 → 页面管理」，点「新建页面」 | 自己用，改完即时生效，不碰文件系统 |
| **插件自带** | 插件目录下的 `guoba/` | 插件作者随插件分发页面 |

两者渲染方式、接口机制完全一致，只是内容存放位置不同。

## 一、在面板里建页面

侧边栏 **扩展页面 → 页面管理 → 新建页面**，填几个字段就完事：

| 字段 | 说明 |
| --- | --- |
| 页面 id | 唯一标识，只允许 `^[A-Za-z0-9_-]+$`，建好后不可改（`manage` 是保留字） |
| 标题 | 侧边栏上显示的名字 |
| 图标 | emoji（`📊`）或 iconify 图标名（`ant-design:bar-chart-outlined`） |
| 渲染方式 | 片段 / 独立页，见下 |
| 排序 | 数字越小越靠前，默认 100 |

下面四个标签页分别写 HTML、CSS、JS 和接口，保存后侧边栏立刻出现这一项，不用重启 Bot。

**片段 vs 独立页：**

| | 说明 |
| --- | --- |
| 片段 | HTML 注入进面板，CSS/JS 自动挂上，能直接用面板的主题色变量（`var(--g-text)` 等） |
| 独立页 | 用 iframe 嵌一整份 HTML 文档，自己 `<link href="style.css">` / `<script src="script.js">` 引，样式互不干扰 |

页面文件存在 `data/guoba/custom-pages/<页面id>/`：

```
data/guoba/custom-pages/my-page/
├── page.json     ← 标题、图标、渲染方式
├── index.html
├── style.css
├── script.js
└── api.js        ← 「接口」标签页的内容
```

### 页面里调接口

「接口」标签页里导出 `init(ctx)`，用 `ctx.registerApi` 注册，接口挂在 `/api/custom/_page/<页面id>` 下：

```js
export function init(ctx) {
  ctx.registerApi('get', '/hello', (req, res) => {
    res.json({ok: true, code: 0, result: {count: 42}, message: 'ok'})
  })
}
```

页面里请求它：

```js
// 片段模式：面板挂了个全局对象
const {apiBase, token, tokenKey} = window.__GUOBA__
const res = await fetch(`${apiBase}/hello`, {headers: {[tokenKey]: token}})

// 独立页模式：三个参数在 iframe 地址上
const q = new URLSearchParams(location.search)
const res = await fetch(`${q.get('__apiBase')}/hello`, {
  headers: {'guoba-access-token': q.get('token')},
})
```

> 接口代码在 Bot 进程里执行，跟插件同权限（能读写文件、调 `Bot` 对象）。只写自己清楚的逻辑，别粘来路不明的代码。

## 二、插件自带页面

插件作者把页面随插件分发时用这种方式。在**插件自己的目录**下建 `guoba/` 子目录：

```
plugins/
└── your-plugin/
    └── guoba/
        ├── index.js     ← 导出 init(ctx)，页面 + 接口一起注册
        ├── dash.html
        ├── dash.css
        └── dash.js
```

锅巴启动时扫描 `plugins/*/guoba/`，按下面的顺序取第一个存在的文件：

`index.js` → `pages.js` → `pages.json` → `page.js` → `page.json`

`index.js` 导出了 `init(ctx)` 就调用它；否则把默认导出当成页面描述符。

> 不需要改插件主入口 `index.js`，也不需要往锅巴目录里放任何东西。

> 目录名叫 `webadapter/` 也认（QQBot-Web-Adapter 的约定），两者都在时用 `guoba/`。
> 新写页面建议用 `guoba/`。

### 只要一个静态页面

放 `guoba/page.json` 就够了，不用写 `init`：

```json
{
  "id": "hello",
  "title": "你好页",
  "icon": "👋",
  "html": "<h3>你好，这是自定义页面</h3>"
}
```

多个页面用数组，或者 `{"pages": [...]}`：

```js
// guoba/pages.js
export default [
  {id: 'page-a', title: '页面 A', icon: '🅰️', html: '<p>A</p>', priority: 10},
  {id: 'page-b', title: '页面 B', icon: '🅱️', src: 'b.html', priority: 20},
]
```

### 页面 + 接口（推荐）

`guoba/index.js` 导出 `init(ctx)`：

```js
export function init(ctx) {
  const {registerPage, registerApi} = ctx

  registerPage({
    id: 'my-page',
    title: '我的页面',
    icon: '⚙️',
    src: 'dash.html',
  })

  // 挂到 /api/custom/<你的插件目录名>/data，自动带登录鉴权
  registerApi('get', '/data', (req, res) => {
    res.json({ok: true, code: 0, result: {count: 42}, message: 'ok'})
  })
}
```

`ctx` 提供：

| 字段 | 说明 |
| --- | --- |
| `pluginName` | 插件目录名 |
| `pluginDir` | `guoba/` 的绝对路径 |
| `apiBase` | 接口前缀，形如 `/guoba/api/custom/your-plugin` |
| `logger` | 日志对象 |
| `registerPage(def)` | 注册单个页面 |
| `registerPages(list)` | 批量注册 |
| `registerApi(method, route, ...handlers)` | 注册接口，`method` 支持 get/post/put/delete/patch/all |

接口 handler 就是标准 express 风格 `(req, res, next)`，支持 async，抛错会被兜住并返回统一的错误 JSON。路由参数照常写，如 `/rules/:file`。

### 描述符字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 页面唯一标识，只允许 `^[A-Za-z0-9_-]+$`。与其他页面冲突时先注册的生效 |
| `title` | ✅ | 侧边栏标题 |
| `icon` | ❌ | emoji（如 `📊`）或 iconify 图标名（如 `ant-design:bar-chart-outlined`） |
| `html` | ⚠️ | 直接注入的 HTML 片段，与 `src` 二选一 |
| `src` | ⚠️ | `guoba/` 下的 HTML 文件，用 iframe 嵌入，优先于 `html` |
| `style` | ❌ | `guoba/` 下的 css 文件 |
| `script` | ❌ | `guoba/` 下的 js 文件 |
| `priority` | ❌ | 越小越靠前，默认 100 |

`src` / `style` / `script` 写相对 `guoba/` 的文件名（`dash.css`），不要写绝对路径或 `../`。

#### html 模式 vs src 模式

| | `style` / `script` | 适用 |
| --- | --- | --- |
| `html` | 自动注入到面板文档上 | 轻量片段，想复用面板的主题样式 |
| `src`（iframe） | **不注入**，在你的 HTML 里自己 `<link>` / `<script>` | 完整页面，样式脚本互不干扰 |

`src` 模式下 `style` / `script` 仍然要写 —— 它们是**文件访问白名单**，没声明的文件请求会返回 403：

```json
{
  "id": "dashboard",
  "title": "仪表盘",
  "icon": "📊",
  "src": "dash.html",
  "style": "dash.css",
  "script": "dash.js"
}
```

```html
<!-- guoba/dash.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="dash.css" />
</head>
<body>
  <h3>仪表盘</h3>
  <p id="stat">加载中…</p>
  <script src="dash.js"></script>
</body>
</html>
```

### 在页面里调接口

iframe 的地址上带了三个参数，直接读就行，不用自己拼路径：

| 参数 | 值 |
| --- | --- |
| `__apiBase` | 你的接口前缀，如 `/guoba/api/custom/your-plugin` |
| `__webBase` | 面板根路径，如 `/guoba` |
| `token` | 当前登录 token |

```js
// guoba/dash.js
const q = new URLSearchParams(location.search)
const apiBase = q.get('__apiBase')
const token = q.get('token')

const res = await fetch(`${apiBase}/data`, {
  headers: {'guoba-access-token': token},
})
const {result} = await res.json()
document.getElementById('stat').textContent = result.count
```

#### 写错了也能用

iframe 的入口 HTML 由锅巴下发，下发前会注入一小段兼容脚本，替页面兜住两类常见写法问题：

- 地址漏了 `custom/<插件名>` 两段（如 `${__webBase}/api/data`）→ 自动重写到正确前缀
- 请求没带 `guoba-access-token` → 自动补上（只对指向本页面接口的请求补，不会往别处泄露 token）

脚本还会挂一个 `window.__GUOBA__ = {apiBase, token, tokenKey}`，页面里可以直接取用。

兼容是兜底，按上面表格的写法仍是首选 —— 兼容层只认注册过的路由，写别的路径照样 404。

`html` 模式下页面跟面板同源同文档，接口地址从 `window.__GUOBA__` 里取（见上一节）。

## 三、鉴权与安全

- 所有 `/api/*`（含注册的自定义接口）都被登录鉴权覆盖，未登录返回 401。**用 `ctx.registerApi` 注册就自动生效**，不要绕过它去裸挂 `Bot.express.get(...)`。
- 静态资源走 `GET /<面板前缀>/api/custom-page/asset/<页面id>/<文件名>`，只放行描述符里声明过的 `src` / `style` / `script`，并限制后缀：`html js css json svg png jpg jpeg gif webp ico woff woff2 ttf map`。也就是说 `guoba/` 目录不会被整个暴露出去。
- iframe 里 `<link href="dash.css">` 这类相对引用带不上请求头，锅巴会种一个只对静态资源路径有效的弱令牌 Cookie 兜住鉴权，你不用管。
- **接口里读写文件务必自己做穿越防护**：拿到 `req.params` / `req.query` / `req.body` 里的文件名后，先显式拒绝含 `..` 的输入和不合法后缀，再 `path.join(baseDir, name)`，最后校验结果以 `baseDir + path.sep` 开头。别把用户输入直接拼进路径，也别用 `path.resolve` 去解析它。

## 四、生效与调试

- 面板里建的页面，保存即生效。
- 插件的页面在锅巴启动时扫描加载；只改了 HTML / CSS / JS，刷新浏览器即可；改了描述符（新增页面、改标题、加接口），点页面右上角的**重新扫描**，不用重启 Bot。
- 加载失败会在日志里打印 `[Guoba] 加载「xxx」自定义页面失败`，按提示修 `id` 或路径。
- 当前已加载的页面可以调 `GET /<面板前缀>/api/custom-page/list` 查看。
