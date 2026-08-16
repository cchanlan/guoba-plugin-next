<script setup lang="ts">
/**
 * 消息流里的一条。
 *
 * bot 自己发的靠右，别人的靠左。消息头（头像 + 昵称 + 群头衔 + 时间）在气泡上方，
 * 操作收敛到右键菜单（复制 / 引用 / 撤回），跟参考图一致；悬浮时出现一个「更多」入口，
 * 点开是同一个菜单，方便触屏和习惯左键的人。
 */
import { computed, inject, ref } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import MsgSegment from '@/components/msg/MsgSegment.vue'
import { toDataUrl, writeRich, writeText } from '@/utils/clipboard'
import { userAvatar } from '@/utils/avatar'
import type { ChatMsg, MsgSeg } from '@/api'

/** 一条消息最多复制几张图，多了粘贴目标也接不住 */
const MAX_COPY_IMAGES = 9

const props = defineProps<{ msg: ChatMsg; showDate: boolean }>()

const emit = defineEmits<{
  reply: [msg: ChatMsg]
  recall: [msg: ChatMsg]
  forward: [payload: { msg: ChatMsg; seg: MsgSeg }]
  /** 右键 @：把消息发送者塞进输入框的 @ 列表 */
  at: [msg: ChatMsg]
  /** 右键「查看原始」：把这条消息的结构弹出来看 */
  raw: [msg: ChatMsg]
  /** 右键「戳一戳」：对消息发送者 */
  poke: [msg: ChatMsg]
  /** 右键「复读」：把这条按段原样再发一条（图片 / 表情都不会被降级成文字） */
  resend: [msg: ChatMsg]
}>()

const avatarFailed = ref(false)

/** 消息所属账号的适配器名，由 chat 页注入 —— QQBot 的头像地址跟 QQ 号那套不一样 */
const botAdapter = inject<((uin?: string) => string) | null>('chatBotAdapter', null)

const name = computed(() => {
  const s = props.msg.sender
  return s.card || s.nickname || s.userId || '未知'
})

const avatar = computed(() =>
  userAvatar(props.msg.sender.userId, {
    // QQBot 的 appid 就是 botId
    appId: props.msg.botId,
    adapter: botAdapter?.(props.msg.botId) ?? '',
  }),
)

