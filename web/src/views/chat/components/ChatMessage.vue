<script setup lang="ts">
/**
 * 消息流里的一条。
 *
 * bot 自己发的靠右，别人的靠左。消息头（头像 + 昵称 + 群头衔 + 时间）在气泡上方，
 * 操作收敛到右键菜单，跟参考图一致；悬浮时出现一个「更多」入口，点开是同一个菜单，
 * 方便触屏和习惯左键的人。点头像弹出这个人的信息卡。
 *
 * 菜单按适配器分叉：QQ 官方机器人多出 rawMsg / rawEvent 两档原文、两种被动回复
 * （msg_id / event_id）和「复读(MD)」，其余适配器只有通用那几项。
 */
import { computed, inject, ref } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import MsgSegment from '@/components/msg/MsgSegment.vue'
import { apiChatMemberInfo } from '@/api'
import { toDataUrl, writeRich, writeText } from '@/utils/clipboard'
import { userAvatar } from '@/utils/avatar'
import type { ChatMsg, MsgSeg } from '@/api'

/** 一条消息最多复制几张图，多了粘贴目标也接不住 */
const MAX_COPY_IMAGES = 9

/** 群身份的显示名，认不出就原样显示 */
const ROLE_TEXT: Record<string, string> = {owner: '群主', admin: '管理员', member: '群成员'}

const props = defineProps<{ msg: ChatMsg; showDate: boolean }>()

const emit = defineEmits<{
  /** 右键「引用回复」：QQ 上显示成一条引用，所有适配器都有 */
  reply: [msg: ChatMsg]
  /** 右键「使用本消息 msg_id 回复」：官bot 的被动回复，只有 QQBot 有 */
  replyMsgId: [msg: ChatMsg]
  /** 右键「使用本消息 event_id 回复」：同上，带的是 event_id */
  replyEventId: [msg: ChatMsg]
  recall: [msg: ChatMsg]
  forward: [payload: { msg: ChatMsg; seg: MsgSeg }]
  /** 右键 @：把消息发送者塞进输入框的 @ 列表 */
  at: [msg: ChatMsg]
  /** 右键「查看消息 / rawMsg / rawEvent」：弹出来看，落在哪一档由 tab 决定 */
  raw: [msg: ChatMsg, tab: 'array' | 'raw']
  /** 右键「戳一戳」：对消息发送者 */
  poke: [msg: ChatMsg]
  /** 右键「复读」：把这条按段原样再发一条（图片 / 表情都不会被降级成文字） */
  resend: [msg: ChatMsg]
  /** 右键「复读(MD)」：把这条的正文当 markdown 再发一遍 */
  resendMd: [msg: ChatMsg]
  /** 右键「收藏表情」：把这条消息里的表情收进自定义表情 */
  collectEmoji: [msg: ChatMsg]
}>()

const avatarFailed = ref(false)

/** 消息所属账号的适配器名与 QQBot appid，由 chat 页注入 —— QQBot 的头像地址跟 QQ 号那套不一样 */
const botAdapter = inject<((uin?: string) => string) | null>('chatBotAdapter', null)
const botAppId = inject<((uin?: string) => string) | null>('chatBotAppId', null)

/**
 * 这条消息所在账号是不是 QQ 官方机器人。右键菜单与信息卡都按它分叉 ——
 * rawMsg / rawEvent、两种被动回复、复读(MD) 都是 QQBot 专有的。
 */
const isQQBot = computed(() => (botAdapter?.(props.msg.botId) ?? '') === 'QQBot')

/** 这条消息里有没有能收藏的图：QQ 自带的小黄脸、表情包，或者一张普通图片 */
const hasEmoji = computed(() =>
  (props.msg.segments ?? []).some((s) => s.type === 'face' || s.type === 'image'),
)

const name = computed(() => {
  const s = props.msg.sender
  return s.card || s.nickname || s.userId || '未知'
})

/** 信息卡标题用本身昵称：消息流外面显示的已经是群名片，卡片里再写一遍就重复了 */
const realName = computed(() => {
  const s = props.msg.sender
  return s.nickname || s.card || s.userId || '未知'
})

