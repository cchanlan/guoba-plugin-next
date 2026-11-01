import os from 'os'
import fs from 'fs'
import path from 'path'
import lodash from 'lodash'
import fetch from 'node-fetch'
import {exec, spawn} from 'child_process'
import {Service} from '#guoba.framework';
import {cfg, Constant, GuobaSupportMap, PluginsMap, _paths} from '#guoba.platform';
import {BotActions} from '#guoba.utils'
import {parsePluginsIndexByLocal, parseReadmeLink} from '../../helper/pluginsIndex.js'
import {getPluginIconPath, parseShowInMenu} from '../../utils/pluginUtils.js'

const GIT_HOST_RE = /(^|\.)(github\.com|gitee\.com|gitcode\.com|gitcode\.net|gitlab\.com|bitbucket\.org|gitea\.com)$/i

/**
 * 从仓库链接里取仓库名（最后一段，去掉 .git）。
 * 只认常见的托管站，免得把文档链接之类的末段当成仓库名。
 */
function getRepoName(link) {
  if (!link || typeof link !== 'string') {
    return null
  }
  try {
    const url = new URL(link.trim())
    if (!GIT_HOST_RE.test(url.hostname)) {
      return null
    }
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      return null
    }
    const name = segments[segments.length - 1].replace(/\.git$/i, '').trim()
    return name ? name.toLowerCase() : null
  } catch (e) {
    return null
  }
}

/**
 * 本地插件实际装的是哪个仓库：先看目录的 git 远端，取不到再看 guoba.support.js 的 link。
 * 插件市场里同名上游和 fork 各占一条，只按插件名会把上游认成已安装。
 */
function getLocalRepoName(pluginPath, pluginInfo) {
  try {
    const text = fs.readFileSync(path.join(pluginPath, '.git', 'config'), 'utf-8')
    let inOrigin = false
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim()
      if (/^\[remote\s+"origin"\]$/i.test(value)) {
        inOrigin = true
        continue
      }
      if (!inOrigin) {
        continue
      }
      if (value.startsWith('[')) {
        break
      }
      const match = value.match(/^url\s*=\s*(.+)$/i)
      if (match) {
        const repoName = getRepoName(match[1])
        if (repoName) {
          return repoName
        }
      }
    }
  } catch (e) {
    // 不是 git 仓库就退回 pluginInfo.link
  }
  return getRepoName(pluginInfo?.link)
}

export default class IPluginService extends Service {
  constructor(app) {
    super(app)
    // 本地插件扫描结果：读目录 + 逐个 import guoba.support.js 是记页面的热路径，
    // 缓存起来；刷新按钮 / 安装 / 卸载会带 force=true 重建
    this.localPluginsCache = null
    // 只读本地：远程索引等用户点「未安装」再拉。
    // pluginsPath 在子类构造里才赋值，这里让出一次微任务，别在父类构造期间就用它
    this.loadPlugining = Promise.resolve().then(() => this.getPlugins(false, false))
  }

