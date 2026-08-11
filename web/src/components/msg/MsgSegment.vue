<script setup lang="ts">
/**
 * 一个消息段的渲染。
 *
 * 沙盒与消息记录共用 —— 后端两边都走 `server/service/both/model/msgSegment.js`，
 * 段结构完全一致。两页的差异通过 provide / inject 注入：资源地址怎么拼、按钮点了
 * 干什么、引用的那条消息去哪儿查，都由页面决定。
 */
import { computed, inject, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import GIcon from '@/components/GIcon.vue'
import type { MsgBtn, MsgSeg } from '@/api'

const props = defineProps<{ seg: MsgSeg }>()

const emit = defineEmits<{ forward: [seg: MsgSeg] }>()

/**
 * 缩略图尺寸，与样式里 .g-seg-img 的 max-width / .is-long 的 max-height 保持一致。
 * 插件出的图多是手机比例的长截图，按高度等比缩会窄到看不清字，所以改成按宽度铺、
 * 超高的裁掉下半截，点开再看完整的。
 */
const IMG_W = 340
const IMG_MAX_H = 440

const imgLong = ref(false)
const imgPreview = ref(false)
/** 直链失效后切服务端代理，再失败就只显示一行提示 */
const viaProxy = ref(false)
const imgFailed = ref(false)

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (!img.naturalWidth || !img.naturalHeight) return
  // 小图不放大，所以实际宽度取自然宽度与上限的较小值
  const w = Math.min(IMG_W, img.naturalWidth)
  imgLong.value = (w * img.naturalHeight) / img.naturalWidth > IMG_MAX_H
}

/** 资源地址怎么拼由页面给：沙盒走 /sandbox/asset，消息记录走 /chat/asset */
const assetUrl = inject<((assetId: string) => string) | null>('msgAssetUrl', null)
/** QQ 直链的 rkey 会过期，页面给了代理地址就在加载失败后再试一次 */
const proxyUrl = inject<((url: string) => string) | null>('msgProxyUrl', null)
/** 按钮点击交给页面处理。用 inject 是为了让转发消息里嵌套的按钮也能拿到 */
const onButton = inject<((btn: MsgBtn) => void) | null>('msgButtonClick', null)
/** 引用的那条消息，能查到就显示「昵称：摘要」，查不到只标一下是引用 */
const findReply = inject<((id: string) => { name: string; text: string } | null) | null>(
  'msgReply',
  null,
)

/** 资源地址：http 直链原样用，其余走后端资源接口 */
const src = computed(() => {
  const url = props.seg.url
  if (url) return viaProxy.value && proxyUrl ? proxyUrl(url) : url
  if (props.seg.assetId && assetUrl) return assetUrl(props.seg.assetId)
  return ''
})

function onImgError() {
  if (props.seg.url && proxyUrl && !viaProxy.value) {
    viaProxy.value = true
    return
  }
  imgFailed.value = true
}

const replyInfo = computed(() => {
  const id = props.seg.id
  if (!id || !findReply) return null
  return findReply(id)
})

/** 三个动作字段都没有的按钮，在真实环境里点了也没反应，这里如实置灰 */
const btnDead = (btn: MsgBtn) => !btn.callback && !btn.input && !btn.link

