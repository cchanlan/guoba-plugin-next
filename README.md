# Guoba-Plugin Next

`Yunzai-Bot` 的后台管理面板插件。

> **Fork 自 [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin)（v1.4.2）**，
> 原作者 [@Zolay-Poi](https://gitee.com/zolay-poi)，遵循原项目协议。
> 本 Fork 重写了整套前端并新增若干功能，见下方「相对原版」。

仅支持 V3 的 Yunzai（V2 只支持迁移到 V3）。已适配 **Miao-Yunzai**、**TRSS-Yunzai** 及其 fork
（如 [Orangezai](https://github.com/zhiyu1998/Orangezai)）——TRSS 系靠能力而非名字识别，
换名字的 fork 也会自动共享端口挂在 `/guoba` 下。

装好后发 `#锅巴帮助` 看功能。

## 相对原版

**前端整体重写**：Vue3 + Vite，页面结构、交互、暗色主题全部重做，移动端可用。

**新增的页面 / 能力**

| 功能 | 一句话 |
| --- | --- |
| 运行日志 | 实时看日志、按级别筛、关键词搜；可定时清理 `logs`；聊天里 `#锅巴日志` 出图 |
| 消息记录 | 真收真发的聊天页：会话列表、真实消息流、右键菜单（复读 / 撤回 / 引用 / 戳一戳）、图片收发 |
| 沙盒 | 在网页里伪造消息喂给插件，回复截在面板里不发到 QQ；按钮可点，Markdown / 转发都能渲染 |
| 数据浏览 | Redis（各类型 key、TTL、执行命令）与 SQLite（表结构、分页、执行 SQL） |
| 文件管理 | 浏览 / 编辑 Yunzai 根目录下的文件，上传下载、打包 zip（边打边传） |
| 插件更新 | 显示分支与落后提交数，单个或批量更新；有本地改动可暂存 / 丢弃；能一键回滚 |
| 终端 | 网页 shell，长驻会话、流式输出、命令历史；危险命令弹确认；Windows 用 PowerShell |
| 扩展页面 | 插件可自带页面，也能在面板内新建（见 [docs/custom-page.md](./docs/custom-page.md)） |
| 登录安全 | 密码 + 新设备验证码（私聊发主人），可信设备 90 天、认设备不认 IP，可查看 / 撤销 |
| 好友群聊群发 | 勾选目标后台异步群发，进度可看、可中止、失败明细可查 |
| 首页面板 | CPU / 内存 / 磁盘 / 运行时长，收发消息量与 7 天趋势 |

**修复与改进**：配置项读写、插件列表识别（按目录而非 name）、TRSS 系宿主兼容、
移动端布局、日志与消息接口的增量拉取等，细节见提交历史。

## 安装

**① 下载** —— 在云崽根目录执行

```bash
git clone --depth=1 https://gitcode.com/ccxhan/guoba-plugin-next.git ./plugins/Guoba-Plugin/
# GitHub 也行：https://github.com/cchanlan/guoba-plugin-next.git
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

默认端口 `50831`（在 `config/application.yaml` 改）。TRSS 系宿主会自动共享宿主的 HTTP 端口，
挂在 `/guoba` 路径下。

## 更新

面板「插件管理」里点更新，或聊天里发 `#锅巴更新`。

## 前端开发

前端在 `web/`，`pnpm dev` 起开发服务器，`pnpm build` 产物输出到 `server/static-next/`。

# 免责声明

面板能改配置、读文件、执行命令，**务必不要把端口直接暴露到公网**。
建议只在内网或通过反向代理 + 额外鉴权访问。使用本插件造成的任何后果自行承担。

# 致谢

- [guoba-yunzai/guoba-plugin](https://github.com/guoba-yunzai/guoba-plugin) —— 原项目，作者 [@Zolay-Poi](https://gitee.com/zolay-poi)
- [Yunzai-Bot](https://github.com/yoimiya-kokomi/Yunzai-Bot) / [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) / [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) —— 宿主框架
- [Ant Design Vue](https://antdv.com/) · [Vue3](https://vuejs.org/) · [Vite](https://vitejs.dev/) —— 前端基建

