<script setup lang="ts">
import { computed, inject } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import GIcon from '@/components/GIcon.vue'
import { sandboxAssetUrl, type SandboxButton, type SandboxSegment } from '@/api'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ seg: SandboxSegment }>()

const auth = useAuthStore()

/** 按钮点击交给页面处理。用 inject 是为了让转发消息里嵌套的按钮也能拿到 */
const onButton = inject<((btn: SandboxButton) => void) | null>('sandboxButtonClick', null)

/** 三个动作字段都没有的按钮，在真实环境里点了也没反应，这里如实置灰 */
const btnDead = (btn: SandboxButton) => !btn.callback && !btn.input && !btn.link

function btnTip(btn: SandboxButton) {
  if (btn.link) return `打开链接：${btn.link}`
  if (btn.callback) return `点击直接发送：${btn.callback}`
  if (btn.input) return `点击填入输入框：${btn.input}`
  return '该按钮没有 callback / input / link，点击无动作'
}

const btnCount = computed(() =>
  (props.seg.rows ?? []).reduce((sum, row) => sum + row.length, 0),
)

/** markdown 内容出自插件，仍按不可信处理，跟插件 README 一样过一遍 DOMPurify */
const mdHtml = computed(() => {
  const content = props.seg.content
  if (!content) return ''
  const parsed = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(parsed, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input'],
  })
})

/** 资源地址：http 直链原样用，其余走后端资源接口 */
const src = computed(() => {
  if (props.seg.url) return props.seg.url
  if (props.seg.assetId) return sandboxAssetUrl(props.seg.assetId, auth.token)
  return ''
})

const sizeText = computed(() => {
  const size = props.seg.size
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
})

const fileIcon: Record<string, string> = {
  record: 'ant-design:audio-outlined',
  video: 'ant-design:video-camera-outlined',
  file: 'ant-design:file-outlined',
}
</script>

