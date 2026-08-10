<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button, Card, Empty, Skeleton, Space } from 'ant-design-vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import GIcon from '@/components/GIcon.vue'
import { apiGetPluginReadme } from '@/api'
import { withMountPrefix } from '@/utils/env'

/**
 * 插件 README。
 *
 * 后端从 GitHub/Gitee 拉取原文并把相对链接改成绝对地址（IPluginService.getReadmeText）。
 * 这里渲染 markdown 后必须过一遍 DOMPurify——内容来自第三方仓库，不可信。
 */
const props = defineProps<{ link: string }>()

const loading = ref(true)
const raw = ref('')
const failed = ref(false)

const html = computed(() => {
  if (!raw.value) return ''
  const parsed = marked.parse(raw.value, { async: false }) as string
  return DOMPurify.sanitize(parsed, {
    // 图片可能被防盗链挡住，但保留标签，加载失败由浏览器兜底
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input'],
  })
})

/** 中转图片，绕过防盗链 */
const transitBase = withMountPrefix('/api/helper/transit')

async function load(force = false) {
  loading.value = true
  failed.value = false
  try {
    const text = await apiGetPluginReadme(props.link, force)
    raw.value = typeof text === 'string' ? text : ''
    if (!raw.value) failed.value = true
  } catch {
    raw.value = ''
    failed.value = true
  } finally {
    loading.value = false
  }
}

/**
 * 让 README 里的图片走后端中转，否则 GitHub 图片经常被墙或防盗链拦下。
 * 只处理 http(s) 开头的外链。
 */
function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target?.tagName === 'A') {
    const href = (target as HTMLAnchorElement).getAttribute('href')
    if (href && /^https?:\/\//.test(href)) {
      e.preventDefault()
      window.open(href, '_blank', 'noopener')
    }
  }
}

function fixImages(el: HTMLElement | null) {
  if (!el) return
  el.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    if (src && /^https?:\/\//.test(src) && !src.startsWith(transitBase)) {
      img.setAttribute('src', `${transitBase}?url=${encodeURIComponent(src)}`)
    }
  })
}

const contentRef = ref<HTMLElement | null>(null)

watch(html, () => {
  // DOM 更新后再改 src
  requestAnimationFrame(() => fixImages(contentRef.value))
})

watch(() => props.link, () => load(false), { immediate: true })
</script>

<template>
  <Card :bordered="false" class="g-readme">
    <template #title>
      <span class="g-readme-title">插件说明</span>
    </template>
    <template #extra>
      <Space>
        <Button size="small" :disabled="loading" @click="load(true)">
          <GIcon icon="ant-design:reload-outlined" :size="13" />
        </Button>
      </Space>
    </template>

    <Skeleton v-if="loading" active :paragraph="{ rows: 6 }" />
    <Empty v-else-if="failed" description="没能拉取到 README，可能是网络问题" />
    <div v-else ref="contentRef" class="g-markdown" @click="onContentClick" v-html="html" />
  </Card>
</template>

<style scoped>
.g-readme {
  margin-bottom: 16px;
}

.g-readme-title {
  font-size: 15px;
  font-weight: 600;
}

.g-markdown {
  max-height: 520px;
  overflow: auto;
}
</style>
