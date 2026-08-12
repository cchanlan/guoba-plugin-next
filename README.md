# Guoba-Plugin Next

`Yunzai-Bot` 的后台管理面板插件。

> **本项目 Fork 自 [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)（v1.4.2）**，
> 原项目作者 [@Zolay-Poi](https://gitee.com/zolay-poi)，遵循原项目协议。
>
> 上游地址：[GitHub](https://github.com/guoba-yunzai/guoba-plugin) · [Gitee](https://gitee.com/guoba-yunzai/guoba-plugin)
>
> 本 Fork 重写了整套前端，并新增了若干功能，详见下方「相对原版的改动」。

管理面板仅支持 V3 版本的 Yunzai；V2 版本仅支持迁移至 V3 功能。
具体功能可在安装插件后，通过发送 `#锅巴帮助` 查看。

---

## 相对原版的改动

### 一、前端整体重写

原版前端基于 Vue2 + ant-design-vue 1.x，本 Fork 用 **Vue 3 + TypeScript + ant-design-vue 4 + Vite** 重写了一套，源码在 `web/`，构建产物输出到 `server/static-next/`。

- 新增暗色 / 亮色主题，跟随系统或手动切换
- 图标改用内置的 ant-design 图标集（`web/src/components/icons/offline.ts`），**不依赖 iconify 公共 API**，离线环境也能正常显示
- 移动端适配

> 两套前端**共存**：`utils/paths.js` 会检测 `server/static-next/index.html`，存在则用新版，删掉该目录即自动回落到原版 `server/static/`。不喜欢新界面可以随时退回。

### 二、新增功能

| 功能 | 说明 |
| --- | --- |
| **运行日志** | 侧边栏「运行日志」。实时查看 Bot 日志，支持按级别筛选、关键词搜索、清空。增量拉取，不重复传已看过的行 |
| **消息记录** | 侧边栏「消息记录」。真收真发的聊天页：左侧群聊 / 私聊列表（搜索、未读、按最近活跃排序），中间真实消息流（头像、昵称、群头衔、时间、引用、合并转发可展开），右键菜单：@提及、复制、查看原始消息、复读、戳一戳、引用、撤回；底部「普通 / 发送 Raw」两档输入，支持图片（粘贴或选择，multipart 上传）。详见下方「消息记录说明」 |
| **沙盒** | 侧边栏「沙盒」。在网页里伪造一条消息喂给插件加载器，把回复截在面板里显示，不发到 QQ。支持群聊 / 私聊切换、场景配置（发送者 QQ、群号、主人 / 群主 / 管理员、是否 @机器人）、插件规则浏览与正则匹配预览、图片收发，回复里的按钮可以直接点，Markdown、转发消息、语音视频均能渲染。详见下方「沙盒说明」 |
| **数据浏览** | 侧边栏「数据浏览」。浏览 / 编辑 Redis（各类型 key、TTL、执行命令）与 SQLite（表结构、分页查数据、执行 SQL） |
| **文件管理** | 侧边栏「文件管理」。浏览 / 编辑 **Yunzai 根目录**下的文件：目录列表 + 面包屑，文本文件在页面里改，支持上传 / 下载、新建 / 重命名 / 删除。访问限定根目录内，二进制 / 超大文件只能下载。详见下方「文件管理说明」 |
| **终端** | 侧边栏「终端」。网页里的 shell：长驻会话（`cd` / 变量 / 管道状态保持），命令输出流式回显，支持命令历史、清屏、重启；危险命令（`rm -rf`、`mkfs`、`shutdown` 等）执行前弹确认。Windows 部署自动用 PowerShell。详见下方「终端说明」 |
| **扩展页面** | 插件可以自带页面挂到面板里，也能在面板内直接新建页面（写 HTML/CSS/JS + 接口）。详见 [`docs/custom-page.md`](./docs/custom-page.md) |
| **聊天确认登录** | 网页点「聊天登录」，主人在聊天里发 `#锅巴确认登录` 即可进面板，不用去控制台抄验证码。多个请求同时等待时可带 4 位短码区分 |
| **好友 / 群聊群发** | 账号管理页勾选目标后群发消息。后台异步执行 + 进度轮询，可中途停止，失败明细可查。可选范围：已勾选 / 当前页 / 全部 |
| **首页系统状态** | CPU、内存、磁盘占用与运行时长，定时刷新 |
| **首页消息统计** | 收发消息量与近 7 天趋势图，按 Bot 账号分列 |

### 三、修复与改进

- **天气接口失效修复**：原版用的 `data/cityinfo` 接口已下线（返回 200 但内容是 HTML，导致 `response.json()` 抛错），改用仍在服务的 `dingzhi` 接口
- **城市可选列表**：原本要手填城市名，现在可以从完整列表里搜索选择
- **多账号操作准确性**：好友 / 群聊的删除、退群、发消息改为按 `bot_id` 精确取操作对象，避免 `Bot.pickXxx` 在多账号下"随机选号"把操作发到别的账号上
- **首页立绘不再依赖喵喵**：原版没装 miao-plugin 时首页显示一张"没有安装喵喵插件"的灰色占位图，现在改为回落到 `resources/images/hero/` 下的图片。往该目录丢图即自动参与随机，不用改代码
- **立绘白边处理**：喵喵的面板图素材构图带大片留白，现在用 sharp 自动裁边并限高，首页不再出现大块白边

### 四、消息记录说明

消息记录页与沙盒正好相反，走的是真实链路：消息来自适配器（`Bot.on('message')` 实时事件）与 QQ 服务端（`getChatHistory` 历史记录），页面上发出去的消息**会真的出现在群里**。

| | 沙盒 | 消息记录 |
| --- | --- | --- |
| 消息来源 | 网页里伪造 | 适配器真实收到的 |
| 发出去的消息 | 不出网，截在页面里 | 真的发到 QQ |
| 插件 | 真实执行 | 不参与（页面直接调适配器） |
| 用途 | 调指令、看回复长什么样 | 看群里发生了什么、临时回一句 |

打开会话时先拉一屏历史（默认 20 条），往上滚按 `message_seq` 继续翻页；同时按 2 秒轮询取实时增量（同运行日志的增量游标做法，后端环形缓冲约 1000 条）。用之前请注意：

- **历史依赖适配器能力。** OneBot v11（NapCat / Lagrange 等）可以拉；其他适配器没有 `getChatHistory`，页面会提示「只能看到面板运行期间收到的消息」
- **消息只在内存里**（约 1000 条，超了从头挤），**重启即丢**，要长期留存请用 QQ 客户端
- **发图走 multipart 上传**，不在 JSON body 里塞 base64（那样会撞上后端 `express.json` 的 100kb 上限，报 413）。粘贴或选择图片后点右下角的圆形发送键，单张上限 20MB、一次最多 5 张
- **撤回**只对机器人自己发的、或机器人有管理权限的消息生效，且有时限（QQ 侧限制），失败会把适配器的报错原样显示
- **图片走 QQ 直链**，腾讯的 `rkey` 有时效，过期后加载失败会自动改由服务端代拉一次 —— 代理只放行适配器上报过的地址（精确匹配，随缓冲淘汰），且内网地址一律不代拉，不是任意 URL 转发
- **「发送 Raw」档**把 JSON 段数组直接交给适配器，等价于插件里写 `e.reply([{type: 'text', text: 'hi'}])`，用来试按钮、markdown、自定义段这些普通档拼不出来的东西。非法 JSON 在前端就挡下，不会发出任何东西
- 真实消息里的按钮段（Raw 档发的）点击时只把文本填进输入框，不会一点就发出去 —— 这里是真发，得由人确认

#### 右键菜单

在任意一条消息上**右键**（悬浮时左下角也有「更多」入口）可以：

- **@提及**：把这条消息的发送者塞进输入框的 @ 列表（chip 可删、最多 5 个），发送时转成真 `at` 段，并**自动在 @ 后面补一个空格**，不会出现「@张三文字」贴在一起
- **复制**：复制这条消息的纯文本
- **查看原始消息**：弹窗展示这条消息的完整 JSON（段 + 元信息），排障用
- **复读**：按段原样再发一条 —— 图片取回字节、表情带 id，**不会降级成「[图片]」文字**；引用 / 按钮 / Markdown 这些没法原样重发的段会跳过
- **戳一戳**：走适配器底层的 `sendApi` 发 OneBot 动作。OneBot v11 协议没有标准 poke，各家实现叫法不同（NapCat `send_poke`、Lagrange `set_poke`、llob `poke` / `send_group_poke` …），后端按候选列表**逐个试、谁认用谁**，不用为每种实现单独适配
- **引用** / **撤回**（撤回只对 bot 自己发的、或有管理权限的消息生效，且有时限）

被 @ / 消息的昵称做了兜底：有的实现（如 llob）上报消息时不带 sender 昵称，后端会把最近见过的同名 userId 记下来自动补上，不会只显示一个 QQ 号。

### 五、文件管理说明

文件管理页操作的是 **Yunzai 根目录**（`/root/Yunzai`），网页里的改动直接写进磁盘，请当成在服务器上操作一样小心。

- 访问**限定在根目录内**：后端每次解析路径都校验，`../`、绝对路径这类越界直接拒绝；上传文件名会清洗掉路径分隔符，`..` 开头的直接拒绝
- **文本编辑限 2MB**，二进制文件（含空字节）不能在页面里改，只能下载 —— 要改大文件 / 二进制请先下载到本地
- **删除文件夹是递归的**，内容一起删且不可恢复，前端有二次确认
- 目录一次拉全量列表，文件特别多的目录（如 `node_modules`）打开会慢一点

### 六、终端说明

终端页起一个**长驻 shell 会话**（Linux 用 bash、Windows 用 PowerShell），命令写进 shell 的 stdin、输出流式回显到页面，`cd` / 变量 / 管道状态都保持，跟真终端一致。

- **等同服务器 shell**：命令在面板进程所在环境执行，装依赖、改文件、删东西、重启 Bot 都干得出来，且改动立即生效 —— 只有登录面板的人能碰（走锅巴的登录鉴权），页面顶部也有提示
- **危险命令弹确认**：`rm -rf`、`mkfs`、`dd`、`shutdown` / `reboot`、fork bomb、写 `/dev/*` 这类命令执行前会弹框确认，避免手滑
- **长驻会话**是内存态，重启 Bot 后 shell 会话丢失（页面点「重启」恢复）；「清屏」只清页面显示，「重启」清空整个会话
- 输出轮询拉取（约 0.5 秒一次增量），不是 WebSocket —— 依赖锅巴 HTTP 登录，不额外开通道
- **Windows 适配**：自动用 `powershell.exe`（spawn 带 `windowsHide` 不弹黑窗）；PowerShell 默认输出编码可能中文乱码，页面提示先执行 `chcp 65001`
- 交互式程序（`top`、`vi` 这类要 TTY 的）没有终端模拟层，跑起来行为会异常，普通命令不受影响

### 七、沙盒说明

沙盒页手工构造一个与 `Bot.prepareEvent()` 结构一致的事件对象，绕开 `Bot.em()` 直接交给 `PluginsLoader.deal()`，因此不经过任何适配器，回复不会真的发到 QQ。用来验证插件是否响应某句指令、回复长什么样，不必真去群里刷屏。

用之前请注意三点：

- **跑的是真实插件代码。** 写数据库、调外部接口、扣次数这类副作用照样会发生，沙盒只拦回复，不拦副作用
- **只拦 `e` 上下文。** `e.reply()`、`this.reply()`、`e.group.sendMsg()` 等都会被截住；插件若绕开 `e` 直接用全局 `Bot.pickGroup(真实群).sendMsg()` 主动发消息，沙盒拦不住，仍会真的发出去
- 沙盒消息会经 `loader.count()` 计入 `Yz:count:*`，首页消息统计里包含沙盒条数

`e.bot` 是真实 Bot 的 Proxy，只在 `pickFriend` / `pickUser` / `pickGroup` / `pickMember` 命中沙盒自己的 id 时才换成假对象，所以插件读 `Bot.fl`、`getGroupList()` 拿到的仍是真实数据。回复里的图片 / 语音 / 视频 / 文件存在服务端内存中（30 分钟 TTL、最多 60 项、单个上限 20MB），前端按需拉取，不走 base64 塞进 JSON。

#### 模拟平台：普通消息 / Markdown + 按钮

顶栏可以切换沙盒模拟的目标平台，这一栏影响的是**插件走哪条分支**，以及**按钮和 Markdown 段要不要渲染**：

| | 普通消息（默认） | Markdown / 按钮 |
| --- | --- | --- |
| `e.bot.adapter.name` | `锅巴沙盒` | `QQBot` |
| `e.bot.config.markdown` | 无 | `{type: 1}` |
| button / markdown 段 | 折叠标注「当前平台不显示」 | 正常渲染 |

在 TRSS 上插件一般是无条件带上 `segment.button(...)` 的，能不能显示取决于目标平台 —— OneBot 那边这些段会被适配器丢掉，只有 QQ 官方 Bot 才渲染，所以切平台才能把两种效果都预览准。另有不少插件读 `e.bot.adapter.name` 决定发什么（各家的 QQBot 分支），一并跟着切换。

按钮点击行为与 QQ 官方 Bot 一致：`callback` 点了直接当成一条新消息发出去，`input` 只填进输入框等你补参数，`link` 交给浏览器打开。三者都没有的按钮会置灰 —— 真实环境里点它也没反应。Markdown 只有 `content` 形式的能渲染（渲染后过 DOMPurify），原生模板（模板 id + params）的内容在 QQ 服务端，本地无从还原，只能摊出原始数据。

---

## 安装插件

#### 第 1 步：下载插件

在云崽根目录下打开终端，运行：

* 使用 GitCode（国内推荐）
``` bash
git clone --depth=1 https://gitcode.com/ccxhan/guoba-plugin-next.git ./plugins/Guoba-Plugin/
```

* 使用 GitHub
``` bash
git clone --depth=1 https://github.com/cchanlan/guoba-plugin-next.git ./plugins/Guoba-Plugin/
```

> 注：目录名必须是 `Guoba-Plugin`，不要改。

#### 第 2 步：安装依赖

##### 方式1：采用 pnpm

> 注：如果你不是通过`pnpm`安装的云崽，那么请【**不要**】使用此方式，请看`方式2`

如果你是使用`pnpm`安装的云崽，那么只需要在云崽根目录下运行此命令即可：

```bash
pnpm install --filter=guoba-plugin
```

> 注：请务必直接复制提供的命令，否则可能会导致依赖丢失的情况，若发生需自行重新安装。<br>
> `--filter=guoba-plugin`：只安装`guoba-plugin`下的依赖，其他依赖不处理，防止丢失。

##### 方式2：采用 npm 或 cnpm

如果是使用`npm`或`cnpm`等其他依赖安装工具，需要手动安装以下依赖：

```bash
npm install express multer jsonwebtoken
```

如果以上命令执行失败，可尝试使用`cnpm`进行安装，只需将开头的`npm`替换成`cnpm`即可。

> 注：cnpm需要单独安装，已安装的可以忽略，安装命令如下：<br>
> `npm install cnpm -g --registry=https://registry.npmmirror.com`

#### 第 3 步：运行插件

依赖安装完毕之后，直接运行即可，默认运行端口号是：50831

> 可在 config/application.yaml 中修改

启动完成之后，可以在控制台中看到网页地址，复制到浏览器中即可访问。

如果访问不到，请发送`#锅巴帮助`指令获取帮助。

## 更新插件

一般会自动更新，如需手动更新，请发送`#锅巴更新`指令

## 前端开发

改前端才需要，只是使用插件的话跳过这节 —— 仓库里已经带了构建产物。

```bash
cd web
pnpm install
pnpm dev        # 开发，需要 Bot 已在运行
pnpm build      # 构建到 ../server/static-next
pnpm typecheck  # 类型检查
```

---

# 免责声明

1. 功能仅限内部交流与小范围使用，严禁将本插件用于任何商业用途或盈利
2. 图片与其他素材均来自于网络，仅供交流学习使用，如有侵权请联系，会立即删除
3. `resources/images/hero/` 下的角色立绘来自 [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) 的素材，版权归原作者及米哈游所有，仅作展示用途。介意可自行删除该目录下的 `miao-*.webp`，面板会回落到自带的兜底图

# 致谢

- 原项目 [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) 及其作者 [@Zolay-Poi](https://gitee.com/zolay-poi)
- 插件安装/卸载功能 [@0卡苏打水](https://github.com/CikeyQi)
- 喵喵帮助编辑 [@realhuhu](https://github.com/realhuhu)

# 其他

* Yunzai-Bot
    - [gitee](https://gitee.com/Le-niao/Yunzai-Bot)
    - [github](https://github.com/Le-niao/Yunzai-Bot)
* Yunzai插件索引
    - [gitee](https://gitee.com/yhArcadia/Yunzai-Bot-plugins-index)
    - [github](https://github.com/yhArcadia/Yunzai-Bot-plugins-index)
* Miao-Plugin
    - [gitee](https://gitee.com/yoimiya-kokomi/miao-plugin)
    - [github](https://github.com/yoimiya-kokomi/miao-plugin)
