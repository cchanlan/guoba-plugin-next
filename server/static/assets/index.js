/**
 * 老锅巴（1.x）自定义组件的运行环境桥接。
 *
 * 插件的 template-extension 会读这个文件，用正则在导出语句里找
 * 「原名 as 短名」，再 import 这些短名去拿 Vue API 和 defHttp。
 * 所以下面的导出语句必须是「原名 as 短名」的紧凑写法，别格式化。
 */
import './main-app.js'

const __vue__ = window.__GUOBA_VUE__
const defineComponent = __vue__.defineComponent
const h = __vue__.h
const ref = __vue__.ref
const watch = __vue__.watch
const onMounted = __vue__.onMounted
const onBeforeUnmount = __vue__.onBeforeUnmount
const nextTick = __vue__.nextTick
const defHttp = window.__GUOBA_DEF_HTTP__

export{defineComponent as gc1,h as gc2,ref as gc3,watch as gc4,onMounted as gc5,onBeforeUnmount as gc6,nextTick as gc7,defHttp as gc8}
