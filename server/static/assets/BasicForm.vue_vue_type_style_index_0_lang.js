/**
 * 老锅巴（1.x）的 componentMap 出口。
 *
 * 插件的自定义组件会 get/set 这个对象来替换输入组件；
 * window.__GUOBA_COMPONENT_MAP__ 是带 Map 语义的包装，读写的就是新面板正在用的那份。
 */
const componentMap = window.__GUOBA_COMPONENT_MAP__

export{componentMap as gcm1}