  /**
   * 获取所有插件
   * @param force 是否清空缓存强制刷新
   * @param withRemote 是否拉取远程插件列表。false 时只读本地，进页面不用等索引仓库 pull
   * @return {Promise<*>}
   */
  async getPlugins(force = false, withRemote = true) {
    let remotePlugins = withRemote ? await this.getRemotePlugins(force) : []
    // 子类构造晚于父类，兜一下路径；正常调用时 this.pluginsPath 一定已有值
    const pluginsPath = this.pluginsPath || path.join(_paths.root, 'plugins')
    if (force || !this.localPluginsCache) {
      this.localPluginsCache = await this.readLocalPlugins(pluginsPath)
    }
    // 复制一份：下面会 splice 掉已认领的插件，别动到缓存数组
    let localPlugins = [...this.localPluginsCache]
    // 本地插件真实来自哪个仓库。同名上游和 fork 在用户眼里是两行，
    // 只按名字匹配会让上游（guoba-plugin）占走本地 fork（guoba-plugin-next）的状态
    const localRepoMap = new Map()
    for (let lp of localPlugins) {
      localRepoMap.set(lp, getLocalRepoName(path.join(pluginsPath, lp.dir || lp.name), lp))
    }
    const applyLocal = (rp, idx, keepMarketInfo = false) => {
      const lp = localPlugins[idx]
      if (keepMarketInfo) {
        // 仓库对得上但叫法不同（市场里的 fork 条目），保留市场那条的标题和作者，
        // 只用本地信息补上安装状态和目录，不然主人认不出装的是哪一条
        const {title, author, authorLink, description, link} = rp
        Object.assign(rp, lp, {title, author, authorLink, description, link, installed: true})
      } else {
        Object.assign(rp, lp, {installed: true})
      }
      localPlugins.splice(idx, 1)
    }
    // 先按仓库名认领：链接里的仓库名和本地 git 远端对得上才算同一个插件
    for (let rp of remotePlugins) {
      const repoName = getRepoName(rp.link)
      if (!repoName) {
        continue
      }
      const idx = localPlugins.findIndex(lp => localRepoMap.get(lp) === repoName)
      if (idx > -1) {
        const lp = localPlugins[idx]
        applyLocal(rp, idx, lodash.toLower(rp.name) !== lodash.toLower(lp.name))
      }
    }
    // 再按插件名 / 目录名兜底。目录名也参与：插件在 guoba.support.js 里把自己叫「R插件」时，
    // name 跟远程仓库名（rconsole-plugin）对不上，同一个插件就会既列一条「未安装」又列一条本地的。
    // 两边都说得出仓库名却对不上的，是同名不同源的另一个仓库，不能认
    for (let rp of remotePlugins) {
      if (rp.installed) {
        continue
      }
      const remoteRepoName = getRepoName(rp.link)
      const target = lodash.toLower(rp.name)
      const idx = localPlugins.findIndex(lp => {
        const nameMatched = lodash.toLower(lp.name) === target || (lp.dir && lodash.toLower(lp.dir) === target)
        if (!nameMatched) {
          return false
        }
        const localRepoName = localRepoMap.get(lp)
        return !(localRepoName && remoteRepoName && localRepoName !== remoteRepoName)
      })
      if (idx > -1) {
        applyLocal(rp, idx)
      }
    }
    if (localPlugins.length > 0) {
      for (let plugin of localPlugins) {
        remotePlugins.push({
          isV2: false,
          isV3: false,
          isDeleted: false,
          title: plugin.name,
          name: plugin.name,
          link: '',
          author: '未知',
          authorLink: '',
          description: '',
          installed: true,
          ...plugin,
        })
      }
    }
    // 处理config等信息
    for (let plugin of remotePlugins) {
      // 判断是否配置了 iconPath
      plugin.iconPath = getPluginIconPath(plugin)
      // 未安装的条目不该挂本地同名插件的配置：市场里同名不同源时，
      // 上游卡片会多出「可配置」和配置入口，点进去改的却是装着的 fork
      if (!plugin.installed) {
        continue
      }
      // 判断是否支持guoba
      let supportObject = GuobaSupportMap.get(plugin.name)
      if (!supportObject) {
        continue
      }
      // 判断是否支持配置项
      let {configInfo} = supportObject
      if (configInfo && configInfo.schemas && typeof configInfo.getConfigData === 'function') {
        plugin.hasConfig = true
        plugin.schemas = configInfo.schemas
        plugin.showInMenu = parseShowInMenu(supportObject)
      }
    }
    // 已安装的插件，排在前面
    return remotePlugins.sort((a, b) => {
      if (a.installed && !b.installed) {
        return -1
      }
      if (!a.installed && b.installed) {
        return 1
      }
      return 0
    })
  }

  /**
   * 读取本地插件信息
   * @param pluginsPath
   * @return {object[]}
   */
  async readLocalPlugins(pluginsPath) {
    let files = fs.readdirSync(pluginsPath)
    let plugins = []
    for (let name of files) {
      if (this.exclude && this.exclude.includes(name)) {
        continue
      }
      let filePath = path.join(pluginsPath, name)
      let stat = fs.statSync(filePath)
      if (stat.isDirectory()) {
        let jsPath = path.join(filePath, 'index.js')
        if (fs.existsSync(jsPath) || fs.existsSync(path.join(filePath, '.git/'))) {
          let plugin = {
            name: name.toLowerCase(),
          }
          jsPath = path.join(filePath, 'guoba.support.js')
          // 判断是否支持锅巴
          if (fs.existsSync(jsPath)) {
            try {
              // 判断是否是windows系统
              if (os.platform() === 'win32') {
                jsPath = 'file:///' + jsPath
              }
              let {supportGuoba} = await import(jsPath + '?' + Date.now())
              if (typeof supportGuoba === 'function') {
                // TODO 传什么参数？待定
                let supportObject = supportGuoba()
                if (supportObject.pluginInfo) {
                  plugin = Object.assign(plugin, supportObject.pluginInfo)
                }
                // 注册进锅巴
                GuobaSupportMap.set(plugin.name, supportObject)
              } else {
                throw 'supportGuoba必须要定义成一个方法！'
              }
            } catch (e) {
              logger.error(`[Guoba] 载入"${plugin.name}"插件的"guoba.support.js"失败：` + (e.message || e))
            }
          }
          PluginsMap.set(plugin.name, plugin)
          // 真实目录名，放在 pluginInfo 合并之后 —— 插件的 pluginInfo.name 常是「R插件」这类
          // 展示名（rconsole-plugin 就是），而 git 状态、更新、回滚全按目录走，
          // 名字对不上的话卡片上就看不到分支、更新和日志入口
          plugin.dir = name
          plugins.push(plugin)
        }
      }
    }
    return plugins
  }