function btnTip(btn: MsgBtn) {
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

  <!-- 引用：查得到被引用的那条就显示摘要，否则只标一下 -->
  <span v-else-if="seg.type === 'reply'" class="g-seg-reply">
    <GIcon icon="ant-design:rollback-outlined" :size="12" />
    <template v-if="replyInfo">
      <span class="g-seg-reply-name">{{ replyInfo.name }}</span>
      <span class="g-seg-reply-text">{{ replyInfo.text }}</span>
    </template>
    <span v-else>引用</span>
  </span>

  <span v-else-if="seg.type === 'face'" class="g-seg-face">[表情{{ seg.id }}]</span>

  <template v-else-if="seg.type === 'image'">
    <span v-if="seg.error || seg.tooLarge || imgFailed || !src" class="g-seg-bad">
      <GIcon icon="ant-design:picture-outlined" :size="13" />
      <template v-if="seg.tooLarge">
        图片过大，未加载{{ sizeText ? `（${sizeText}）` : '' }}
      </template>
      <template v-else-if="imgFailed">图片加载失败，链接可能已过期</template>
      <template v-else>图片读取失败{{ seg.error ? `：${seg.error}` : '' }}</template>
    </span>
    <template v-else>
      <span class="g-seg-img" :class="{ 'is-long': imgLong }" @click="imgPreview = true">
        <img
          :src="src"
          :alt="seg.name || '图片'"
          loading="lazy"
          @load="onImgLoad"
          @error="onImgError"
        />
        <span v-if="imgLong" class="g-seg-img-more">长图 · 点击查看完整</span>
      </span>
      <!-- 预览层交给 antd，能缩放旋转，比新开标签页顺手；本体不占位 -->
      <a-image
        :src="src"
        :style="{ display: 'none' }"
        :preview="{ visible: imgPreview, onVisibleChange: (v: boolean) => (imgPreview = v) }"
      />
    </template>
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

  <!--
    合并转发。插件发出来的（node）内容就在段里；真实消息里的（forward）只给一个 id，
    内容在 QQ 服务端，点开时才去取，取回来由页面填进 seg.nodes。
  -->
  <div v-else-if="seg.type === 'node' || seg.type === 'forward'" class="g-seg-node">
    <div class="g-seg-node-head">
      <span>合并转发</span>
      <button
        v-if="seg.type === 'forward' && !seg.nodes"
        type="button"
        class="g-seg-node-open"
        @click="emit('forward', seg)"
      >
        点击展开
      </button>
    </div>
    <div v-for="(node, i) in seg.nodes ?? []" :key="i" class="g-seg-node-item">
      <span class="g-seg-node-name">{{ node.nickname || node.userId || '未知' }}</span>
      <span class="g-seg-node-body">
        <MsgSegment
          v-for="(sub, j) in node.segments"
          :key="j"
          :seg="sub"
          @forward="emit('forward', $event)"
        />
      </span>
    </div>
    <div v-if="seg.truncated" class="g-seg-node-more">层数过深，未继续展开</div>
  </div>

  <!-- 没法还原的段，原始 JSON 折叠着放 -->
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

/* 引用：单独一条细带压在气泡顶部，别跟正文混在一行 */
.g-seg-reply {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  padding-left: 8px;
  border-left: 2px solid var(--g-border);
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-seg-reply-name {
  flex: none;
  color: var(--g-text-sub);
}

/* 引用的正文可能很长，压成一行 */
.g-seg-reply-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-seg-bad {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-seg-img {
  position: relative;
  display: block;
  width: fit-content;
  max-width: 100%;
  margin: 2px 0;
  border-radius: 8px;
  overflow: hidden;
  cursor: zoom-in;
}

.g-seg-img img {
  display: block;
  /* 必须是纯长度：写成 min(340px, 100%) 的话浏览器算不出图片的固有宽度贡献，
     气泡会按原图尺寸撑满。与 script 里的 IMG_W 一致 */
  max-width: 340px;
}

/* 长图裁掉下半截，底部压一层渐变提示还有内容 */
.g-seg-img.is-long {
  max-height: 440px;
}

.g-seg-img.is-long::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 60px;
  background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.6));
}

.g-seg-img-more {
  position: absolute;
  right: 0;
  bottom: 6px;
  left: 0;
  z-index: 1;
  text-align: center;
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
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
  /* 同 .g-seg-img img，宽度上限不能带百分比 */
  max-width: 320px;
  border-radius: 8px;
}

/* 窄屏交给百分比，此时气泡本身就窄，不怕被撑宽 */
@media (max-width: 640px) {
  .g-seg-img img,
  .g-seg-video {
    max-width: 100%;
  }
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
  margin: 8px 0 2px;
}

.g-seg-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* a 与 button 两种标签共用，所以字体、边框这些都得写全。
   同一行按钮等分宽度，跟 QQ 那边的 markdown 按钮一致 */
.g-seg-btn {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--g-bg-soft);
  border: 1px solid var(--g-border);
  border-radius: 8px;
  color: var(--g-brand);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.g-seg-btn:hover {
  background: var(--g-brand-soft);
  border-color: var(--g-brand);
}

.g-seg-btn.is-dead {
  border-color: var(--g-border);
  border-style: dashed;
  background: none;
  color: var(--g-text-dim);
  cursor: not-allowed;
}

.g-seg-btn.is-dead:hover {
  background: none;
  border-color: var(--g-border);
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
  max-width: 340px;
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--g-bg-soft);
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-seg-node-open {
  padding: 0;
  background: none;
  border: none;
  color: var(--g-brand);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
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
