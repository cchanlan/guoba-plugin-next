<script setup lang="ts">
import { computed } from 'vue'
import GIcon from '@/components/GIcon.vue'
import { sandboxAssetUrl, type SandboxSegment } from '@/api'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ seg: SandboxSegment }>()

const auth = useAuthStore()

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