  /**
   * 获取远程插件列表
   * @param force 是否清空缓存强制刷新
   * @return {Promise<*>}
   */
  async getRemotePlugins(force = false) {
    let redisKey = Constant.REDIS_PREFIX + 'plugins'
    let remotePlugins = null
    if (!force) {
      remotePlugins = await redis.get(redisKey)
    }
    if (remotePlugins) {
      return JSON.parse(remotePlugins)
    }
    try {
      const remotesMap = await parsePluginsIndexByLocal()
      if (!remotesMap) {
        return []
      }
      const {topPlugins = [], plugins = [], gamePlugins = []} = remotesMap;
      remotePlugins = [...topPlugins, ...plugins, ...gamePlugins]
    } catch (e) {
      logger.error(e)
    }
    // 读取失败……
    if (!remotePlugins || remotePlugins.length === 0) {
      return []
    }
    redis.set(redisKey, JSON.stringify(remotePlugins), {EX: 3600 * 6})
    return remotePlugins
  }

  async getReadmeText(link, force = false) {
    let redisKey = Constant.REDIS_PREFIX + 'plugin:readme:' + link
    let text = null
    if (!force) {
      text = await redis.get(redisKey)
    }
    if (text) {
      return text
    }
    let arr = link.split('/')
    let name = (arr.pop() || '').trim().replace(/\.git$/, '')
    let author = arr.pop()
    let url = ''
    if (/github\.com/i.test(link)) {
      url = `https://raw.githubusercontent.com/${author}/${name}/{branch}`
    } else if (/gitee\.com/i.test(link)) {
      url = `https://gitee.com/${author}/${name}/raw/{branch}`
    }
    if (url) {
      let baseUrl = ''
      let branches = ['master', 'main']
      for (let branch of branches) {
        baseUrl = url.replace('{branch}', branch)
        let response = await fetch(`${baseUrl}/README.md`)
        if (response.status === 200) {
          text = await response.text()
          break
        }
      }
      if (text) {
        text = parseReadmeLink(text, baseUrl)
        redis.set(redisKey, text, {EX: 3600 * 12})
        return text
      }
    }
    return ''
  }

  /**
   * 安装插件
   * @param link 插件链接
   * @param autoRestart 是否自动重启
   * @param autoNpmInstall 是否自动安装依赖
   * @return {Promise<{message: string, status: string}>}
   */
  async installPlugin(link, autoRestart, autoNpmInstall) {
    await this.initBotMethods();
    const name = link.split('/').pop().replace(/\.git$/, '');
    const pluginPath = `plugins/${name}`;

    if (await Bot.fsStat(pluginPath)) {
      return {status: 'error', message: `插件 ${name} 已安装`};
    }

    const githubReverseProxy = cfg.get('base.githubReverseProxy')
    let githubProxyUrl = cfg.get('base.githubProxyUrl')

    if (githubProxyUrl && !githubProxyUrl.endsWith('/')) {
      githubProxyUrl += '/'
    }

    const isGithubRepo = /github\.com/.test(link)

    const cloneUrl = isGithubRepo && githubReverseProxy && githubProxyUrl
      ? `${githubProxyUrl}${link}`
      : link;

    let result = await new Promise((resolve) => {
      const args = ['clone', '--depth', '1', '--single-branch', cloneUrl, pluginPath];
      logger.info(`[Guoba] 执行命令：${logger.blue('git ' + args.join(' '))}`);
      const child = spawn('git', args, {windowsHide: true});
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);
      child.on('close', (code) => {
        const error = code !== 0 ? new Error(stderr || `git clone exited with code ${code}`) : null;
        logger.mark(`[Guoba] 执行命令完成：${logger.blue('git clone')}${stdout ? `\n${stdout.trim()}` : ''}${stderr ? logger.red(`\n${stderr.trim()}`) : ''}`);
        if (error) {
          logger.mark(`[Guoba] 执行命令错误：${logger.blue('git clone')}\n${logger.red(error.message.trim())}`);
        }
        resolve({error, stdout, stderr});
      });
    });

