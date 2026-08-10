export {_paths} from '../utils/paths.js'
export {_version, pluginName, pluginPackage} from '../utils/package.js';

export {default as cfg} from '../utils/cfg.js'

export {default as Constant} from '../server/constant/Constant.js'
export {default as ApiController} from '../server/core/ApiController.js'

/** 安装了哪些插件 */
export const PluginsMap = new Map()
/** 哪些插件支持Guoba */
export const GuobaSupportMap = new Map()
/** git仓库工具类 */
export const GitRepoMap = new Map()
/** 插件注册的自定义页面，key 为页面 id */
export const CustomPagesMap = new Map()
