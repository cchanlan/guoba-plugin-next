<script setup lang="ts">
/**
 * 自定义页面的容器。
 *
 * 页面内容有两个来源：插件自己的 `guoba/` 目录（见 docs/custom-page.md），
 * 以及在「扩展页面 → 页面管理」里建的。两者渲染方式一致：
 *  - `src`  —— iframe 嵌入完整 HTML，样式与脚本互不干扰；
 *  - `html` —— 直接注入 HTML 片段，描述符里的 style / script 由这里按需挂到文档上。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Button, Empty, Spin } from 'ant-design-vue'
import { apiGetCustomPage, apiReloadCustomPages, customPageAssetUrl, type CustomPage } from '@/api'
import { LITE_TOKEN_COOKIE, REAL_MOUNT_PREFIX } from '@/utils/env'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const errMsg = ref('')
const page = ref<CustomPage | null>(null)
const iframeEl = ref<HTMLIFrameElement | null>(null)
/** 注入到文档上的 link / script，切页时要撤掉 */
const injected: HTMLElement[] = []

const pageId = computed(() => String(route.params.id ?? ''))
const isFrame = computed(() => !!page.value?.src)

/** 该页面自定义接口的绝对前缀 */
function apiBaseOf(p: CustomPage) {
  return `${REAL_MOUNT_PREFIX}${p.apiPath}`
}

/**
 * iframe 的地址。
 *
 * `__webBase` / `__apiBase` 供页面里的 JS 拼接接口地址，与 QQBot-Web-Adapter 的约定一致；
 * token 走 query，iframe 内相对引用的 css/js 则靠下面种的 Cookie 过鉴权。
 */
const frameSrc = computed(() => {
  const p = page.value
  if (!p?.src) return ''
  const q = new URLSearchParams({
    token: auth.token ?? '',
    __webBase: REAL_MOUNT_PREFIX,
    __apiBase: apiBaseOf(p),
  })
  return `${customPageAssetUrl(p.id, p.src)}?${q.toString()}`
})

/**
 * iframe 里的 `<link href="dash.css">` 由浏览器直接请求，带不上请求头，
 * 只能靠 Cookie 里的弱令牌过鉴权。path 限定到静态资源接口，且弱令牌只对这类只读路径有效。
 */
function setAssetCookie() {
  const token = auth.liteToken
  if (!token) return
  const path = `${REAL_MOUNT_PREFIX}/api/custom-page`
  document.cookie = `${LITE_TOKEN_COOKIE}=${encodeURIComponent(token)}; path=${path}; SameSite=Strict`
}

function cleanInjected() {
  while (injected.length) {
    injected.pop()?.remove()
  }
}

/**
 * 片段模式下页面脚本跟面板同文档，拿不到 iframe 那几个 query 参数，
 * 这里挂一个全局对象给它用：`window.__GUOBA__.apiBase` 拼接口地址。
 */
function setupGlobal(p: CustomPage) {
  ;(window as any).__GUOBA__ = {
    pageId: p.id,
    webBase: REAL_MOUNT_PREFIX,
    apiBase: apiBaseOf(p),
    token: auth.token ?? '',
    tokenKey: 'guoba-access-token',
  }
}

/** html 模式下把描述符里的 style / script 挂到文档上 */
function injectAssets(p: CustomPage) {
  if (p.style) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = withToken(customPageAssetUrl(p.id, p.style))
    document.head.appendChild(link)
    injected.push(link)
  }
  if (p.script) {
    const script = document.createElement('script')
    script.src = withToken(customPageAssetUrl(p.id, p.script))
    script.async = true
    document.body.appendChild(script)
    injected.push(script)
  }
}

function withToken(url: string) {
  return `${url}?token=${encodeURIComponent(auth.token ?? '')}`
}

async function load() {
  cleanInjected()
  loading.value = true
  errMsg.value = ''
  page.value = null
  try {
    const data = await apiGetCustomPage(pageId.value)
    page.value = data
    setAssetCookie()
    if (!data.src) {
      setupGlobal(data)
      // 等 v-html 落到 DOM 上再加载脚本，脚本里就能直接拿到页面元素
      await nextTick()
      injectAssets(data)
    }
  } catch (e: any) {
    errMsg.value = e?.message || '页面加载失败'
  } finally {
    loading.value = false
  }
}

watch(pageId, (id) => id && load(), { immediate: true })

onBeforeUnmount(cleanInjected)

function reloadFrame() {
  if (iframeEl.value) iframeEl.value.src = frameSrc.value
  else load()
}

const rescanning = ref(false)

/** 重新扫描插件目录，插件改了描述符不用重启 Bot */
async function rescan() {
  rescanning.value = true
  try {
    await apiReloadCustomPages()
    // 页面可能增删，侧边栏跟着更新
    await auth.loadUserInfo()
    await load()
  } finally {
    rescanning.value = false
  }
}
</script>

<template>
  <div class="g-page g-custom">
    <div class="g-page-head">
      <h2 class="g-page-title">
        {{ page?.title || '扩展页面' }}
      </h2>
      <!-- 这行说明里带刷新 / 编辑 / 重新扫描，窄屏不能跟其他页的说明一起藏掉 -->
      <p class="g-page-desc is-keep">
        <template v-if="page?.source === 'store'">在面板里创建的页面</template>
        <template v-else-if="page">由插件「{{ page.pluginName }}」提供</template>
        <Button type="link" size="small" class="g-custom-act" @click="reloadFrame">刷新</Button>
        <Button
          v-if="page?.source === 'store'"
          type="link"
          size="small"
          class="g-custom-act"
          @click="router.push('/custom/manage')"
        >
          编辑
        </Button>
        <Button
          type="link"
          size="small"
          class="g-custom-act"
          :loading="rescanning"
          @click="rescan"
        >
          重新扫描
        </Button>
      </p>
    </div>

    <Spin v-if="loading" class="g-custom-loading" />

    <Empty v-else-if="errMsg" :description="errMsg" />

    <!-- iframe 模式：插件的 HTML 完整独立，样式脚本都不会污染面板 -->
    <iframe
      v-else-if="isFrame"
      ref="iframeEl"
      class="g-custom-frame"
      :src="frameSrc"
      :title="page?.title"
    />

    <!-- 片段模式：插件只给一段 HTML，注入进面板的卡片区域 -->
    <div v-else-if="page?.html" class="g-custom-html" v-html="page.html" />

    <Empty v-else description="该页面没有提供任何内容" />
  </div>
</template>

<style scoped>
.g-page-head {
  margin-bottom: 14px;
}

.g-custom {
  display: flex;
  flex-direction: column;
  /* 让 iframe 能撑满剩余高度 */
  min-height: 100%;
}

.g-custom-act {
  padding: 0 4px;
}

.g-custom-loading {
  margin: 60px auto;
}

.g-custom-frame {
  flex: 1;
  width: 100%;
  min-height: 560px;
  border: 1px solid var(--g-border);
  border-radius: 10px;
  background: var(--g-bg-card);
}

.g-custom-html {
  padding: 18px;
  border-radius: 10px;
  background: var(--g-bg-card);
  color: var(--g-text);
}
</style>