/** 群身份标签：群主 / 管理 / 群头衔，有就显示在昵称后 */
const identity = computed(() => {
  const s = props.msg.sender
  if (s.title) return s.title
  if (s.role === 'owner') return '群主'
  if (s.role === 'admin') return '管理'
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

/**
 * 整条压成纯文本。
 *
 * `withImage` 决定图片段要不要留 `[图片]` 占位：整条复制时图片本身也进剪贴板了
 * （面板输入框、QQ 都能从 HTML 里取出来），再写一行占位反而会多出一串没用的文字；
 * 只有图片读不到、降级成只复制文字时才需要占位说明这儿有张图。
 */
function toText(withImage: boolean) {
  let out = ''
  for (const seg of props.msg.segments) {
    if (seg.type === 'text') out += seg.text ?? ''
    else if (seg.type === 'at') out += `@${seg.name || seg.qq} `
    else if (seg.type === 'image') out += withImage ? '[图片] ' : ''
    else if (seg.type === 'record') out += '[语音] '
    else if (seg.type === 'video') out += '[视频] '
    else if (seg.type === 'file') out += '[文件] '
    else if (seg.type === 'face') out += '[表情] '
    else if (seg.type === 'forward') out += '[合并转发] '
  }
  return out.trim()
}

/** 跟图片一起复制时用的文本 */
const copyText = computed(() => toText(false))

/** 右键「撤回」只有 bot 自己发的才显示 */
const canRecall = computed(() => props.msg.self && !!props.msg.messageId)

/** 菜单浮层挂到消息容器里，免得被页面滚动条裁掉 */
function getPopupContainer(node: HTMLElement) {
  return node?.parentNode ?? document.body
}

/** 页面注入的资源地址拼法，跟 MsgSegment 用的是同一份 */
const proxyUrl = inject<((url: string) => string) | null>('msgProxyUrl', null)
const assetUrl = inject<((assetId: string) => string) | null>('msgAssetUrl', null)

/**
 * 复制一张图能试的地址，按优先级排。
 *
 * QQ 直链不给跨域头，`fetch` 拿不到字节，得先走服务端代理（同源）；代理挂了再退直链，
 * 万一图源恰好允许跨域还能救回来。
 */
function imgSrcs(seg: MsgSeg): string[] {
  const out: string[] = []
  if (seg.url) {
    if (proxyUrl) out.push(proxyUrl(seg.url))
    out.push(seg.url)
  } else if (seg.assetId && assetUrl) {
    out.push(assetUrl(seg.assetId))
  }
  return out
}

/** a-menu 的点击回调，key 见模板菜单项 */
function onMenuClick({ key }: { key: string }) {
  if (key === 'reply') emit('reply', props.msg)
  else if (key === 'recall') emit('recall', props.msg)
  else if (key === 'copy') void copyMessage()
  else if (key === 'at') emit('at', props.msg)
  else if (key === 'raw') emit('raw', props.msg)
  else if (key === 'poke') emit('poke', props.msg)
  else if (key === 'resend') emit('resend', props.msg)
}

/** 整条复制：文本和图片一起进剪贴板，跟沙盒一致 */
async function copyMessage() {
  const text = copyText.value
  const segs = props.msg.segments.filter((seg) => seg.type === 'image').slice(0, MAX_COPY_IMAGES)
  if (!text && !segs.length) {
    message.info('这条消息没有可复制的内容')
    return
  }

  const datas = (
    await Promise.all(
      segs.map(async (seg) => {
        for (const src of imgSrcs(seg)) {
          const data = await toDataUrl(src)
          if (data) return data
        }
        return null
      }),
    )
  ).filter((v): v is string => !!v)

  if (segs.length && !datas.length) {
    // 图一张都没读到（rkey 过期 / 代理失败），至少把文字带走，这时才写 [图片] 占位
    if (await writeText(toText(true))) message.warning('图片读不到，只复制了文字')
    else message.error('复制失败，请手动选中文本')
    return
  }
  if (await writeRich(text, datas)) {
    message.success(datas.length ? `已复制（含 ${datas.length} 张图）` : '已复制')
  } else {
    message.error(datas.length ? '浏览器不允许复制图片（http 下常见）' : '复制失败，请手动选中文本')
  }
}
</script>

<template>
  <div class="g-cmsg" :class="{ 'is-self': msg.self, 'is-recalled': msg.recalled }">
    <!-- 右键出菜单，左键点「更多」出同一个菜单 -->
    <a-dropdown
      :trigger="['contextmenu']"
      placement="topLeft"
      :get-popup-container="getPopupContainer"
    >
      <div class="g-cmsg-row">
        <span class="g-cmsg-avatar">
          <img
            v-if="avatar && !avatarFailed"
            :src="avatar"
            :alt="name"
            loading="lazy"
            @error="avatarFailed = true"
          />
          <!-- 头像取自腾讯，离线、被墙、或 QQBot 下拿不到地址时退回首字 -->
          <span v-else class="g-cmsg-avatar-text">{{ name.slice(0, 1) }}</span>
        </span>

        <div class="g-cmsg-main">
          <div class="g-cmsg-meta">
            <span class="g-cmsg-name">{{ name }}</span>
            <span v-if="identity" class="g-cmsg-identity">{{ identity }}</span>
            <span class="g-cmsg-time">{{ timeText }}</span>
            <span v-if="msg.recalled" class="g-cmsg-tag">已撤回</span>
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

        <!-- 悬浮时的「更多」入口，方便不右键的人 -->
        <span class="g-cmsg-more">
          <GIcon icon="ant-design:more-outlined" :size="15" />
        </span>
      </div>

      <template #overlay>
        <a-menu @click="onMenuClick">
          <a-menu-item key="at">
            <GIcon icon="ant-design:user-outlined" :size="13" />
            @提及
          </a-menu-item>
          <a-menu-item key="copy">
            <GIcon icon="ant-design:copy-outlined" :size="13" />
            复制
          </a-menu-item>
          <a-menu-item key="raw">
            <GIcon icon="ant-design:code-outlined" :size="13" />
            查看原始消息
          </a-menu-item>
          <a-menu-item key="resend">
            <GIcon icon="ant-design:reload-outlined" :size="13" />
            复读
          </a-menu-item>
          <a-menu-item key="poke">
            <GIcon icon="ant-design:aim-outlined" :size="13" />
            戳一戳
          </a-menu-item>
          <a-menu-item key="reply">
            <GIcon icon="ant-design:rollback-outlined" :size="13" />
            引用这条
          </a-menu-item>
          <a-menu-item v-if="canRecall" key="recall">
            <GIcon icon="ant-design:delete-outlined" :size="13" />
            撤回
          </a-menu-item>
        </a-menu>
      </template>
    </a-dropdown>
  </div>
</template>

<style scoped>
.g-cmsg {
  margin-bottom: 14px;
}

.g-cmsg-row {
  position: relative;
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

/* 消息头：昵称 + 头衔 + 时间，跟 QQ 一样压在气泡上方 */
.g-cmsg-meta {
  display: flex;
  align-items: baseline;
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

.g-cmsg-identity {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  font-size: 10px;
}

.g-cmsg-tag {
  color: var(--g-danger);
}

.g-cmsg-bubble {
  display: inline-block;
  max-width: 100%;
  padding: 8px 12px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 2px 10px 10px 10px;
  /* 气泡比背景高一层，聊天气泡的观感靠这个阴影撑出来 */
  box-shadow: 0 1px 2px var(--g-shadow);
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  text-align: left;
}

/* 自己发的气泡在右侧，圆角反过来 */
.g-cmsg.is-self .g-cmsg-main {
  text-align: right;
}

.g-cmsg.is-self .g-cmsg-bubble {
  background: var(--g-brand-soft);
  border-color: var(--g-brand-soft);
  border-radius: 10px 2px 10px 10px;
}

/* 撤回的留在原地压暗，比直接消失更容易对上下文 */
.g-cmsg.is-recalled .g-cmsg-bubble {
  opacity: 0.5;
  text-decoration: line-through;
  text-decoration-color: var(--g-text-dim);
}

/* 「更多」入口：悬浮才出现，不占布局 */
.g-cmsg-more {
  position: absolute;
  top: 50%;
  right: -18px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--g-text-dim);
  transform: translateY(-50%);
}

.g-cmsg.is-self .g-cmsg-more {
  right: auto;
  left: -18px;
}

.g-cmsg:hover .g-cmsg-more {
  display: inline-flex;
}

.g-cmsg-more:hover {
  background: var(--g-bg-soft);
  color: var(--g-brand);
}
</style>
