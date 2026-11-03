# Guoba-Plugin Next

`Yunzai-Bot` 的后台管理面板插件。

> **Fork 自 [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)（v1.4.2）**，
> 原作者 [@Zolay-Poi](https://gitee.com/zolay-poi)，遵循原项目协议。
> 本 Fork 重写了整套前端并新增若干功能，见下方「相对原版」。

仅支持 V3 的 Yunzai（V2 只支持迁移到 V3）。已适配 **Miao-Yunzai**、**TRSS-Yunzai** 及其 fork
（如 [Orangezai](https://github.com/zhiyu1998/Orangezai)）、以及 **[JiuLi](https://gitee.com/fox-glaze/jiuli)**
——TRSS 系靠能力而非名字识别，换名字的 fork 与兼容框架也会自动共享端口挂在 `/guoba` 下。

装好后发 `#锅巴帮助` 看功能。

## 相对原版

**前端整体重写**：Vue3 + Vite，页面结构、交互、暗色主题全部重做，移动端可用。

**新增的页面 / 能力**

| 功能 | 一句话 |
| --- | --- |
| 运行日志 | 实时看日志、按级别筛、关键词搜；可定时清理 `logs`；聊天里 `#锅巴日志` 出图 |
| 消息记录 | 真收真发的聊天页：会话列表、真实消息流、右键菜单（复读 / 撤回 / 引用 / 戳一戳 / 收藏表情）、图片收发；表情面板支持 QQ 自带表情、bot 收藏的表情和自己上传的表情；消息里的图片和动图可收藏为自定义表情，单张不超过 20MB |
| 沙盒 | 在网页里伪造消息喂给插件，回复截在面板里不发到 QQ；按钮可点，Markdown / 转发都能渲染 |
| 数据浏览 | Redis（各类型 key、TTL、执行命令）与 SQLite（表结构、分页、执行 SQL） |
| 文件管理 | 浏览 / 编辑 Yunzai 根目录下的文件，上传下载、打包 zip（边打边传） |
| 插件更新 | 显示分支与落后提交数，单个或批量更新；有本地改动可暂存 / 丢弃；能一键回滚 |
| 终端 | 网页 shell，长驻会话、流式输出、命令历史；危险命令弹确认；Windows 用 PowerShell |
| 扩展页面 | 插件可自带页面，也能在面板内新建（见 [docs/custom-page.md](./docs/custom-page.md)） |
| 登录安全 | 密码 + 新设备验证码（私聊发主人），可信设备 90 天、认设备不认 IP，可查看 / 撤销；登录令牌 7 天、随用随续，一直在用就一直不掉线 |
| 好友群聊群发 | 勾选目标后台异步群发，进度可看、可中止、失败明细可查 |
| 首页面板 | CPU / 内存 / 磁盘 / 运行时长，收发消息量与 7 天趋势 |
| 网页截图 | 群里发个网址就截图预览（默认关闭、默认仅主人可用）；要过人机验证、要登录、打不开、空白、会印出服务器 IP 的页面都不发图也不回话 |

**修复与改进**：配置项读写、插件列表识别（按目录而非 name）、TRSS 系宿主兼容、
移动端布局、日志与消息接口的增量拉取等，细节见提交历史。

## 安装

**① 下载** —— 在云崽根目录执行，三个源任选一个（内容完全一样，推荐国内的）

**gitcode（国内直连最快）**
```bash
git clone --depth=1 https://gitcode.com/ccxhan/guoba-plugin-next.git ./plugins/Guoba-Plugin/
```

**gitee（国内）**
```bash
git clone --depth=1 https://gitee.com/longhengmu/guoba-plugin-next.git ./plugins/Guoba-Plugin/
```

**GitHub**
```bash
git clone --depth=1 https://github.com/cchanlan/guoba-plugin-next.git ./plugins/Guoba-Plugin/
```

**② 装依赖**

用 pnpm 装的云崽（大多数情况）：

```bash
pnpm install --filter=guoba-plugin
```

> 必须带 `--filter`，否则可能把其它依赖弄丢。不是 pnpm 装的云崽**别用**这条。

用 npm / cnpm 的：

```bash
npm install express multer jsonwebtoken
```

**③ 启动** —— 重启云崽，控制台会打印面板地址。

端口在**首次启动时随机生成**（20000–59999），写进 `config/application.yaml`，之后不会再变，
想改就在那份配置里改。不给所有人一个固定默认端口，是因为固定端口扫一遍网段就能找到所有面板。
TRSS 系宿主会自动共享宿主的 HTTP 端口，挂在 `/guoba` 路径下。

**默认只允许局域网访问面板。** 判定条件是「和服务器落在同一网段」，所以家里用公网 IPv6
地址打开也算局域网（IPv6 没有 NAT，家里设备的源地址就是运营商给的公网地址）；
手机流量这类真的从外面来的请求会看到一个提示页。想临时从外网打开，聊天里发
`#开启锅巴外网`，用完发 `#关闭锅巴外网`。开启后的地址带公网 IP，群里只回一句结果，地址只私聊发给「安全通知接收人」（没设置就发给发指令的主人），不会发到群里。

## 更新

面板「插件管理」里点更新，或聊天里发 `#锅巴更新`。

## 前端开发

前端在 `web/`，`pnpm dev` 起开发服务器，`pnpm build` 产物输出到 `server/static/`。

# 安全加固

面板自带几条默认收紧的策略，都在 `config/application.yaml` 里可调：

- **文件管理默认只能写入 `data` / `logs` / `temp`**，其余目录（含 `plugins`、`config`）只读。
  往插件目录写文件等于执行代码，所以默认不开放；确实要在面板里改代码，再把目录加进
  `security.fileWriteScopes`（加了 `plugins` 就等于把提权通道重新打开；填 `*` 则是整个云崽目录都可写）。
- **网页终端默认关闭**（`security.enableTerminal: false`），它等同服务器 shell。
- 装插件、改插件配置、备份还原、改面板配置都要先过二级密码。
- 登录密码 / 二级密码连错 3 次会冻结，只有主人能在聊天里发「#锅巴解冻」解除，**不会自动过期**：
  - 外网来源连错：只关掉对外端口，局域网照常打开面板，机器人照常在线；
  - 局域网来源连错：整个面板冻结，所有登录作废，机器人照常在线。
- 面板默认不对**外网**开放，只认局域网（含同网段的公网 IPv6）来的请求；
  需要从外网访问时发「#开启锅巴外网」，用完发「#关闭锅巴外网」；地址只私聊发给指定的主人，不会回在群里。
- 修改 / 重置账号密码、面板冻结都会私聊通知主人，并写入 `data/guoba/security-audit.log`。

# 免责声明

面板能改配置、读文件、执行命令，**务必不要把端口直接暴露到公网**。
建议只在内网或通过反向代理 + 额外鉴权访问。

**不要把云崽跑在 root 下** —— 面板的权限就是进程的权限，上面的限制只能挡住面板内的
误操作和提权路径，挡不住进程本身就是 root 这件事。使用本插件造成的任何后果自行承担。

# 致谢

- [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin) —— 原项目，作者 [@Zolay-Poi](https://gitee.com/zolay-poi)
- [Yunzai-Bot](https://github.com/yoimiya-kokomi/Yunzai-Bot) / [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) / [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) / [JiuLi](https://gitee.com/fox-glaze/jiuli) —— 宿主框架
- [Ant Design Vue](https://antdv.com/) · [Vue3](https://vuejs.org/) · [Vite](https://vitejs.dev/) —— 前端基建

# 开源协议

[GPL-3.0-or-later](LICENSE) © 2026 cchanlan

本仓库基于 [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)（作者
[@Zolay-Poi](https://gitee.com/zolay-poi)）二次开发，遵循同一协议。
