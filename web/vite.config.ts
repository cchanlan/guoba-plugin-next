import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 锅巴后端把前端挂载在一个固定的“真实根路径”下（realMountPrefix），
 * 见 utils/paths.js 与 server/index.js 的 URL 重写逻辑。
 * 前端所有静态资源都必须以该前缀请求，因此 base 必须与之一致。
 */
const REAL_MOUNT_PREFIX = '/guoba-plugin-mock-root'

export default defineConfig({
  base: `${REAL_MOUNT_PREFIX}/`,
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 产物直接输出到后端静态目录，不覆盖旧版 server/static
    outDir: fileURLToPath(new URL('../server/static-next', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
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
