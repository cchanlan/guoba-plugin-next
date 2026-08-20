import fs from 'node:fs'
import path from 'node:path'
import {parseReadmeInstall} from './readmeInstall.js'

/**
 * 给单个插件装依赖。
 *
 * 备份还原（clone 回来的插件）和插件更新（package.json 变了）都要做这件事，规则必须一致 ——
 * 否则会出现「还原时装了 README 里写的额外依赖、更新后没装」这种难查的差异，所以抽在这里。
 *
 * 命令怎么起、日志往哪写由调用方注入：两个 Service 各有自己的子进程管理（取消、杀进程）
 * 和任务日志缓冲。
 */

/** 插件目录名允许的字符。要拼进命令行，先卡死 */
export const PLUGIN_NAME_RE = /^[\w.-]+$/

/** README / package.json 最多读 1 MiB，外部仓库不能拿超大文档拖垮流程 */
export const README_MAX_SIZE = 1024 * 1024

/** 装依赖用的包管理器。Yunzai 是 pnpm workspace，只能是 pnpm */
export const PNPM = 'pnpm'

/**
 * 起 pnpm 要不要过 shell。
 *
 * Windows 上 pnpm 是 `pnpm.cmd`，而 Node 18.20 / 20.12 起 spawn 一个 `.cmd` 不过 shell 会
 * 直接抛 `EINVAL`（CVE-2024-27980 的修复）—— 那边必须过 shell，否则依赖安装一次都成功不了。
 * 传给 pnpm 的参数全是硬编码常量，没有用户输入拼进命令行，过 shell 是安全的。
 */
export const NEED_SHELL = process.platform === 'win32'

/** `lodash@4` / `@scope/pkg@1` → 包名部分，用来判断 README 里的包是不是已经声明过了 */
export function packageBaseName(spec) {
  const s = String(spec || '')
  if (s.startsWith('@')) {
    const at = s.indexOf('@', 1)
    return at === -1 ? s : s.slice(0, at)
  }
  return s.split('@')[0]
}

/**
 * 装一个插件的依赖。
 *
 * package.json 是主来源，固定从根用路径 filter 安装，避免插件 cwd 的 pnpm install 把整个
 * workspace 重装一遍。README 只扫描安全代码块，原始文本绝不进 shell；额外包统一转成
 * `pnpm --filter ./plugins/<name> add`，这样最后一次根 install 后也不会丢。
 *
 * @param {string} root Yunzai 根目录
 * @param {string} name 插件目录名
 * @param {object} io
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{code: number, tail: string}>} io.spawnLogged
 * @param {(text: string, level?: string) => void} io.log
 * @return {Promise<{name: string, ran: boolean, ok: boolean, reason: string, readme: object}>}
 */
export async function installPluginDeps(root, name, {spawnLogged, log}) {
  const out = {name, ran: false, ok: true, reason: '', readme: {accepted: [], rejected: []}}
  if (!PLUGIN_NAME_RE.test(name)) return {...out, ok: false, reason: '插件名不合法'}
  const dir = path.join(root, 'plugins', name)
  const pkgFile = path.join(dir, 'package.json')
  let pkg = null
  try {
    if (fs.statSync(pkgFile).size > README_MAX_SIZE) throw new Error('package.json 过大')
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  } catch (err) {
    if (fs.existsSync(pkgFile)) return {...out, ok: false, reason: `package.json 无法读取：${err.message}`}
  }

  let readme = {install: false, packages: [], accepted: [], rejected: []}
  for (const file of ['README.md', 'Readme.md', 'readme.md']) {
    const abs = path.join(dir, file)
    try {
      if (!fs.existsSync(abs) || fs.statSync(abs).size > README_MAX_SIZE) continue
      readme = parseReadmeInstall(fs.readFileSync(abs, 'utf8'), {
        pluginName: name, packageName: typeof pkg?.name === 'string' ? pkg.name : '',
      })
      break
    } catch {
      // README 只是补充，读失败不影响 package.json 安装
    }
  }
  out.readme = {accepted: readme.accepted, rejected: readme.rejected}
  for (const line of readme.rejected) log(`${name}：忽略 README 命令 ${line}`, 'warn')
  const filter = `./plugins/${name}`

  if (pkg) {
    out.ran = true
    log(`${name}：安装 package.json 依赖`)
    const res = await spawnLogged(PNPM, [
      '--filter', filter, 'install', '--no-frozen-lockfile', '--fail-if-no-match',
    ], {cwd: root, shell: NEED_SHELL})
    if (res.code !== 0) {
      out.ok = false
      out.reason = res.tail || `pnpm install 退出码 ${res.code}`
    }
  }

  const declared = new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.optionalDependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ])
  const supplements = readme.packages.filter((p) => !declared.has(packageBaseName(p)))
  if (supplements.length && pkg) {
    out.ran = true
    log(`${name}：README 补充依赖 ${supplements.join('、')}`)
    const res = await spawnLogged(PNPM, [
      '--filter', filter, 'add', '--save-prod', ...supplements,
    ], {cwd: root, shell: NEED_SHELL})
    if (res.code !== 0) {
      out.ok = false
      out.reason = res.tail || `README 补充依赖安装失败（${res.code}）`
    }
  }
  if (!pkg && readme.packages.length) {
    out.ran = true
    log(`${name}：没有 package.json，README 依赖安装到 Yunzai 根`, 'warn')
    const res = await spawnLogged(PNPM, ['add', '-w', '--save-prod', ...readme.packages], {
      cwd: root, shell: NEED_SHELL,
    })
    if (res.code !== 0) {
      out.ok = false
      out.reason = res.tail || `README 依赖安装失败（${res.code}）`
    }
  }
  if (!out.ran) log(`${name}：没有需要安装的依赖`)
  return out
}
