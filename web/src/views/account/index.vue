<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Alert,
  Avatar,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Progress,
  RadioButton,
  RadioGroup,
  Table,
  Tabs,
  TabPane,
  Tag,
  Textarea,
  Tooltip,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiCancelBroadcast,
  apiDeleteFriend,
  apiGetBroadcast,
  apiQueryFriendList,
  apiQueryGroupList,
  apiQuitGroup,
  apiSendMsg,
  apiStartBroadcast,
  type BroadcastTarget,
  type BroadcastTask,
} from '@/api'

/** QQ 头像地址，s=100 是够用的尺寸 */
function userAvatar(qq: string | number) {
  return `https://q1.qlogo.cn/g?b=qq&s=100&nk=${qq}`
}

function groupAvatar(groupId: string | number) {
  return `https://p.qlogo.cn/gh/${groupId}/${groupId}/100`
}

interface PageState {
  loading: boolean
  records: any[]
  total: number
  pageNo: number
  pageSize: number
  keyword: string
  /** 群发时勾选的行 */
  selected: (string | number)[]
}

function createPageState(): PageState {
  return {
    loading: false,
    records: [],
    total: 0,
    pageNo: 1,
    pageSize: 20,
    keyword: '',
    selected: [],
  }
}

const activeTab = ref('friend')
const friend = reactive(createPageState())
const group = reactive(createPageState())

const friendColumns = [
  { title: '好友', key: 'user', width: 260 },
  { title: 'QQ', dataIndex: 'user_id', key: 'user_id', width: 170 },
  { title: '备注', dataIndex: 'remark', key: 'remark' },
  { title: '操作', key: 'action', width: 90, align: 'center' as const },
]

const groupColumns = [
  { title: '群聊', key: 'group', width: 280 },
  { title: '群号', dataIndex: 'group_id', key: 'group_id', width: 170 },
  { title: '人数', key: 'member', width: 120 },
  { title: '权限', key: 'role', width: 110 },
  { title: '操作', key: 'action', width: 90, align: 'center' as const },
]

async function loadFriends() {
  friend.loading = true
  try {
    const params: Record<string, any> = { pageNo: friend.pageNo, pageSize: friend.pageSize }
    const kw = friend.keyword.trim()
    if (kw) {
      // 纯数字按 QQ 号查，否则按昵称/备注查
      if (/^\d+$/.test(kw)) params.query_qq = kw
      else params.query_name = kw
    }
    const page = await apiQueryFriendList(params)
    friend.records = page?.records ?? []
    friend.total = page?.total ?? 0
  } catch {
    friend.records = []
    friend.total = 0
  } finally {
    friend.loading = false
  }
}

async function loadGroups() {
  group.loading = true
  try {
    const params: Record<string, any> = { pageNo: group.pageNo, pageSize: group.pageSize }
    const kw = group.keyword.trim()
    if (kw) {
      if (/^\d+$/.test(kw)) params.query_group_id = kw
      else params.query_name = kw
    }
    const page = await apiQueryGroupList(params)
    group.records = page?.records ?? []
    group.total = page?.total ?? 0
  } catch {
    group.records = []
    group.total = 0
  } finally {
    group.loading = false
  }
}

function onFriendTableChange(pagination: any) {
  friend.pageNo = pagination.current
  friend.pageSize = pagination.pageSize
  loadFriends()
}

function onGroupTableChange(pagination: any) {
  group.pageNo = pagination.current
  group.pageSize = pagination.pageSize
  loadGroups()
}

function searchFriends() {
  friend.pageNo = 1
  loadFriends()
}

function searchGroups() {
  group.pageNo = 1
  loadGroups()
}

/* ---------------- 发消息 ---------------- */

interface SendTarget {
  type: 'friend' | 'group'
  id: number | string
  name: string
  avatar: string
  botId?: number | string
}

const sendOpen = ref(false)
const sending = ref(false)
const sendMsgText = ref('')
const sendTarget = ref<SendTarget | null>(null)