const avatar = computed(() =>
  userAvatar(props.msg.sender.userId, {
    // 后端已按适配器算好，缺了才本地拼；appid 不等于 botId，得按 uin 查
    avatar: props.msg.sender.avatar,
    appId: botAppId?.(props.msg.botId) ?? '',
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
    // markdown 段按渲染后的样子带走：复制出去的是 `[图片]`、链接文字，
    // 而不是 `![图片](https://…)` 这种源码
    else if (seg.type === 'markdown') out += mdToText(seg.content ?? '')
    else if (seg.type === 'image') out += withImage ? '[图片] ' : ''
    else if (seg.type === 'record') out += '[语音] '
    else if (seg.type === 'video') out += '[视频] '
    else if (seg.type === 'file') out += '[文件] '
    else if (seg.type === 'face') out += '[表情] '
    else if (seg.type === 'forward') out += '[合并转发] '
  }
  return out.trim()
}

/** markdown 压成纯文本。图片的 alt 里带 `#宽px #高px` 的那种是 QQ 自己加的，认不出内容 */
function mdToText(content: string) {
  return String(content ?? '')
    .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, (whole, alt) => (alt && !alt.includes('#') ? alt : '[图片]'))
    .replace(/\[([^\]\n]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>\s]+/gm, '')
    .replace(/[`*_~]+/g, '')
}

/**
 * 点头像弹出的信息卡。
 *
 * 入群时间不在消息事件里，卡片打开时才单独问一次；加载中 / 取不到都占一行，
 * 复制按钮只挂在真正有值的行上。
 */
const memberInfo = ref<{ loading: boolean; joinTime: number; sign: string; error: string }>({
  loading: false,
  joinTime: 0,
  sign: '',
  error: '',
})
let memberInfoSeq = 0

function formatJoinTime(seconds: number) {
  const d = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const userRows = computed(() => {
  const s = props.msg.sender
  const rows: Array<{ label: string; value: string; copy?: boolean }> = []
  if (props.msg.self) rows.push({label: '来源', value: '机器人自己'})
  if (s.card && s.card !== s.nickname) rows.push({label: '群名片', value: s.card, copy: true})
  if (s.role) rows.push({label: '群身份', value: ROLE_TEXT[s.role] ?? s.role})
  if (s.title) rows.push({label: '群头衔', value: s.title, copy: true})
  const openid = s.openid || (isQQBot.value ? String(s.userId).split(':').pop() ?? '' : '')
  if (openid) rows.push({label: 'openid', value: openid, copy: true})
  rows.push({label: isQQBot.value ? '账号' : 'QQ', value: s.userId || '未知', copy: !!s.userId})
  if (memberInfo.value.sign) rows.push({label: '签名', value: memberInfo.value.sign, copy: true})
  if (s.unionid) rows.push({label: 'unionid', value: s.unionid, copy: true})
  // 入群时间只有群聊才有，私聊不显示这一行
  if (props.msg.type === 'group') {
    if (memberInfo.value.loading) rows.push({label: '入群时间', value: '查询中…'})
    else if (memberInfo.value.joinTime) {
      rows.push({label: '入群时间', value: formatJoinTime(memberInfo.value.joinTime)})
    } else if (memberInfo.value.error) {
      rows.push({label: '入群时间', value: memberInfo.value.error})
    }
  }
  return rows
})

/** 卡片打开时才查入群时间；拿不到就重试（后端有失败缓存，不会打爆接口） */
function onUserCardOpen(open: boolean) {
  if (!open || props.msg.type !== 'group') return
  void loadMemberInfo()
}

async function loadMemberInfo() {
  const state = memberInfo.value
  if (state.loading || state.joinTime) return
  state.loading = true
  state.error = ''
  const seq = ++memberInfoSeq
  try {
    const data = await apiChatMemberInfo({
      botId: props.msg.botId,
      groupId: props.msg.id,
      userId: props.msg.sender.userId,
    })
    if (seq !== memberInfoSeq) return
    state.joinTime = data.joinTime || 0
    state.sign = data.sign || ''
    if (!state.joinTime) state.error = data.liveError || '取不到入群时间'
  } catch (err: any) {
    if (seq !== memberInfoSeq) return
    state.error = err?.message || '取不到入群时间'
  } finally {
    if (seq === memberInfoSeq) state.loading = false
  }
}

/** 信息卡里的小复制按钮 */
async function copyValue(value: string, label: string) {
  if (!value) return
  if (await writeText(value)) message.success(`已复制${label}`)
  else message.error('复制失败，请手动选中文本')
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
  else if (key === 'replyMsgId') emit('replyMsgId', props.msg)
  else if (key === 'replyEventId') emit('replyEventId', props.msg)
  else if (key === 'recall') emit('recall', props.msg)
  else if (key === 'copy') void copyMessage()
  else if (key === 'at') emit('at', props.msg)
  // 「查看消息」落在段数组那一档，rawMsg / rawEvent 各自落在对应档上
  else if (key === 'raw') emit('raw', props.msg, 'array')
  else if (key === 'rawMsg') emit('raw', props.msg, 'array')
  else if (key === 'rawEvent') emit('raw', props.msg, 'raw')
  else if (key === 'poke') emit('poke', props.msg)
  else if (key === 'resend') emit('resend', props.msg)
  else if (key === 'resendMd') emit('resendMd', props.msg)
  else if (key === 'collectEmoji') emit('collectEmoji', props.msg)
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
        <!-- 点头像看这个人的信息 -->
        <a-popover
          trigger="click"
          placement="rightTop"
          :get-popup-container="getPopupContainer"
          @open-change="onUserCardOpen"
        >
          <template #content>
            <!--
              卡片里的文字要能长按选中复制；右键 / 长按也不再冒泡成消息的菜单。
              按下事件也拦一道：弹层挂在消息行里，不拦的话 antd 会把「点复制按钮」
              当成点外部，复制完卡片就关了。
            -->
            <div
              class="g-cmsg-user"
              @contextmenu.stop
              @mousedown.stop
              @pointerdown.stop
              @touchstart.stop
            >
              <div class="g-cmsg-user-head">
                <img v-if="avatar && !avatarFailed" :src="avatar" :alt="realName" />
                <span v-else class="g-cmsg-user-fallback">{{ realName.slice(0, 1) }}</span>
                <span class="g-cmsg-user-nick">{{ realName }}</span>
                <button
                  type="button"
                  class="g-cmsg-copy"
                  title="复制昵称"
                  @click.stop="copyValue(realName, '昵称')"
                >
                  <GIcon icon="ant-design:copy-outlined" :size="12" />
                </button>
              </div>
              <dl class="g-cmsg-user-rows">
                <template v-for="row in userRows" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd :title="row.value">
                    <span class="g-cmsg-user-val">{{ row.value }}</span>
                    <button
                      v-if="row.copy"
                      type="button"
                      class="g-cmsg-copy"
                      :title="`复制${row.label}`"
                      @click.stop="copyValue(row.value, row.label)"
                    >
                      <GIcon icon="ant-design:copy-outlined" :size="11" />
                    </button>
                  </dd>
                </template>
              </dl>
            </div>
          </template>
          <span class="g-cmsg-avatar" title="点击查看用户信息">
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
        </a-popover>

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
          <a-menu-item v-if="hasEmoji" key="collectEmoji">
            <GIcon icon="😊" :size="13" />
            收藏表情
          </a-menu-item>
          <template v-if="isQQBot">
            <a-menu-item key="rawMsg">
              <GIcon icon="ant-design:code-outlined" :size="13" />
              查看 rawMsg
            </a-menu-item>
            <a-menu-item v-if="!msg.self" key="rawEvent">
              <GIcon icon="ant-design:file-text-outlined" :size="13" />
              查看 rawEvent
            </a-menu-item>
          </template>
          <a-menu-item v-else key="raw">
            <GIcon icon="ant-design:code-outlined" :size="13" />
            查看消息
          </a-menu-item>
          <a-menu-item key="resend">
            <GIcon icon="ant-design:reload-outlined" :size="13" />
            {{ isQQBot ? '复读' : '普通复读' }}
          </a-menu-item>
          <a-menu-item v-if="isQQBot" key="resendMd">
            <GIcon icon="ant-design:edit-outlined" :size="13" />
            复读(MD)
          </a-menu-item>
          <!-- 官bot 没有戳一戳这个接口，留着入口但置灰，比点了必失败强 -->
          <a-menu-item key="poke" :disabled="isQQBot">
            <GIcon icon="ant-design:aim-outlined" :size="13" />
            戳一戳{{ isQQBot ? '（官bot 不支持）' : '' }}
          </a-menu-item>
          <a-menu-item key="reply">
            <GIcon icon="ant-design:rollback-outlined" :size="13" />
            引用回复
          </a-menu-item>
          <!--
            两种被动回复只有官bot 有：带 msg_id / event_id 才算被动消息，
            不然要走主动配额。跟上面的「引用回复」是两回事 —— 那个只让 QQ 显示一条引用。
          -->
          <template v-if="isQQBot">
            <a-menu-item key="replyMsgId">
              <GIcon icon="ant-design:key-outlined" :size="13" />
              使用本消息 msg_id 回复
            </a-menu-item>
            <a-menu-item v-if="msg.eventId" key="replyEventId">
              <GIcon icon="ant-design:thunderbolt-outlined" :size="13" />
              使用本消息 event_id 回复
            </a-menu-item>
          </template>
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
  display: block;
  width: 32px;
  height: 32px;
  cursor: pointer;
}

/* ---------------- 点头像弹出的信息卡 ---------------- */

.g-cmsg-user {
  max-width: 280px;
  color: var(--g-text);
  font-size: 13px;
  /* 骨架里全局禁选，卡片里的值要能长按选中复制，这里单独放行 */
  -webkit-user-select: text;
  user-select: text;
}

.g-cmsg-user-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--g-border);
}

.g-cmsg-user-head img,
.g-cmsg-user-fallback {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--g-bg-soft);
  object-fit: cover;
}

.g-cmsg-user-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--g-text-sub);
  font-size: 15px;
}

.g-cmsg-user-nick {
  min-width: 0;
  font-weight: 600;
  word-break: break-all;
}

.g-cmsg-user-rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 0;
}

.g-cmsg-user-rows dt {
  color: var(--g-text-dim);
  white-space: nowrap;
}

.g-cmsg-user-rows dd {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  color: var(--g-text-sub);
  word-break: break-all;
}

.g-cmsg-user-val {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 信息卡里的复制按钮：静态小图标，点一下复制对应那一行的值 */
.g-cmsg-copy {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-cmsg-copy:hover,
.g-cmsg-copy:active {
  background: var(--g-bg-soft);
  color: var(--g-brand);
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
