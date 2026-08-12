/**
 * 生成离线图标集：src/components/icons/offline.ts
 *
 * 面板自身用到的图标全部内置，避免运行时向 iconify 公共 API 发请求
 * （机器人所在环境经常没有外网，且不该把图标名外发）。
 * 图标数据取自 @ant-design/icons-svg —— ant-design-vue 已经间接依赖它，
 * 但这里只在生成阶段用一次，产物是纯静态数据，运行时不再依赖该包。
 *
 * 用法：node scripts/gen-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ASN_DIR =
  '/root/Yunzai/node_modules/.pnpm/@ant-design+icons-svg@4.5.0/node_modules/@ant-design/icons-svg/es/asn'

/** iconify 名 → @ant-design/icons-svg 的模块名 */
const ANTD_ICONS = {
  'arrow-down-outlined': 'ArrowDownOutlined',
  'arrow-up-outlined': 'ArrowUpOutlined',
  'clock-circle-outlined': 'ClockCircleOutlined',
  'close-outlined': 'CloseOutlined',
  'cloud-download-outlined': 'CloudDownloadOutlined',
  'cloud-outlined': 'CloudOutlined',
  'code-outlined': 'CodeOutlined',
  'delete-outlined': 'DeleteOutlined',
  'down-outlined': 'DownOutlined',
  'file-text-outlined': 'FileTextOutlined',
  'github-outlined': 'GithubOutlined',
  'minus-circle-outlined': 'MinusCircleOutlined',
  'picture-outlined': 'PictureOutlined',
  'plus-outlined': 'PlusOutlined',
  'poweroff-outlined': 'PoweroffOutlined',
  'question-circle-outlined': 'QuestionCircleOutlined',
  'reload-outlined': 'ReloadOutlined',
  'right-outlined': 'RightOutlined',
  'safety-outlined': 'SafetyOutlined',
  'save-outlined': 'SaveOutlined',
  'search-outlined': 'SearchOutlined',
  'sync-outlined': 'SyncOutlined',
  'upload-outlined': 'UploadOutlined',
  'menu-fold-outlined': 'MenuFoldOutlined',
  'menu-unfold-outlined': 'MenuUnfoldOutlined',
  'user-outlined': 'UserOutlined',
  'info-circle-outlined': 'InfoCircleOutlined',
  'home-outlined': 'HomeOutlined',
  'setting-outlined': 'SettingOutlined',
  'api-outlined': 'ApiOutlined',
  'heart-outlined': 'HeartOutlined',
  'database-outlined': 'DatabaseOutlined',
  'thunderbolt-outlined': 'ThunderboltOutlined',
  'table-outlined': 'TableOutlined',
  'play-circle-outlined': 'PlayCircleOutlined',
  'copy-outlined': 'CopyOutlined',
  'team-outlined': 'TeamOutlined',
  'link-outlined': 'LinkOutlined',
  'bulb-outlined': 'BulbOutlined',
  'edit-outlined': 'EditOutlined',
  'eye-outlined': 'EyeOutlined',
  'folder-outlined': 'FolderOutlined',
  'folder-add-outlined': 'FolderAddOutlined',
  'file-add-outlined': 'FileAddOutlined',
  'bug-outlined': 'BugOutlined',
  'sun-outlined': 'SunOutlined',
  'moon-outlined': 'MoonOutlined',
  'appstore-outlined': 'AppstoreOutlined',
  'appstore-add-outlined': 'AppstoreAddOutlined',
  'contacts-outlined': 'ContactsOutlined',
  'key-outlined': 'KeyOutlined',
  'unordered-list-outlined': 'UnorderedListOutlined',
  'tool-outlined': 'ToolOutlined',
  'experiment-outlined': 'ExperimentOutlined',
  'send-outlined': 'SendOutlined',
  'clear-outlined': 'ClearOutlined',
  'aim-outlined': 'AimOutlined',
  'picture-outlined': 'PictureOutlined',
  'audio-outlined': 'AudioOutlined',
  'file-outlined': 'FileOutlined',
  'video-camera-outlined': 'VideoCameraOutlined',
  'message-outlined': 'MessageOutlined',
  'rollback-outlined': 'RollbackOutlined',
  'more-outlined': 'MoreOutlined',
  'robot-outlined': 'RobotOutlined',
}

/** 把 @ant-design/icons-svg 的抽象节点转成 SVG 内部标记 */
function nodeToSvg(node) {
  const rawAttrs = { ...(node.attrs ?? {}) }
  // @ant-design/icons-svg 的路径不带 fill，SVG 默认填充黑色，
  // 于是图标不会跟随 CSS color 变化（菜单选中态、按钮悬浮态都失效）。
  // iconify 单色图标的约定是显式写 currentColor，这里补上。
  if (node.tag === 'path' && rawAttrs.fill == null) {
    rawAttrs.fill = 'currentColor'
  }
  const attrs = Object.entries(rawAttrs)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ')
  const children = (node.children ?? []).map(nodeToSvg).join('')
  if (!children) return `<${node.tag}${attrs ? ' ' + attrs : ''}/>`
  return `<${node.tag}${attrs ? ' ' + attrs : ''}>${children}</${node.tag}>`
}

const icons = {}
const missing = []

for (const [iconifyName, moduleName] of Object.entries(ANTD_ICONS)) {
  const file = path.join(ASN_DIR, `${moduleName}.js`)
  if (!fs.existsSync(file)) {
    missing.push(`${iconifyName} (${moduleName})`)
    continue
  }
  const src = fs.readFileSync(file, 'utf8')
  const match = src.match(/=\s*(\{[\s\S]*?\});\s*\nexport default/)
  if (!match) {
    missing.push(`${iconifyName} (解析失败)`)
    continue
  }
  const asn = JSON.parse(match[1])
  const icon = asn.icon
  const [left, top, width, height] = String(icon.attrs.viewBox).trim().split(/\s+/).map(Number)
  icons[iconifyName] = {
    body: (icon.children ?? []).map(nodeToSvg).join(''),
    left,
    top,
    width,
    height,
  }
}

if (missing.length) {
  console.error('以下图标未找到，请检查名称：\n  ' + missing.join('\n  '))
  process.exit(1)
}

const out = `/**
 * 离线图标数据（自动生成，请勿手改）。
 *
 * 由 scripts/gen-icons.mjs 从 @ant-design/icons-svg 提取，
 * 目的是让面板自身的图标完全离线，不向 iconify 公共 API 发请求。
 * 需要新增图标时，在生成脚本的 ANTD_ICONS 里加一项再重新执行。
 */
import type { IconifyJSON } from '@iconify/vue'

export const ANT_DESIGN_COLLECTION: IconifyJSON = ${JSON.stringify(
  { prefix: 'ant-design', icons },
  null,
  2,
)}
`

const outFile = fileURLToPath(new URL('../src/components/icons/offline.ts', import.meta.url))
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, out, 'utf8')
console.log(`已生成 ${Object.keys(icons).length} 个图标 → ${outFile}`)
