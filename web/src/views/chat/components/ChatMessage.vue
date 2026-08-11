<script setup lang="ts">
/**
 * 消息流里的一条。
 *
 * bot 自己发的靠右，别人的靠左，跟 QQ 一个观感。悬浮时右上角出「引用 / 撤回」。
 */
import { computed, ref } from 'vue'
import GIcon from '@/components/GIcon.vue'
import MsgSegment from '@/components/msg/MsgSegment.vue'
import type { ChatMsg, MsgSeg } from '@/api'

const props = defineProps<{ msg: ChatMsg; showDate: boolean }>()

const emit = defineEmits<{
  reply: [msg: ChatMsg]
  recall: [msg: ChatMsg]
  forward: [payload: { msg: ChatMsg; seg: MsgSeg }]
}>()

const avatarFailed = ref(false)

const name = computed(() => {
  const s = props.msg.sender
  return s.card || s.nickname || s.userId || '未知'
})

const avatar = computed(
  () => `https://q.qlogo.cn/g?b=qq&nk=${encodeURIComponent(props.msg.sender.userId)}&s=100`,
)

const roleText = computed(() => {
  if (props.msg.type !== 'group') return ''
  const role = props.msg.sender.role
  if (role === 'owner') return '群主'
  if (role === 'admin') return '管理'
  return ''
})

const timeText = computed(() => {
  const t = props.msg.time
  if (!t) return ''
  const d = new Date(t * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (!props.showDate) return hm
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`
})
</script>

<template>
  <div class="g-cmsg" :class="{ 'is-self': msg.self, 'is-recalled': msg.recalled }">
    <div class="g-cmsg-row">
      <span class="g-cmsg-avatar">
        <img
          v-if="!avatarFailed"
          :src="avatar"
          :alt="name"
          loading="lazy"
          @error="avatarFailed = true"
        />
        <!-- 头像取自腾讯，离线或被墙时退回首字 -->
        <span v-else class="g-cmsg-avatar-text">{{ name.slice(0, 1) }}</span>
      </span>

      <div class="g-cmsg-main">
        <div class="g-cmsg-meta">
          <span class="g-cmsg-name">{{ name }}</span>
          <span v-if="roleText" class="g-cmsg-role">{{ roleText }}</span>
          <span class="g-cmsg-time">{{ timeText }}</span>
          <span v-if="msg.recalled" class="g-cmsg-tag">已撤回</span>

          <!-- 操作按钮跟着这一行走，悬浮才显形，免得一屏都是图标 -->
          <span class="g-cmsg-acts">
            <a-tooltip title="引用这条回复">
              <button type="button" class="g-cmsg-act" @click="emit('reply', msg)">
                <GIcon icon="ant-design:rollback-outlined" :size="13" />
              </button>
            </a-tooltip>
            <a-tooltip title="撤回：只能撤机器人自己发的，或机器人有管理权限的">
              <button type="button" class="g-cmsg-act" @click="emit('recall', msg)">
                <GIcon icon="ant-design:delete-outlined" :size="13" />
              </button>
            </a-tooltip>
          </span>
        </div>

        <div class="g-cmsg-bubble">
          <MsgSegment
            v-for="(seg, i) in msg.segments"
            :key="i"
            :seg="seg"
            @forward="emit('forward', { msg, seg: $event })"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.g-cmsg {
  margin-bottom: 14px;
}

.g-cmsg-row {
  display: flex;
  gap: 8px;
}

/* 自己发的整行翻过来，头像到右边 */
.g-cmsg.is-self .g-cmsg-row {
  flex-direction: row-reverse;
}

.g-cmsg-avatar {
  flex: none;
  width: 32px;
  height: 32px;
}

.g-cmsg-avatar img {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--g-bg-soft);
  object-fit: cover;
}

.g-cmsg-avatar-text {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--g-bg-soft);
  border: 1px solid var(--g-border);
  color: var(--g-text-sub);
  font-size: 13px;
}

.g-cmsg-main {
  min-width: 0;
  max-width: 78%;
}

.g-cmsg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-cmsg.is-self .g-cmsg-meta {
  flex-direction: row-reverse;
}

.g-cmsg-name {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--g-text-sub);
}

.g-cmsg-role {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  font-size: 10px;
}

.g-cmsg-tag {
  color: var(--g-danger);
}

/* 默认藏起来，悬浮到这条消息上才出现 */
.g-cmsg-acts {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.g-cmsg:hover .g-cmsg-acts {
  opacity: 1;
}

.g-cmsg-act {
  display: inline-flex;
  align-items: center;
  padding: 1px 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-cmsg-act:hover {
  background: var(--g-bg-soft);
  color: var(--g-brand);
}

.g-cmsg-bubble {
  display: inline-block;
  max-width: 100%;
  padding: 8px 12px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  text-align: left;
}

.g-cmsg.is-self .g-cmsg-main {
  /* 气泡是 inline-block，靠文本对齐把它推到右边 */
  text-align: right;
}

.g-cmsg.is-self .g-cmsg-bubble {
  background: var(--g-brand-soft);
  border-color: var(--g-brand-soft);
}

/* 撤回的留在原地压暗，比直接消失更容易对上下文 */
.g-cmsg.is-recalled .g-cmsg-bubble {
  opacity: 0.5;
  text-decoration: line-through;
  text-decoration-color: var(--g-text-dim);
}
</style>
