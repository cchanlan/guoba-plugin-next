<script setup lang="ts">
/**
 * 左侧会话列表。
 *
 * 名单是 Bot 的好友 / 群列表（后端 /chat/sessions 已叠上最后一条摘要与未读），
 * 但页面开着的时候会话状态还在变，所以显示时再用父层轮询来的活跃表覆盖一遍。
 */
import { computed, inject, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { groupAvatar, userAvatar } from '@/utils/avatar'
import {
  apiChatBlacklist,
  apiChatGroupInfo,
  apiChatNote,
  apiChatPin,
  apiChatRefreshGroup,
  apiChatSessions,
  apiChatUserInfo,
  type ChatActiveItem,
  type ChatGroupInfo,
  type ChatSession,
  type ChatType,
  type ChatUserInfo,
} from '@/api'

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

/**
 * 合并实时活跃表：摘要与未读跟着轮询走，排序也跟着变。
 */
const merged = computed(() => {
  const out = list.value.map((it) => {
    const live = props.active[it.key]
    return live ? { ...it, ...live } : it
  })
  out.sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      b.lastTime - a.lastTime ||
      a.id.localeCompare(b.id),
  )
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
    if (reset) {
      infoMap.value = {}
      userMap.value = {}
      infoError.value = {}
      openInfoKey.value = ''
    }
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

/** 会话所属账号的适配器名与 QQBot appid，由 chat 页注入 */
const botAdapter = inject<((uin?: string) => string) | null>('chatBotAdapter', null)
const botAppId = inject<((uin?: string) => string) | null>('chatBotAppId', null)

/**
 * 地址后端按适配器算好放在 avatar 上（QQBot 是 openid，得配 appid 才拼得出来），
 * 没给就本地按 id 兜一下，兜不出来是空串，模板退回图标 / 首字。
 */
function avatar(item: ChatSession) {
  const adapter = botAdapter?.(item.botId) ?? ''
  return item.type === 'group'
    ? groupAvatar(item.id, { avatar: item.avatar, adapter })
    : userAvatar(item.id, {
        avatar: item.avatar,
        appId: botAppId?.(item.botId) ?? '',
        adapter,
      })
}

/** 头像 404（QQ 号不存在、图源被墙）也要退回兜底，按会话 key 记一下 */
const failed = ref<Record<string, boolean>>({})

function timeText(t: number) {
  if (!t) return ''
  const d = new Date(t * 1000)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getMonth() + 1}-${pad(d.getDate())}`
}

/* ---------------- 信息卡（群 / 用户共用一套开关与加载态） ---------------- */

/** 群信息缓存，key -> 数据。取不到时留 null，错误原因单独放 infoError */
const infoMap = ref<Record<string, ChatGroupInfo | null>>({})
/**
 * 用户信息缓存，同样按会话 key 存。
 */
const userMap = ref<Record<string, ChatUserInfo | null>>({})
/** 加载中 / 取不到的原因，两张卡共用 —— 一个会话 key 只会是群或好友其中之一 */
const infoLoading = ref<Record<string, boolean>>({})
const infoError = ref<Record<string, string>>({})
/** 当前开着信息卡的那个会话（受控，右键菜单里的「查看群信息」也走它） */
const openInfoKey = ref('')

async function loadInfo(item: ChatSession, force = false) {
  const isGroup = item.type === 'group'
  const cache = isGroup ? infoMap.value : userMap.value
  if (!force && cache[item.key]) return
  infoLoading.value = { ...infoLoading.value, [item.key]: true }
  try {
    if (isGroup) {
      const data = await apiChatGroupInfo({ botId: item.botId, id: item.id })
      infoMap.value = { ...infoMap.value, [item.key]: data }
    } else {
      const data = await apiChatUserInfo({ botId: item.botId, id: item.id })
      userMap.value = { ...userMap.value, [item.key]: data }
    }
    infoError.value = { ...infoError.value, [item.key]: '' }
  } catch (e: any) {
    if (isGroup) infoMap.value = { ...infoMap.value, [item.key]: null }
    else userMap.value = { ...userMap.value, [item.key]: null }
    infoError.value = { ...infoError.value, [item.key]: e?.message || '信息获取失败' }
  } finally {
    infoLoading.value = { ...infoLoading.value, [item.key]: false }
  }
}

function onInfoOpen(open: boolean, item: ChatSession) {
  openInfoKey.value = open ? item.key : ''
  if (open) void loadInfo(item)
}

/** 「记录 / 实际」两栏，取不到的那一侧给个破折号 */
function memberText(info: ChatGroupInfo) {
  const recorded = info.recordedMemberCount || 0
  const live = info.liveMemberCount || 0
  if (!recorded && !live) return '—'
  return `${recorded || '—'} / ${live || '—'}`
}

/**
 * 刷新群信息：绕过后端那份现取缓存强制问一次适配器。
 */
async function refreshInfo(item: ChatSession) {
  infoLoading.value = { ...infoLoading.value, [item.key]: true }
  try {
    const data = await apiChatRefreshGroup({ botId: item.botId, id: item.id })
    infoMap.value = { ...infoMap.value, [item.key]: data }
    infoError.value = { ...infoError.value, [item.key]: '' }
    if (data.liveError) message.warning(`群信息已刷新，但实际人数没取到：${data.liveError}`)
    else message.success('群信息已刷新')
    await load(true)
  } catch {
  } finally {
    infoLoading.value = { ...infoLoading.value, [item.key]: false }
  }
}

/* ---------------- 右键菜单 ---------------- */

function onMenuClick({ key }: { key: string }, item: ChatSession) {
  if (key === 'pin') void togglePin(item)
  else if (key === 'note') openNote(item)
  else if (key === 'info') onInfoOpen(true, item)
  else if (key === 'refresh') void refreshInfo(item)
  else if (key === 'blacklist' || key === 'unblacklist') void toggleBlacklist(item)
}

/* ---------------- 群备注 ---------------- */

/** 正在编辑备注的那个会话，空串表示弹窗关着 */
const noteKey = ref('')
const noteText = ref('')
const noteSaving = ref(false)

/**
 * 打开备注弹窗。
 */
function openNote(item: ChatSession) {
  noteKey.value = item.key
  const cached = infoMap.value[item.key]
  if (cached) {
    noteText.value = cached.remark || ''
    return
  }
  noteText.value = ''
  void loadInfo(item).then(() => {
    noteText.value = infoMap.value[item.key]?.remark || ''
  })
}

async function saveNote() {
  const key = noteKey.value
  if (!key) return
  const item = list.value.find((it) => it.key === key)
  if (!item) return
  noteSaving.value = true
  try {
    const data = await apiChatNote({ botId: item.botId, id: item.id, note: noteText.value })
    noteText.value = data.note
    const prev = infoMap.value[key]
    if (prev) infoMap.value = { ...infoMap.value, [key]: { ...prev, remark: data.note } }
    if (!data.saved) message.warning('备注已记下，但没写进磁盘，重启面板后会丢')
    else message.success(data.note ? '群备注已保存' : '群备注已清除')
    noteKey.value = ''
    await load(true)
  } catch {
  } finally {
    noteSaving.value = false
  }
}

async function togglePin(item: ChatSession) {
  const pinned = !item.pinned
  try {
    const data = await apiChatPin({ botId: item.botId, type: item.type, id: item.id, pinned })
    if (!data.saved) message.warning('已置顶，但没写进磁盘，重启面板后会丢')
    else message.success(pinned ? '已置顶' : '已取消置顶')
    await load(true)
  } catch {
  }
}

/**
 * 拉黑 / 取消拉黑。
 */
async function toggleBlacklist(item: ChatSession) {
  const blacklisted = !item.blacklisted
  try {
    const data = await apiChatBlacklist({
      botId: item.botId,
      type: item.type,
      id: item.id,
      blacklisted,
    })
    if (!data.saved) message.warning('已记下，但没写进磁盘，重启面板后会丢')
    else if (data.note) message.info(data.note)
    else message.success(blacklisted ? '已拉黑群聊' : '已取消拉黑')
    await load(true)
  } catch {
  }
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

    <a-dropdown
      v-for="item in merged"
      :key="item.key"
      :trigger="['contextmenu']"
      placement="bottomLeft"
    >
      <button
        type="button"
        class="g-sess-item"
        :class="{ 'is-active': item.key === activeKey, 'is-blacklisted': item.blacklisted }"
        @click="emit('select', item)"
      >
        <!-- 群头像：单击弹群信息卡。-->
        <a-popover
          v-if="item.type === 'group'"
          :open="openInfoKey === item.key"
          trigger="click"
          placement="rightTop"
          @openChange="(v: boolean) => onInfoOpen(v, item)"
        >
          <span class="g-sess-avatar" title="点击查看群信息" @click.stop>
            <img
              v-if="avatar(item) && !failed[item.key]"
              :src="avatar(item)"
              :alt="item.name"
              loading="lazy"
              @error="failed[item.key] = true"
            />
            <span v-else class="g-sess-avatar-alt">
              <GIcon icon="ant-design:team-outlined" :size="17" />
            </span>
            <span v-if="item.unread" class="g-sess-dot">
              {{ item.unread > 99 ? '99+' : item.unread }}
            </span>
          </span>

          <template #content>
            <div class="g-sess-info">
              <div class="g-sess-info-head">
                <img v-if="avatar(item) && !failed[item.key]" :src="avatar(item)" :alt="item.name" />
                <span v-else class="g-sess-info-fallback">
                  <GIcon icon="ant-design:team-outlined" :size="18" />
                </span>
                <span class="g-sess-info-name">{{ infoMap[item.key]?.name || item.name || item.id }}</span>
              </div>

              <div v-if="infoLoading[item.key] && !infoMap[item.key]" class="g-sess-info-loading">
                <a-spin size="small" />
              </div>

              <template v-else-if="infoMap[item.key]">
                <dl class="g-sess-info-rows">
                  <dt>群人数（记录 / 实际）</dt>
                  <dd>{{ memberText(infoMap[item.key]!) }}</dd>
                  <dt>Group Open ID</dt>
                  <dd :title="infoMap[item.key]!.openid">{{ infoMap[item.key]!.openid || '—' }}</dd>
                  <dt>群备注</dt>
                  <dd class="g-sess-info-note-cell">
                    <span>{{ infoMap[item.key]!.remark || '（未设置）' }}</span>
                    <button
                      type="button"
                      class="g-sess-note-edit"
                      title="修改群备注"
                      @click.stop="openNote(item)"
                    >
                      <GIcon icon="ant-design:edit-outlined" :size="12" />
                    </button>
                  </dd>
                  <dt>群简介</dt>
                  <dd>{{ infoMap[item.key]!.intro || '（无）' }}</dd>
                  <dt>群分类</dt>
                  <dd>{{ infoMap[item.key]!.category || '（无）' }}</dd>
                  <template v-if="infoMap[item.key]!.tags?.length">
                    <dt>群标签</dt>
                    <dd class="g-sess-info-tags">
                      <span v-for="t in infoMap[item.key]!.tags" :key="t" class="g-sess-tag-pill">
                        {{ t }}
                      </span>
                    </dd>
                  </template>
                </dl>
                <!--现取失败时原因-->
                <p v-if="infoMap[item.key]!.liveError" class="g-sess-info-note">
                  {{ infoMap[item.key]!.liveError }}
                </p>
                <div class="g-sess-info-actions">
                  <a-button
                    size="small"
                    :loading="infoLoading[item.key]"
                    @click.stop="refreshInfo(item)"
                  >
                    <GIcon icon="ant-design:sync-outlined" :size="12" />
                    刷新群信息
                  </a-button>
                  <a-button size="small" danger @click.stop="toggleBlacklist(item)">
                    {{ item.blacklisted ? '取消拉黑此群' : '拉黑此群' }}
                  </a-button>
                </div>
              </template>

              <p v-else class="g-sess-info-note">
                {{ infoError[item.key] || '群信息获取失败' }}
              </p>
            </div>
          </template>
        </a-popover>

        <!-- 私聊头像：同样单击弹信息卡，只是内容换成这个人的资料 -->
        <a-popover
          v-else
          :open="openInfoKey === item.key"
          trigger="click"
          placement="rightTop"
          @openChange="(v: boolean) => onInfoOpen(v, item)"
        >
          <span class="g-sess-avatar" title="点击查看用户信息" @click.stop>
            <img
              v-if="avatar(item) && !failed[item.key]"
              :src="avatar(item)"
              :alt="item.name"
              loading="lazy"
              @error="failed[item.key] = true"
            />
            <span v-else class="g-sess-avatar-alt">{{ (item.name || item.id).slice(0, 1) }}</span>
            <span v-if="item.unread" class="g-sess-dot">
              {{ item.unread > 99 ? '99+' : item.unread }}
            </span>
          </span>

          <template #content>
            <div class="g-sess-info">
              <div class="g-sess-info-head">
                <img v-if="avatar(item) && !failed[item.key]" :src="avatar(item)" :alt="item.name" />
                <span v-else class="g-sess-info-fallback">
                  <GIcon icon="ant-design:user-outlined" :size="18" />
                </span>
                <span class="g-sess-info-name">{{ userMap[item.key]?.name || item.name || item.id }}</span>
              </div>

              <div v-if="infoLoading[item.key] && !userMap[item.key]" class="g-sess-info-loading">
                <a-spin size="small" />
              </div>

              <template v-else-if="userMap[item.key]">
                <dl class="g-sess-info-rows">
                  <template v-if="userMap[item.key]!.openid">
                    <dt>openid</dt>
                    <dd :title="userMap[item.key]!.openid">{{ userMap[item.key]!.openid }}</dd>
                  </template>
                  <!-- QQBot 是 openid 那一套，OneBot 系就是个 QQ 号，标签跟着换 -->
                  <dt>{{ userMap[item.key]!.qqbot ? '账号' : 'QQ' }}</dt>
                  <dd :title="item.id">{{ item.id }}</dd>
                  <template v-if="userMap[item.key]!.unionid">
                    <dt>unionid</dt>
                    <dd :title="userMap[item.key]!.unionid">{{ userMap[item.key]!.unionid }}</dd>
                  </template>
                  <template v-if="userMap[item.key]!.remark">
                    <dt>好友备注</dt>
                    <dd>{{ userMap[item.key]!.remark }}</dd>
                  </template>
                </dl>
                <p v-if="userMap[item.key]!.liveError" class="g-sess-info-note">
                  {{ userMap[item.key]!.liveError }}
                </p>
              </template>

              <p v-else class="g-sess-info-note">
                {{ infoError[item.key] || '用户信息获取失败' }}
              </p>
            </div>
          </template>
        </a-popover>

        <span class="g-sess-main">
          <span class="g-sess-line">
            <!--有备注就显示备注，-->
            <GIcon
              v-if="item.note"
              icon="ant-design:tag-outlined"
              :size="11"
              class="g-sess-note-mark"
            />
            <span
              class="g-sess-name"
              :class="{ 'g-sess-name-note': !!item.note }"
              :title="item.note ? `${item.name || item.id}（备注：${item.note}）` : ''"
            >
              {{ item.note || item.name || item.id }}
            </span>
            <GIcon v-if="item.pinned" icon="ant-design:pushpin-filled" :size="11" class="g-sess-pin" />
            <span v-if="item.temp" class="g-sess-tag">临时</span>
            <span v-if="item.blacklisted" class="g-sess-tag">已拉黑</span>
            <span class="g-sess-time">{{ timeText(item.lastTime) }}</span>
          </span>
          <span class="g-sess-last">{{ item.lastText || item.id }}</span>
        </span>
      </button>

      <template #overlay>
        <a-menu @click="(e: any) => onMenuClick(e, item)">
          <a-menu-item key="pin">
            <GIcon
              :icon="item.pinned ? 'ant-design:pushpin-filled' : 'ant-design:pushpin-outlined'"
              :size="13"
            />
            {{ item.pinned ? '取消置顶' : '置顶' }}
          </a-menu-item>
          <!-- 群才有下面这些：备注 / 查看 / 刷新群信息、拉黑群聊 -->
          <template v-if="item.type === 'group'">
            <a-menu-divider />
            <a-menu-item key="note">
              <GIcon icon="ant-design:edit-outlined" :size="13" />
              修改群备注
            </a-menu-item>
            <a-menu-item key="info">
              <GIcon icon="ant-design:info-circle-outlined" :size="13" />
              查看群信息
            </a-menu-item>
            <a-menu-item key="refresh">
              <GIcon icon="ant-design:sync-outlined" :size="13" />
              刷新群信息
            </a-menu-item>
            <a-menu-divider />
            <a-menu-item :key="item.blacklisted ? 'unblacklist' : 'blacklist'" danger>
              <GIcon icon="ant-design:stop-outlined" :size="13" />
              {{ item.blacklisted ? '取消拉黑群聊' : '拉黑群聊' }}
            </a-menu-item>
          </template>
        </a-menu>
      </template>
    </a-dropdown>

    <div v-if="hasMore" class="g-sess-more">
      <a-button size="small" type="text" :loading="loading" @click="more">
        加载更多（{{ merged.length }} / {{ total }}）
      </a-button>
    </div>
    <div v-else-if="loading" class="g-sess-more">
      <GIcon icon="ant-design:sync-outlined" :size="13" class="g-sess-spin" />
      加载中
    </div>

    <!--群备注弹窗。-->
    <a-modal
      :open="!!noteKey"
      title="修改群备注"
      :confirm-loading="noteSaving"
      ok-text="保存"
      cancel-text="取消"
      :width="360"
      @ok="saveNote"
      @cancel="noteKey = ''"
    >
      <p class="g-note-tip">备注只存在锅巴面板里，用来给群起个好认的名字，不影响机器人。</p>
      <a-input
        v-model:value="noteText"
        placeholder="输入群备注，留空即清除"
        :maxlength="64"
        allow-clear
        @press-enter="saveNote"
      />
    </a-modal>
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

.g-sess-item.is-blacklisted {
  opacity: 0.6;
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

/* 取不到头像时的占位：群给个图标，私聊给名字首字 */
.g-sess-avatar-alt {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--g-bg-soft);
  border: 1px solid var(--g-border);
  color: var(--g-text-sub);
  font-size: 14px;
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

.g-sess-name-note {
  color: var(--g-brand);
}

.g-sess-note-mark {
  flex: none;
  color: var(--g-brand);
}

.g-sess-pin {
  flex: none;
  color: var(--g-brand);
}

.g-sess-tag {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  color: var(--g-danger);
  font-size: 10px;
  line-height: 15px;
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

/* ---------------- 点头像弹出的信息卡（群 / 用户共用这套版式） ---------------- */

.g-sess-info {
  max-width: 300px;
  color: var(--g-text);
  font-size: 13px;
}

.g-sess-info-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--g-border);
}

.g-sess-info-head img,
.g-sess-info-fallback {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--g-bg-soft);
  object-fit: cover;
}

.g-sess-info-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--g-text-sub);
}

.g-sess-info-name {
  min-width: 0;
  font-weight: 600;
  word-break: break-all;
}

.g-sess-info-loading {
  padding: 12px 0;
  text-align: center;
}

.g-sess-info-rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 0;
}

.g-sess-info-rows dt {
  color: var(--g-text-dim);
  white-space: nowrap;
}

.g-sess-info-rows dd {
  margin: 0;
  color: var(--g-text-sub);
  word-break: break-all;
}

.g-sess-info-note-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.g-sess-info-note-cell span {
  min-width: 0;
  flex: 1;
}

.g-sess-note-edit {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-sess-note-edit:hover {
  background: var(--g-bg-soft);
  color: var(--g-brand);
}

.g-sess-info-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.g-sess-tag-pill {
  padding: 0 6px;
  border: 1px solid var(--g-border);
  border-radius: 9px;
  background: var(--g-bg-soft);
  color: var(--g-text-dim);
  font-size: 11px;
  line-height: 17px;
}

.g-note-tip {
  margin: 0 0 8px;
  color: var(--g-text-dim);
  font-size: 12px;
  line-height: 1.7;
}

.g-sess-info-note {
  margin: 8px 0 0;
  color: var(--g-danger);
  font-size: 12px;
  line-height: 1.7;
}

.g-sess-info-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--g-border);
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