const sendTitle = computed(() =>
  sendTarget.value?.type === 'group' ? '发送群消息' : '发送私聊消息',
)

function openSend(type: 'friend' | 'group', record: any) {
  sendTarget.value =
    type === 'group'
      ? {
          type,
          id: record.group_id,
          name: record.group_name || '未知群名',
          avatar: groupAvatar(record.group_id),
          botId: record.bot_id,
        }
      : {
          type,
          id: record.user_id,
          name: record.remark || record.nickname || '未知昵称',
          avatar: userAvatar(record.user_id),
          botId: record.bot_id,
        }
  sendMsgText.value = ''
  sendOpen.value = true
}

async function confirmSend() {
  const target = sendTarget.value
  const msg = sendMsgText.value.trim()
  if (!target) return
  if (!msg) {
    message.warning('消息内容不能为空')
    return
  }
  sending.value = true
  try {
    await apiSendMsg({ type: target.type, id: target.id, msg, botId: target.botId })
    message.success('消息已发送')
    sendOpen.value = false
    sendMsgText.value = ''
  } finally {
    sending.value = false
  }
}

/* ---------------- 群发 ---------------- */

/** 发送范围：勾选的 / 当前页 / 全部 */
type CastScope = 'selected' | 'page' | 'all'

const castOpen = ref(false)
const castType = ref<'friend' | 'group'>('friend')
const castScope = ref<CastScope>('selected')
const castMsg = ref('')
const castInterval = ref(1000)
const castStarting = ref(false)
/** 起任务后切到进度视图，同一个 Modal 里换内容 */
const castTask = ref<BroadcastTask | null>(null)
const castCanceling = ref(false)
let castTimer: ReturnType<typeof setTimeout> | null = null

const castState = computed(() => (castType.value === 'group' ? group : friend))
const castNoun = computed(() => (castType.value === 'group' ? '群' : '好友'))

const castTitle = computed(() =>
  castType.value === 'group' ? '群发群消息' : '群发私聊消息',
)

/** 当前范围下要发给多少个目标 */
const castCount = computed(() => {
  const s = castState.value
  if (castScope.value === 'selected') return s.selected.length
  if (castScope.value === 'page') return s.records.length
  return s.total
})