<template>
  <!-- 文本：保留插件排的换行与空格 -->
  <span v-if="seg.type === 'text'" class="g-seg-text">{{ seg.text }}</span>

  <span v-else-if="seg.type === 'at'" class="g-seg-at">@{{ seg.name || seg.qq }}</span>

  <!-- 引用：沙盒里没有历史消息，只能标一下这是条引用回复 -->
  <span v-else-if="seg.type === 'reply'" class="g-seg-reply">
    <GIcon icon="ant-design:message-outlined" :size="12" />
    引用
  </span>

  <span v-else-if="seg.type === 'face'" class="g-seg-face">[表情{{ seg.id }}]</span>

  <template v-else-if="seg.type === 'image'">
    <span v-if="seg.error || seg.tooLarge" class="g-seg-bad">
      <GIcon icon="ant-design:picture-outlined" :size="13" />
      {{ seg.tooLarge ? `图片过大，未加载${sizeText ? `（${sizeText}）` : ''}` : `图片读取失败：${seg.error}` }}
    </span>
    <a v-else :href="src" target="_blank" class="g-seg-img">
      <img :src="src" :alt="seg.name || '图片'" loading="lazy" />
    </a>
  </template>

  <!-- 语音 / 视频 / 文件：能播的给播放器，其余给下载链接 -->
  <template v-else-if="seg.type === 'record' || seg.type === 'video' || seg.type === 'file'">
    <audio v-if="seg.type === 'record' && src" :src="src" controls class="g-seg-audio" />
    <video v-else-if="seg.type === 'video' && src" :src="src" controls class="g-seg-video" />
    <a v-else-if="src" :href="src" target="_blank" class="g-seg-file">
      <GIcon :icon="fileIcon[seg.type]" :size="14" />
      {{ seg.name || seg.type }}
      <span v-if="sizeText" class="g-seg-size">{{ sizeText }}</span>
    </a>
    <span v-else class="g-seg-bad">
      <GIcon :icon="fileIcon[seg.type]" :size="13" />
      {{ seg.name || seg.type }}
      {{ seg.tooLarge ? `（过大未加载${sizeText ? ` ${sizeText}` : ''}）` : seg.error ? `（${seg.error}）` : '' }}
    </span>
  </template>

  <!-- 按钮：callback 点了直接发出去，input 只填进输入框，与 QQ 官方 Bot 的行为一致 -->
  <template v-else-if="seg.type === 'button'">
    <!-- 普通平台会把按钮段丢掉，不直接渲染，但留个入口能看到插件到底发了什么 -->
    <details v-if="seg.ignored" class="g-seg-ignored">
      <summary>{{ btnCount }} 个按钮 · 当前平台不显示</summary>
      <div class="g-seg-btns">
        <div v-for="(row, i) in seg.rows ?? []" :key="i" class="g-seg-btn-row">
          <span v-for="(btn, j) in row" :key="j" class="g-seg-btn is-dead">
            {{ btn.text || btn.callback || btn.input || '按钮' }}
          </span>
        </div>
      </div>
      <pre v-if="seg.raw">{{ seg.raw }}</pre>
    </details>

    <div v-else class="g-seg-btns">
      <div v-for="(row, i) in seg.rows ?? []" :key="i" class="g-seg-btn-row">
        <template v-for="(btn, j) in row" :key="j">
          <a
            v-if="btn.link"
            class="g-seg-btn"
            :href="btn.link"
            target="_blank"
            rel="noopener"
            :title="btnTip(btn)"
          >
            {{ btn.text || btn.link }}
            <GIcon icon="ant-design:link-outlined" :size="11" />
          </a>
          <button
            v-else
            type="button"
            class="g-seg-btn"
            :class="{ 'is-dead': btnDead(btn) }"
            :disabled="btnDead(btn)"
            :title="btnTip(btn)"
            @click="onButton?.(btn)"
          >
            {{ btn.text || btn.callback || btn.input || '按钮' }}
            <GIcon v-if="btn.input" icon="ant-design:edit-outlined" :size="11" />
            <span v-if="btn.limited" class="g-seg-btn-tag">限</span>
          </button>
        </template>
      </div>
      <!-- 结构没认出来时后端会带上原始数据 -->
      <details v-if="seg.raw" class="g-seg-raw">
        <summary>button</summary>
        <pre>{{ seg.raw }}</pre>
      </details>
    </div>
  </template>

  <!-- markdown：content 形式的能渲染，原生模板只能摊原始数据 -->
  <template v-else-if="seg.type === 'markdown'">
    <details v-if="seg.ignored" class="g-seg-ignored">
      <summary>Markdown 消息 · 当前平台不显示</summary>
      <div v-if="mdHtml" class="g-seg-md" v-html="mdHtml" />
      <pre v-else-if="seg.raw">{{ seg.raw }}</pre>
    </details>
    <div v-else-if="mdHtml" class="g-seg-md" v-html="mdHtml" />
    <details v-else class="g-seg-raw">
      <summary>markdown</summary>
      <pre>{{ seg.raw }}</pre>
    </details>
  </template>

  <!-- 转发消息：套一层卡片，逐条列出子消息 -->
  <div v-else-if="seg.type === 'node'" class="g-seg-node">
    <div class="g-seg-node-head">合并转发</div>
    <div v-for="(node, i) in seg.nodes ?? []" :key="i" class="g-seg-node-item">
      <span class="g-seg-node-name">{{ node.nickname || node.userId || '未知' }}</span>
      <span class="g-seg-node-body">
        <MsgSegment v-for="(sub, j) in node.segments" :key="j" :seg="sub" />
      </span>
    </div>
    <div v-if="seg.truncated" class="g-seg-node-more">层数过深，未继续展开</div>
  </div>

  <!-- 按钮、markdown 之类没法还原的段，原始 JSON 折叠着放 -->
  <details v-else class="g-seg-raw">
    <summary>{{ seg.type }}</summary>
    <pre>{{ seg.raw ?? JSON.stringify(seg) }}</pre>
  </details>
