/**
 * 从插件 README 的 shell 代码块中提取安全的依赖安装意图。
 *
 * README 属于外部仓库内容，绝不能把原文交给 shell。这里只返回两类结构化信息：
 * - `install: true`：README 明确要求给当前插件安装依赖
 * - `packages`：README 明确列出的额外 npm 包名
 *
 * 执行器会自行构造固定的 pnpm argv，原始 manager / filter / 参数均不会进入子进程。
 */

const MANAGERS = new Set(['pnpm', 'npm', 'cnpm', 'yarn'])
const ACTIONS = new Set(['install', 'i', 'add'])
const FENCE_LANG = /^(?:|bash|sh|shell|console)$/i
const PACKAGE_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@(?:[a-z0-9][\w.-]*|\d+(?:\.\d+){0,2}))?$/i
const SAFE_FLAG = new Set(['--no-save'])
const UNSAFE_RE = /&&|\|\||[;|<>`\\]|\$\(|\$\{|\benv\b|\bsudo\b|\bnpx\b|\bcorepack\b/i

/** @return {{install: boolean, packages: string[], accepted: string[], rejected: string[]}} */
export function parseReadmeInstall(text, {pluginName = '', packageName = ''} = {}) {
  const out = {install: false, packages: [], accepted: [], rejected: []}
  const packages = new Set()
  const lines = String(text || '').split(/\r?\n/)
  let inFence = false
  let allowedFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const fence = line.match(/^```\s*([^\s`]*)/)
    if (fence) {
      if (!inFence) {
        inFence = true
        allowedFence = FENCE_LANG.test(fence[1] || '')
      } else {
        inFence = false
        allowedFence = false
      }
      continue
    }
    if (!inFence || !allowedFence || !line || line.startsWith('#')) continue
    const source = `第 ${i + 1} 行：${line.slice(0, 160)}`
    if (UNSAFE_RE.test(line) || /["']/.test(line)) {
      if (/\b(?:pnpm|npm|cnpm|yarn)\b/i.test(line)) out.rejected.push(`${source}（含 shell 语法）`)
      continue
    }
    const tokens = line.replace(/^[$>]\s*/, '').split(/\s+/)
    const manager = tokens.shift()?.toLowerCase()
    if (!MANAGERS.has(manager)) continue
    let action = tokens.shift()?.toLowerCase()
    // pnpm --filter=name install 这种顺序也兼容，但 filter 只用于验证，不传给执行器
    let leadingFilter = ''
    if (action?.startsWith('--filter=')) {
      leadingFilter = action.slice('--filter='.length)
      action = tokens.shift()?.toLowerCase()
    }
    if (!ACTIONS.has(action)) {
      out.rejected.push(`${source}（不是依赖安装命令）`)
      continue
    }
    let filter = leadingFilter
    const args = []
    let invalid = false
    for (let j = 0; j < tokens.length; j++) {
      const token = tokens[j]
      if (token.startsWith('--filter=')) {
        filter = token.slice('--filter='.length)
      } else if (token === '--filter') {
        filter = tokens[++j] || ''
      } else if (SAFE_FLAG.has(token)) {
        // 只作为已识别信息；执行器会持久化安装，不保留 no-save
      } else if (token.startsWith('-')) {
        invalid = true
      } else {
        args.push(token)
      }
    }
    const validFilters = new Set([pluginName, packageName, `./plugins/${pluginName}`].filter(Boolean))
    if (filter && !validFilters.has(filter)) invalid = true
    if (args.some((p) => !PACKAGE_RE.test(p) || /^(?:https?:|git\+|file:|link:|workspace:|\.\.?\/|\/)/i.test(p))) {
      invalid = true
    }
    if (invalid || args.length > 32) {
      out.rejected.push(`${source}（参数不在安全白名单内）`)
      continue
    }
    out.install = true
    for (const pkg of args) packages.add(pkg)
    out.accepted.push(source)
  }
  out.packages = [...packages]
  return out
}
