<script setup lang="ts">
/**
 * 左侧会话列表。
 *
 * 名单是 Bot 的好友 / 群列表（后端 /chat/sessions 已叠上最后一条摘要与未读），
 * 但页面开着的时候会话状态还在变，所以显示时再用父层轮询来的活跃表覆盖一遍。
 */
import { computed, ref, watch } from 'vue'
import GIcon from '@/components/GIcon.vue'
import { apiChatSessions, type ChatActiveItem, type ChatSession, type ChatType } from '@/api'

const props = defineProps<{
  type: ChatType
  botId: string
  keyword: string
  activeKey: string
  /** 父层轮询拿到的实时活跃表，key -> 最后一条 + 未读 */
  active: Record<string, ChatActiveItem>
}>()

const emit = defineEmits<{ select: [session: ChatSession] }>()

const PAGE_SIZE = 30

const list = ref<ChatSession[]>([])
const total = ref(0)
const pageNo = ref(1)
const loading = ref(false)
const errMsg = ref('')

const hasMore = computed(() => list.value.length < total.value)

/** 合并实时活跃表：摘要与未读跟着轮询走，排序也跟着变 */
const merged = computed(() => {
  const out = list.value.map((it) => {
    const live = props.active[it.key]
    return live ? { ...it, ...live } : it
  })
  out.sort((a, b) => b.lastTime - a.lastTime || a.id.localeCompare(b.id))
  return out
})

async function load(reset = false) {
  if (loading.value) return
  loading.value = true
  try {
    const page = reset ? 1 : pageNo.value
    const data = await apiChatSessions({
      type: props.type,
      botId: props.botId,
      keyword: props.keyword.trim(),
      pageNo: page,
      pageSize: PAGE_SIZE,
    })
    list.value = reset ? data.list : [...list.value, ...data.list]
    total.value = data.total
    pageNo.value = page
    errMsg.value = ''
  } catch (e: any) {
    errMsg.value = e?.message || '会话列表获取失败'
  } finally {
    loading.value = false
  }
}

function more() {
  pageNo.value += 1
  load()
}

let kwTimer: number | undefined
watch(
  () => props.keyword,
  () => {
    // 输入框防抖，别每敲一个字打一次请求
    if (kwTimer) window.clearTimeout(kwTimer)
    kwTimer = window.setTimeout(() => load(true), 300)
  },
)

watch([() => props.type, () => props.botId], () => load(true))

/** 群头像取群号那张，好友头像取 QQ 那张，都是腾讯的公开地址 */
function avatar(item: ChatSession) {
  return item.type === 'group'
    ? `https://p.qlogo.cn/gh/${item.id}/${item.id}/100`
    : `https://q.qlogo.cn/g?b=qq&nk=${item.id}&s=100`
}

function timeText(t: number) {
  if (!t) return ''
  const d = new Date(t * 1000)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getMonth() + 1}-${pad(d.getDate())}`
}

defineExpose({ reload: () => load(true) })

load(true)
</script>

<template>
  <div class="g-sess">
    <div v-if="errMsg" class="g-sess-err">{{ errMsg }}</div>

    <a-empty v-else-if="!merged.length && !loading" class="g-sess-empty">
      <template #description>
        <span>{{ keyword ? '没有匹配的会话' : type === 'group' ? '没有群聊' : '没有好友' }}</span>
      </template>
    </a-empty>

    <button
      v-for="item in merged"
      :key="item.key"
      type="button"
      class="g-sess-item"
      :class="{ 'is-active': item.key === activeKey }"
      @click="emit('select', item)"
    >
      <span class="g-sess-avatar">
        <img :src="avatar(item)" :alt="item.name" loading="lazy" />
        <span v-if="item.unread" class="g-sess-dot">{{ item.unread > 99 ? '99+' : item.unread }}</span>
      </span>
      <span class="g-sess-main">
        <span class="g-sess-line">
          <span class="g-sess-name">{{ item.name || item.id }}</span>
          <span class="g-sess-time">{{ timeText(item.lastTime) }}</span>
        </span>
        <span class="g-sess-last">{{ item.lastText || item.id }}</span>
      </span>
    </button>

    <div v-if="hasMore" class="g-sess-more">
      <a-button size="small" type="text" :loading="loading" @click="more">
        加载更多（{{ merged.length }} / {{ total }}）
      </a-button>
    </div>
    <div v-else-if="loading" class="g-sess-more">
      <GIcon icon="ant-design:sync-outlined" :size="13" class="g-sess-spin" />
      加载中
    </div>
  </div>
</template>

<style scoped>
.g-sess {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  /* 同消息流：关滚动锚定 + 滚动条槽位常驻，内容变化时列表别自己滚 */
  overflow-anchor: none;
  scrollbar-gutter: stable;
}

.g-sess-err {
  padding: 10px;
  color: var(--g-danger);
  font-size: 12px;
}

.g-sess-empty {
  margin-top: 40px;
  font-size: 12px;
}

/* button 默认样式全得抹掉，用它是为了键盘能 tab 过来 */
.g-sess-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: none;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.g-sess-item:hover {
  background: var(--g-bg-soft);
}

.g-sess-item.is-active {
  background: var(--g-brand-soft);
}

.g-sess-avatar {
  position: relative;
  flex: none;
  width: 36px;
  height: 36px;
}

.g-sess-avatar img {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--g-bg-soft);
  object-fit: cover;
}

/* 未读红点压在头像右上角 */
.g-sess-dot {
  position: absolute;
  top: -3px;
  right: -5px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--g-danger);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.g-sess-main {
  flex: 1;
  min-width: 0;
}

.g-sess-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.g-sess-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
}

.g-sess-time {
  flex: none;
  color: var(--g-text-dim);
  font-size: 11px;
}

.g-sess-last {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-sess-more {
  padding: 6px 0 10px;
  text-align: center;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-sess-spin {
  animation: g-sess-rotate 1s linear infinite;
}

@keyframes g-sess-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
