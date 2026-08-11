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
| **沙盒** | 侧边栏「沙盒」。在网页里伪造一条消息喂给插件加载器，把回复截在面板里显示，不发到 QQ。支持群聊 / 私聊切换、场景配置（发送者 QQ、群号、主人 / 群主 / 管理员、是否 @机器人）、插件规则浏览与正则匹配预览、图片收发、转发消息与语音视频渲染。详见下方「沙盒说明」 |
| **数据浏览** | 侧边栏「数据浏览」。浏览 / 编辑 Redis（各类型 key、TTL、执行命令）与 SQLite（表结构、分页查数据、执行 SQL） |
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

### 四、沙盒说明

沙盒页手工构造一个与 `Bot.prepareEvent()` 结构一致的事件对象，绕开 `Bot.em()` 直接交给 `PluginsLoader.deal()`，因此不经过任何适配器，回复不会真的发到 QQ。用来验证插件是否响应某句指令、回复长什么样，不必真去群里刷屏。

用之前请注意三点：

- **跑的是真实插件代码。** 写数据库、调外部接口、扣次数这类副作用照样会发生，沙盒只拦回复，不拦副作用
- **只拦 `e` 上下文。** `e.reply()`、`this.reply()`、`e.group.sendMsg()` 等都会被截住；插件若绕开 `e` 直接用全局 `Bot.pickGroup(真实群).sendMsg()` 主动发消息，沙盒拦不住，仍会真的发出去
- 沙盒消息会经 `loader.count()` 计入 `Yz:count:*`，首页消息统计里包含沙盒条数

`e.bot` 是真实 Bot 的 Proxy，只在 `pickFriend` / `pickUser` / `pickGroup` / `pickMember` 命中沙盒自己的 id 时才换成假对象，所以插件读 `Bot.fl`、`getGroupList()` 拿到的仍是真实数据。回复里的图片 / 语音 / 视频 / 文件存在服务端内存中（30 分钟 TTL、最多 60 项、单个上限 20MB），前端按需拉取，不走 base64 塞进 JSON。

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