</template>

<style scoped>
.g-seg-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.g-seg-at,
.g-seg-face {
  color: var(--g-brand);
}

.g-seg-reply,
.g-seg-bad {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-seg-img {
  display: block;
  margin: 4px 0;
}

.g-seg-img img {
  display: block;
  max-width: min(320px, 100%);
  max-height: 380px;
  border-radius: 8px;
  border: 1px solid var(--g-border);
}

.g-seg-audio {
  display: block;
  margin: 4px 0;
  max-width: 260px;
  height: 32px;
}

.g-seg-video {
  display: block;
  margin: 4px 0;
  max-width: min(320px, 100%);
  border-radius: 8px;
}

.g-seg-file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
  padding: 6px 10px;
  border: 1px solid var(--g-border);
  border-radius: 8px;
  font-size: 13px;
}

.g-seg-size {
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-seg-btns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 2px;
}

.g-seg-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* a 与 button 两种标签共用，所以字体、边框这些都得写全 */
.g-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  background: var(--g-bg);
  border: 1px solid var(--g-brand);
  border-radius: 14px;
  color: var(--g-brand);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.15s;
}

.g-seg-btn:hover {
  background: var(--g-brand-soft);
}

.g-seg-btn.is-dead {
  border-color: var(--g-border);
  border-style: dashed;
  color: var(--g-text-dim);
  cursor: not-allowed;
}

.g-seg-btn.is-dead:hover {
  background: var(--g-bg);
}

.g-seg-btn-tag {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--g-brand-soft);
  font-size: 10px;
}

/* 被平台忽略的段：默认收起，展开后内容一律置灰，跟能用的区分开 */
.g-seg-ignored {
  display: block;
  margin: 4px 0;
  font-size: 12px;
}

.g-seg-ignored > summary {
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-seg-ignored .g-seg-btn {
  cursor: default;
}

.g-seg-ignored pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  background: var(--g-bg-soft);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
}

.g-seg-md {
  margin: 2px 0;
}

.g-seg-md :deep(> :first-child) {
  margin-top: 0;
}

.g-seg-md :deep(> :last-child) {
  margin-bottom: 0;
}

.g-seg-md :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}

.g-seg-md :deep(pre) {
  padding: 8px 10px;
  overflow: auto;
  background: var(--g-bg-soft);
  border-radius: 6px;
}

.g-seg-md :deep(code) {
  padding: 1px 4px;
  background: var(--g-bg-soft);
  border-radius: 4px;
  font-size: 12px;
}

.g-seg-md :deep(pre code) {
  padding: 0;
  background: none;
}

.g-seg-md :deep(blockquote) {
  margin: 6px 0;
  padding-left: 10px;
  border-left: 2px solid var(--g-border);
  color: var(--g-text-sub);
}

.g-seg-md :deep(table) {
  border-collapse: collapse;
}

.g-seg-md :deep(th),
.g-seg-md :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--g-border);
}

.g-seg-node {
  margin: 4px 0;
  border: 1px solid var(--g-border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
}
.g-seg-node-head {
  padding: 4px 10px;
  background: var(--g-bg-soft);
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-seg-node-item {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
}

.g-seg-node-item + .g-seg-node-item {
  border-top: 1px dashed var(--g-border);
}

.g-seg-node-name {
  flex: none;
  max-width: 90px;
  color: var(--g-text-sub);
  word-break: break-all;
}

.g-seg-node-body {
  flex: 1;
  min-width: 0;
}

.g-seg-node-more {
  padding: 4px 10px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-seg-raw {
  margin: 4px 0;
  font-size: 12px;
}

.g-seg-raw summary {
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-seg-raw pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  background: var(--g-bg-soft);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