    if (result.error) {
      logger.error(`[Guoba] 插件安装失败：${result.error}`);
      return {status: 'error', message: `插件 ${name} 安装失败\n${result.error}`};
    }

    if (autoNpmInstall && await Bot.fsStat(`${pluginPath}/package.json`)) {
      // 路径要加引号：Windows 的家目录常带空格（C:\Users\张 三\...），Linux 上也可能有。
      // cd 在 Windows 上不跨盘符切换，得给 /d
      const cd = process.platform === 'win32' ? `cd /d "${pluginPath}"` : `cd "${pluginPath}"`;
      result = await Bot.exec(`${cd} && pnpm install`);
      if (result.error) {
        logger.error(`[Guoba] 插件安装失败：${result.error}`);
        return {status: 'error', message: `插件安装失败：${result.error}`};
      }
    }

    if (autoRestart) {
      BotActions.doRestart();
    }

    return {status: 'success', message: `插件 ${name} 安装成功`};
  }

  async uninstallPlugin(name, autoRestart = true) {
    await this.initBotMethods();
    const pluginPath = `plugins/${name}`;
    if (await Bot.fsStat(pluginPath)) {
      let result = await Bot.rm(pluginPath)
      if (!result) {
        logger.error(`[Guoba] 插件卸载失败`);
        return {status: 'error', message: `插件 ${name} 卸载失败`};
      } else {
        if (autoRestart) {
          BotActions.doRestart()
        }
        logger.info(`[Guoba] 插件 ${name} 卸载成功`);
        return {status: 'success', message: `插件 ${name} 卸载成功`};
      }
    } else {
      return {status: 'error', message: `插件 ${name} 不存在`};
    }
  }

  /**
   * 批量卸载插件
   * @param {string[]} nameArr
   */
  async uninstallPluginBatch(nameArr) {
    let texts = []
    for (let i = 0; i < nameArr.length; i++) {
      const name = nameArr[i]
      // 最后一个插件卸载时自动重启
      const autoRestart = i === nameArr.length - 1
      let {message} = await this.uninstallPlugin(name, autoRestart)
      texts.push(message)
    }
    return {status: 'success', message: texts.join('\n')}
  }

  async initBotMethods() {
    Bot.fsStat = Bot.fsStat || ((path) => {
      return new Promise((resolve) => {
        fs.stat(path, (err, stats) => {
          if (err) {
            logger.trace(`[Guoba] 获取${path}状态错误：${err}`);
            resolve(false);
          } else {
            resolve(stats);
          }
        });
      });
    });

    Bot.exec = Bot.exec || ((cmd, opts = {}) => {
      return new Promise((resolve) => {
        if (!opts.quiet) {
          logger.info(`[Guoba] 执行命令：${logger.blue(cmd)}`);
        }
        opts.windowsHide = opts.windowsHide ?? true;
        exec(cmd, opts, (error, stdout, stderr) => {
          resolve({error, stdout, stderr});
          if (opts.quiet) {
            return
          }
          logger.mark(`[Guoba] 执行命令完成：${logger.blue(cmd)}${stdout ? `\n${String(stdout).trim()}` : ""}${stderr ? logger.red(`\n${String(stderr).trim()}`) : ""}`);
          if (error) {
            logger.mark(`[Guoba] 执行命令错误：${logger.blue(cmd)}\n${logger.red((error?.message || error)?.trim?.() ?? '未知错误')}`);
          }
        });
      });
    });

    Bot.rm = Bot.rm || ((file) => {
      return new Promise((resolve) => {
        fs.rm(file, {force: true, recursive: true}, (err) => {
          if (err) {
            logger.trace(`[Guoba] 删除${file}错误：${err}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    });
  }
}
