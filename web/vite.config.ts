import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 锅巴后端把前端挂载在一个固定的“真实根路径”下（realMountPrefix），
 * 见 utils/paths.js 与 server/index.js 的 URL 重写逻辑。
 * 前端所有静态资源都必须以该前缀请求，因此 base 必须与之一致。
 */
const REAL_MOUNT_PREFIX = '/guoba-plugin-mock-root'
const OUT_DIR = fileURLToPath(new URL('../server/static', import.meta.url))
const ENTRY_FILE = 'main-app.js'

const BUILD_TIME = new Date().toLocaleString('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 老锅巴（1.x）插件要的 componentMap 出口文件名，见 douyin-auto-spark 的 template-extension.js */
const LEGACY_MAP_FILE = 'BasicForm.vue_vue_type_style_index_0_lang.js'

/**
 * 老锅巴插件的兼容产物。
 *
 * 1.x 时代插件的自定义组件靠两件事工作：
 * 1. 从 `assets/index.js` 的导出语句里按「原名 as 短名」的格式，用正则挖出
 *    Vue API 和 defHttp 的名字；
 * 2. 从 `assets/BasicForm.vue_vue_type_style_index_0_lang.js` 里挖出 componentMap，
 *    再把 InputTextArea 之类的组件换成自己的。
 *
 * 新面板的打包产物导出名是压缩过的，正则对不上，所以构建完再补两个手写模块：
 * 应用入口改名为 main-app.js，index.js 只负责转出运行环境；componentMap 那个文件
 * 直接给出带 Map 语义的包装对象。文件名和导出语句格式都是插件写死要的，别改。
 */
function legacyGuobaCompat(): Plugin {
  return {
    name: 'guoba-legacy-compat',
    apply: 'build',
    // 入口产物叫 main-app.js，HTML 里改回 index.js（真正加载的是这份桥接）
    transformIndexHtml(html) {
      return html.split(`${REAL_MOUNT_PREFIX}/assets/${ENTRY_FILE}`)
        .join(`${REAL_MOUNT_PREFIX}/assets/index.js`)
    },
    closeBundle() {
      const assets = path.join(OUT_DIR, 'assets')
      if (!fs.existsSync(path.join(assets, ENTRY_FILE))) return
      fs.writeFileSync(path.join(assets, 'index.js'), `/**
 * 老锅巴（1.x）自定义组件的运行环境桥接。
 *
 * 插件的 template-extension 会读这个文件，用正则在导出语句里找
 * 「原名 as 短名」，再 import 这些短名去拿 Vue API 和 defHttp。
 * 所以下面的导出语句必须是「原名 as 短名」的紧凑写法，别格式化。
 */
import './${ENTRY_FILE}'

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
`)
      fs.writeFileSync(path.join(assets, LEGACY_MAP_FILE), `/**
 * 老锅巴（1.x）的 componentMap 出口。
 *
 * 插件的自定义组件会 get/set 这个对象来替换输入组件；
 * window.__GUOBA_COMPONENT_MAP__ 是带 Map 语义的包装，读写的就是新面板正在用的那份。
 */
const componentMap = window.__GUOBA_COMPONENT_MAP__

export{componentMap as gcm1}
`)
    },
  }
}

export default defineConfig({
  base: `${REAL_MOUNT_PREFIX}/`,
  // 侧栏显示构建时间，更新后一眼能看出浏览器是不是拿到了新版
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [vue(), legacyGuobaCompat()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 产物直接输出到后端静态目录
    outDir: OUT_DIR,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        mainApp: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
      output: {
        // 入口用固定名：index.js 那份桥接要 import 它
        entryFileNames: () => `assets/${ENTRY_FILE}`,
        // 拆包：把不常变的第三方库单独分出来，方便浏览器缓存
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](vue|vue-router|pinia|@vue)[\\/]/.test(id)) return 'vue'
          if (id.includes('ant-design-vue')) return 'antd'
          if (id.includes('marked') || id.includes('dompurify')) return 'markdown'
          // 只有首页用到，单独拆包让其他页面不必下载
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5899,
    proxy: {
      // 开发时把接口代理到本地运行的锅巴服务
      [`${REAL_MOUNT_PREFIX}/api`]: {
        target: 'http://127.0.0.1:50831',
        changeOrigin: true,
      },
    },
  },
})