/** 预计耗时，按间隔粗算，让人对「几百个要发多久」有数 */
const castEta = computed(() => {
  const ms = Math.max(0, castCount.value - 1) * castInterval.value
  if (ms < 1000) return '不到 1 秒'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `约 ${sec} 秒`
  return `约 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
})

function openCast(type: 'friend' | 'group') {
  castType.value = type
  // 有勾选就默认发给勾选的，没有则默认当前页
  castScope.value = castState.value.selected.length > 0 ? 'selected' : 'page'
  castMsg.value = ''
  castTask.value = null
  castOpen.value = true
}

/** 把一条记录转成发送目标 */
function toTarget(record: any): BroadcastTarget {
  return castType.value === 'group'
    ? { id: record.group_id, botId: record.bot_id, name: record.group_name || '' }
    : {
        id: record.user_id,
        botId: record.bot_id,
        name: record.remark || record.nickname || '',
      }
}

/**
 * 收集目标列表。
 *
 * 「全部」得把所有分页拉回来 —— 列表接口是内存分页，一次性要完整数据
 * 只需把 pageSize 开大，不会真去打协议端。
 */
async function collectTargets(): Promise<BroadcastTarget[]> {
  const s = castState.value
  const isGroup = castType.value === 'group'
  if (castScope.value === 'page') {
    return s.records.map(toTarget)
  }
  if (castScope.value === 'selected') {
    const idKey = isGroup ? 'group_id' : 'user_id'
    const picked = new Set(s.selected.map(String))
    // 勾选可能跨页，当前页里找不到的要从全量里捞
    const inPage = s.records.filter((r: any) => picked.has(String(r[idKey])))
    if (inPage.length === s.selected.length) return inPage.map(toTarget)
    const all = await fetchAll()
    return all.filter((r: any) => picked.has(String(r[idKey]))).map(toTarget)
  }
  return (await fetchAll()).map(toTarget)
}

/** 拉全量列表，沿用当前搜索条件 */
async function fetchAll(): Promise<any[]> {
  const s = castState.value
  const isGroup = castType.value === 'group'
  const params: Record<string, any> = { pageNo: 1, pageSize: Math.max(s.total, 1) }
  const kw = s.keyword.trim()
  if (kw) {
    if (/^\d+$/.test(kw)) params[isGroup ? 'query_group_id' : 'query_qq'] = kw
    else params.query_name = kw
  }
  const page = isGroup ? await apiQueryGroupList(params) : await apiQueryFriendList(params)
  return page?.records ?? []
}

async function startCast() {
  const msg = castMsg.value.trim()
  if (!msg) {
    message.warning('消息内容不能为空')
    return
  }
  castStarting.value = true
  try {
    const targets = await collectTargets()
    if (targets.length === 0) {
      message.warning(`没有可发送的${castNoun.value}`)
      return
    }
    castTask.value = await apiStartBroadcast({
      type: castType.value,
      targets,
      msg,
      interval: castInterval.value,
    })
    pollCast()
  } finally {
    castStarting.value = false
  }
}

/** 轮询进度，任务结束就停 */
function pollCast() {
  stopPoll()
  const task = castTask.value
  if (!task || task.status !== 'running') return
  castTimer = setTimeout(async () => {
    try {
      castTask.value = await apiGetBroadcast(task.id)
    } catch {
      // 任务过期或服务重启，停止轮询，界面保留最后一次进度
      return
    }
    pollCast()
  }, 1000)
}

function stopPoll() {
  if (castTimer) {
    clearTimeout(castTimer)
    castTimer = null
  }
}

async function cancelCast() {
  const task = castTask.value
  if (!task) return
  castCanceling.value = true
  try {
    castTask.value = await apiCancelBroadcast(task.id)
    pollCast()
  } finally {
    castCanceling.value = false
  }
}

/** 关闭弹窗。任务在后台继续跑，不受关窗影响 */
function closeCast() {
  stopPoll()
  castOpen.value = false
  castTask.value = null
}

const castPercent = computed(() => {
  const t = castTask.value
  if (!t || !t.total) return 0
  return Math.round(((t.sent + t.failed) / t.total) * 100)
})

const castStatusText = computed(() => {
  const t = castTask.value
  if (!t) return ''
  if (t.status === 'running') return '发送中…'
  if (t.status === 'canceled') return '已停止'
  return t.failed > 0 ? '已完成（部分失败）' : '已完成'
})

onBeforeUnmount(stopPoll)

/* ---------------- 删除好友 / 退出群聊 ---------------- */

interface DangerTarget {
  type: 'friend' | 'group'
  id: number | string
  name: string
  avatar: string
  botId?: number | string
  /** 群主才能解散群，普通成员只能退群 */
  canDismiss: boolean
}

const dangerOpen = ref(false)
const dangerBusy = ref(false)
const dangerAgree = ref(false)
const dangerDismiss = ref(false)
const dangerTarget = ref<DangerTarget | null>(null)

const dangerTitle = computed(() => {
  if (dangerTarget.value?.type !== 'group') return '删除好友'
  return dangerDismiss.value ? '解散群聊' : '退出群聊'
})

/** 确认框里要用户逐字确认的动作名 */
const dangerVerb = computed(() => {
  if (dangerTarget.value?.type !== 'group') return '删除该好友'
  return dangerDismiss.value ? '解散该群' : '退出该群'
})

function openDanger(type: 'friend' | 'group', record: any) {
  dangerTarget.value =
    type === 'group'
      ? {
          type,
          id: record.group_id,
          name: record.group_name || '未知群名',
          avatar: groupAvatar(record.group_id),
          botId: record.bot_id,
          canDismiss: record.role === 'owner',
        }
      : {
          type,
          id: record.user_id,
          name: record.remark || record.nickname || '未知昵称',
          avatar: userAvatar(record.user_id),
          botId: record.bot_id,
          canDismiss: false,
        }
  dangerAgree.value = false
  dangerDismiss.value = false
  dangerOpen.value = true
}

async function confirmDanger() {
  const target = dangerTarget.value
  if (!target) return
  if (!dangerAgree.value) {
    message.warning('请先勾选确认')
    return
  }
  dangerBusy.value = true
  try {
    if (target.type === 'group') {
      await apiQuitGroup({
        groupId: target.id,
        isDismiss: dangerDismiss.value,
        botId: target.botId,
      })
      dangerOpen.value = false
      // 列表由 Bot 侧异步更新，稍等再拉才能看到少了这一条
      setTimeout(loadGroups, 800)
    } else {
      await apiDeleteFriend({ userId: target.id, botId: target.botId })
      dangerOpen.value = false
      setTimeout(loadFriends, 800)
    }
  } finally {
    dangerBusy.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(String(text))
    message.success('已复制')
  } catch {
    message.warning('复制失败，请手动选中复制')
  }
}

function roleText(role?: string) {
  if (role === 'owner') return { text: '群主', color: 'gold' }
  if (role === 'admin') return { text: '管理员', color: 'blue' }
  return { text: '成员', color: 'default' }
}

onMounted(() => {
  loadFriends()
  loadGroups()
})
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">账号管理</h2>
      <p class="g-page-desc">查看当前 Bot 的好友与群聊列表。</p>
    </div>

    <Card :bordered="false">
      <Tabs v-model:activeKey="activeTab">
        <TabPane key="friend" :tab="`好友（${friend.total}）`">
          <div class="g-acc-bar">
            <Input
              v-model:value="friend.keyword"
              placeholder="搜索 QQ 号、昵称或备注"
              allowClear
              class="g-acc-search"
              @pressEnter="searchFriends"
              @update:value="(v: string) => !v && searchFriends()"
            >
              <template #prefix>
                <GIcon icon="ant-design:search-outlined" :size="14" />
              </template>
            </Input>
            <Button type="primary" @click="searchFriends">搜索</Button>
            <Button :loading="friend.loading" @click="loadFriends">
              <GIcon icon="ant-design:reload-outlined" :size="13" />
            </Button>
            <div class="g-acc-bar-right">
              <span v-if="friend.selected.length" class="g-acc-dim g-acc-picked">
                已选 {{ friend.selected.length }}
              </span>
              <Button @click="openCast('friend')">
                <GIcon icon="ant-design:notification-outlined" :size="13" />
                <span class="g-acc-btn-text">群发</span>
              </Button>
            </div>
          </div>

          <Table
            :columns="friendColumns"
            :data-source="friend.records"
            :row-key="(r: any) => r.user_id"
            :row-selection="{
              selectedRowKeys: friend.selected,
              onChange: (keys: (string | number)[]) => (friend.selected = keys),
              preserveSelectedRowKeys: true,
            }"
            :pagination="{
              current: friend.pageNo,
              pageSize: friend.pageSize,
              total: friend.total,
              showSizeChanger: true,
              showTotal: (t: number) => `共 ${t} 位好友`,
            }"
            size="middle"
            :scroll="{ x: 580 }"
            @change="onFriendTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'user'">
                <div class="g-acc-cell">
                  <Avatar :src="userAvatar(record.user_id)" :size="34">
                    {{ String(record.nickname ?? '?').slice(0, 1) }}
                  </Avatar>
                  <span class="g-acc-name">{{ record.nickname || '未知昵称' }}</span>
                </div>
              </template>

              <template v-else-if="column.key === 'user_id'">
                <div class="g-acc-id">
                  <Tooltip title="点击发私聊消息">
                    <span class="g-acc-link" @click="openSend('friend', record)">
                      {{ record.user_id }}
                    </span>
                  </Tooltip>
                  <Tooltip title="复制">
                    <span class="g-acc-copy" @click="copy(record.user_id)">
                      <GIcon icon="ant-design:copy-outlined" :size="13" />
                    </span>
                  </Tooltip>
                </div>
              </template>

              <template v-else-if="column.key === 'remark'">
                <span class="g-acc-dim">{{ record.remark || '—' }}</span>
              </template>

              <template v-else-if="column.key === 'action'">
                <Button type="link" danger size="small" @click="openDanger('friend', record)">
                  删除
                </Button>
              </template>
            </template>
          </Table>
        </TabPane>

        <TabPane key="group" :tab="`群聊（${group.total}）`">
          <div class="g-acc-bar">
            <Input
              v-model:value="group.keyword"
              placeholder="搜索群号或群名称"
              allowClear
              class="g-acc-search"
              @pressEnter="searchGroups"
              @update:value="(v: string) => !v && searchGroups()"
            >
              <template #prefix>
                <GIcon icon="ant-design:search-outlined" :size="14" />
              </template>
            </Input>
            <Button type="primary" @click="searchGroups">搜索</Button>
            <Button :loading="group.loading" @click="loadGroups">
              <GIcon icon="ant-design:reload-outlined" :size="13" />
            </Button>
            <div class="g-acc-bar-right">
              <span v-if="group.selected.length" class="g-acc-dim g-acc-picked">
                已选 {{ group.selected.length }}
              </span>
              <Button @click="openCast('group')">
                <GIcon icon="ant-design:notification-outlined" :size="13" />
                <span class="g-acc-btn-text">群发</span>
              </Button>
            </div>
          </div>

          <Table
            :columns="groupColumns"
            :data-source="group.records"
            :row-key="(r: any) => r.group_id"
            :row-selection="{
              selectedRowKeys: group.selected,
              onChange: (keys: (string | number)[]) => (group.selected = keys),
              preserveSelectedRowKeys: true,
            }"
            :pagination="{
              current: group.pageNo,
              pageSize: group.pageSize,
              total: group.total,
              showSizeChanger: true,
              showTotal: (t: number) => `共 ${t} 个群`,
            }"
            size="middle"
            :scroll="{ x: 700 }"
            @change="onGroupTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'group'">
                <div class="g-acc-cell">
                  <Avatar :src="groupAvatar(record.group_id)" :size="34" shape="square">
                    {{ String(record.group_name ?? '?').slice(0, 1) }}
                  </Avatar>
                  <span class="g-acc-name">{{ record.group_name || '未知群名' }}</span>
                </div>
              </template>

              <template v-else-if="column.key === 'group_id'">
                <div class="g-acc-id">
                  <Tooltip title="点击发群消息">
                    <span class="g-acc-link" @click="openSend('group', record)">
                      {{ record.group_id }}
                    </span>
                  </Tooltip>
                  <Tooltip title="复制">
                    <span class="g-acc-copy" @click="copy(record.group_id)">
                      <GIcon icon="ant-design:copy-outlined" :size="13" />
                    </span>
                  </Tooltip>
                </div>
              </template>

              <template v-else-if="column.key === 'member'">
                <span class="g-acc-dim">
                  {{ record.member_count ?? '—' }}
                  <template v-if="record.max_member_count">/ {{ record.max_member_count }}</template>
                </span>
              </template>

              <template v-else-if="column.key === 'role'">
                <Tag :color="roleText(record.role).color">{{ roleText(record.role).text }}</Tag>
              </template>

              <template v-else-if="column.key === 'action'">
                <Button type="link" danger size="small" @click="openDanger('group', record)">
                  退群
                </Button>
              </template>
            </template>
          </Table>
        </TabPane>
      </Tabs>
    </Card>

    <Modal
      v-model:open="sendOpen"
      :title="sendTitle"
      ok-text="发送"
      cancel-text="取消"
      :confirm-loading="sending"
      @ok="confirmSend"
    >
      <div v-if="sendTarget" class="g-send-target">
        <Avatar
          :src="sendTarget.avatar"
          :size="38"
          :shape="sendTarget.type === 'group' ? 'square' : 'circle'"
        >
          {{ sendTarget.name.slice(0, 1) }}
        </Avatar>
        <div class="g-send-meta">
          <div class="g-send-name">{{ sendTarget.name }}</div>
          <div class="g-acc-dim">
            {{ sendTarget.type === 'group' ? '群号' : 'QQ' }} {{ sendTarget.id }}
            <template v-if="sendTarget.botId">· 由 {{ sendTarget.botId }} 发出</template>
          </div>
        </div>
      </div>

      <Textarea
        v-model:value="sendMsgText"
        placeholder="输入要发送的内容，Ctrl + Enter 发送"
        :rows="4"
        :maxlength="1000"
        show-count
        class="g-send-input"
        @keydown.ctrl.enter="confirmSend"
      />
      <p class="g-send-tip">消息以 Bot 身份直接发出，仅支持纯文本。</p>
    </Modal>

    <Modal
      v-model:open="castOpen"
      :title="castTitle"
      :width="520"
      :mask-closable="false"
      @cancel="closeCast"
    >
      <!-- 起任务前：填内容、选范围 -->
      <template v-if="!castTask">
        <div class="g-cast-row">
          <span class="g-cast-label">发送给</span>
          <RadioGroup v-model:value="castScope" button-style="solid" size="small">
            <RadioButton value="selected" :disabled="castState.selected.length === 0">
              已勾选（{{ castState.selected.length }}）
            </RadioButton>
            <RadioButton value="page">当前页（{{ castState.records.length }}）</RadioButton>
            <RadioButton value="all">全部（{{ castState.total }}）</RadioButton>
          </RadioGroup>
        </div>

        <div class="g-cast-row">
          <span class="g-cast-label">发送间隔</span>
          <InputNumber
            v-model:value="castInterval"
            :min="200"
            :max="60000"
            :step="200"
            addon-after="毫秒"
            size="small"
            class="g-cast-interval"
          />
          <span class="g-acc-dim">预计 {{ castEta }}</span>
        </div>

        <Textarea
          v-model:value="castMsg"
          placeholder="输入要群发的内容"
          :rows="4"
          :maxlength="1000"
          show-count
          class="g-send-input"
        />

        <Alert
          type="warning"
          show-icon
          class="g-cast-alert"
          :message="`将向 ${castCount} 个${castNoun}逐个发送，间隔过短可能触发风控。`"
        />
      </template>

      <!-- 起任务后：进度 -->
      <template v-else>
        <div class="g-cast-progress">
          <Progress
            type="circle"
            :percent="castPercent"
            :status="castTask.status === 'running' ? 'active' : castTask.failed ? 'exception' : 'success'"
            :size="88"
          />
          <div class="g-cast-nums">
            <div class="g-send-name">{{ castStatusText }}</div>
            <div class="g-acc-dim">
              成功 {{ castTask.sent }} · 失败 {{ castTask.failed }} · 共 {{ castTask.total }}
            </div>
            <div class="g-acc-dim">
              发送间隔 {{ castTask.interval }} 毫秒
            </div>
          </div>
        </div>

        <div v-if="castTask.errors.length" class="g-cast-errors">
          <div class="g-cast-errors-head">失败明细</div>
          <div v-for="e in castTask.errors" :key="e.id" class="g-cast-error">
            <span>{{ e.name || e.id }}</span>
            <span class="g-acc-dim">{{ e.error }}</span>
          </div>
        </div>

        <p v-if="castTask.status === 'running'" class="g-send-tip">
          关掉弹窗不影响发送，任务在后台继续跑。
        </p>
      </template>

      <template #footer>
        <template v-if="!castTask">
          <Button @click="closeCast">取消</Button>
          <Button
            type="primary"
            :loading="castStarting"
            :disabled="castCount === 0"
            @click="startCast"
          >
            开始群发（{{ castCount }}）
          </Button>
        </template>
        <template v-else>
          <Button
            v-if="castTask.status === 'running'"
            danger
            :loading="castCanceling"
            @click="cancelCast"
          >
            停止
          </Button>
          <Button type="primary" @click="closeCast">关闭</Button>
        </template>
      </template>
    </Modal>

    <Modal
      v-model:open="dangerOpen"
      :title="dangerTitle"
      ok-text="确认执行"
      cancel-text="取消"
      :ok-button-props="{ danger: true, disabled: !dangerAgree }"
      :confirm-loading="dangerBusy"
      @ok="confirmDanger"
    >
      <div v-if="dangerTarget" class="g-send-target">
        <Avatar
          :src="dangerTarget.avatar"
          :size="38"
          :shape="dangerTarget.type === 'group' ? 'square' : 'circle'"
        >
          {{ dangerTarget.name.slice(0, 1) }}
        </Avatar>
        <div class="g-send-meta">
          <div class="g-send-name">{{ dangerTarget.name }}</div>
          <div class="g-acc-dim">
            {{ dangerTarget.type === 'group' ? '群号' : 'QQ' }} {{ dangerTarget.id }}
            <template v-if="dangerTarget.botId">· 账号 {{ dangerTarget.botId }}</template>
          </div>
        </div>
      </div>

      <Alert
        type="warning"
        show-icon
        :message="`此操作不可撤销，${dangerTarget?.type === 'group' ? '之后需重新被邀请或申请入群' : '之后需对方重新添加'}。`"
      />

      <!-- 群主退群在多数协议端等同解散，索性显式让用户选，避免以为只是退出 -->
      <Checkbox v-if="dangerTarget?.canDismiss" v-model:checked="dangerDismiss" class="g-danger-opt">
        解散该群（而不是仅自己退出）
      </Checkbox>

      <Checkbox v-model:checked="dangerAgree" class="g-danger-opt">
        我确认要{{ dangerVerb }}
      </Checkbox>
    </Modal>
  </div>
</template>

<style scoped>
.g-page-head {
  margin-bottom: 14px;
}

.g-acc-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

/* 群发靠右，跟左边的搜索区分开 */
.g-acc-bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.g-acc-picked {
  font-size: 12px;
}

.g-acc-btn-text {
  margin-left: 6px;
}

.g-cast-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 13px;
}

.g-cast-label {
  flex: none;
  width: 56px;
  color: var(--g-text-sub);
}

.g-cast-interval {
  width: 150px;
}

.g-cast-alert {
  margin-top: 12px;
}

.g-cast-progress {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 6px 0 2px;
}

.g-cast-nums {
  min-width: 0;
  font-size: 12px;
  line-height: 1.8;
}

.g-cast-errors {
  margin-top: 14px;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--g-border);
  border-radius: 8px;
}

.g-cast-errors-head {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--g-text-sub);
  border-bottom: 1px solid var(--g-border);
}

.g-cast-error {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  font-size: 12px;
}

.g-cast-error > span:first-child {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-cast-error > span:last-child {
  text-align: right;
  word-break: break-all;
}

.g-acc-search {
  max-width: 280px;
}

.g-acc-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.g-acc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-acc-id {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 号码本身是发消息入口，复制退居为旁边的小图标 */
.g-acc-link {
  cursor: pointer;
  color: var(--g-brand);
  border-bottom: 1px dashed currentColor;
}

.g-acc-link:hover {
  border-bottom-style: solid;
}

.g-acc-copy {
  display: inline-flex;
  cursor: pointer;
  color: var(--g-text-dim);
}

.g-acc-copy:hover {
  color: var(--g-brand);
}

.g-send-target {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.g-send-meta {
  min-width: 0;
  font-size: 12px;
}

.g-send-name {
  margin-bottom: 2px;
  font-size: 14px;
  font-weight: 500;
  color: var(--g-text);
}

.g-send-input {
  resize: none;
}

.g-send-tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-danger-opt {
  display: block;
  margin-top: 14px;
}

.g-acc-dim {
  color: var(--g-text-dim);
}
</style>
