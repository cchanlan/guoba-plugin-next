<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Button, Card, Empty, Form, FormItem, Input, Popconfirm, Table, Tag, Tooltip, message } from 'ant-design-vue'
import {
  apiClearTrustedDevices,
  apiClearTrustedIps,
  apiGetLoginSecurity,
  apiRevokeTrustedDevice,
  apiRevokeTrustedIp,
  apiSetLoginCredentials,
} from '@/api'
import { useAuthStore } from '@/stores/auth'
import {
  clearDeviceSecret,
  getDeviceId,
  getDeviceInfo,
  getFingerprint,
  saveDeviceCredential,
} from '@/utils/device'
import type { LoginSecurity, TrustedDevice } from '@/types'

const auth = useAuthStore()

const loading = ref(true)
/** 是否已完成过至少一次加载；用于区分首屏与刷新，避免刷新时拆掉布局 */
const hydrated = ref(false)
const saving = ref(false)
const security = ref<LoginSecurity>({ configured: false, username: '', trustedIps: [], trustedDevices: [] })
const form = reactive({ username: '', currentPassword: '', password: '', confirmPassword: '' })

const devices = computed<TrustedDevice[]>(() => security.value.trustedDevices ?? [])
/** 本机的设备 id，用来在列表里标出「本机」 */
const myDeviceId = getDeviceId()
/** 本机指纹摘要，只是给人看的，不参与任何校验 */
const myFingerprint = `${getDeviceInfo()} · ${getFingerprint()}`

async function load() {
  if (loading.value && hydrated.value) return
  loading.value = true
  try {
    const next = await apiGetLoginSecurity()
    security.value = next
    form.username = next.username
  } finally {
    loading.value = false
    hydrated.value = true
  }
}

async function save() {
  if (!form.username.trim()) {
    message.warning('请输入用户名')
    return
  }
  if (security.value.configured && !form.currentPassword) {
    message.warning('请输入当前密码')
    return
  }
  if (!form.password) {
    message.warning('请输入新密码')
    return
  }
  if (form.password.length < 8 || form.password.length > 128) {
    message.warning('新密码须为8至128位')
    return
  }
  if (form.password !== form.confirmPassword) {
    message.warning('两次输入的密码不一致')
    return
  }
  saving.value = true
  try {
    const res = await apiSetLoginCredentials({
      username: form.username.trim(),
      password: form.password,
      currentPassword: form.currentPassword || undefined,
    })
    security.value = { ...security.value, ...res }
    // 保存凭证的就是本人：后端顺手把这台机器记成可信设备，凭证存下来
    saveDeviceCredential(res.device)
    // 同步全局状态并刷新可信IP列表（保存后当前IP会被自动信任）
    auth.configured = true
    form.username = security.value.username
    form.currentPassword = ''
    form.password = ''
    form.confirmPassword = ''
    message.success('登录凭证已保存')
    await load()
  } catch (error: any) {
    message.error(error?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function revoke(ip: string) {
  security.value = await apiRevokeTrustedIp(ip)
  message.success('已撤销该 IP')
}

async function clearAll() {
  security.value = await apiClearTrustedIps()
  message.success('已清空可信 IP')
}

async function revokeDevice(id: string) {
  security.value = await apiRevokeTrustedDevice(id)
  // 撤销的是本机，本地那份 secret 也没用了，清掉免得下次白发一遍
  if (id === myDeviceId) clearDeviceSecret()
  message.success('已撤销该设备')
}

async function clearDevices() {
  security.value = await apiClearTrustedDevices()
  clearDeviceSecret()
  message.success('已清空可信设备')
}

/** 时间戳转「几天前」这种好读的说法，没有就返回 — */
function timeAgo(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 将 ::ffff:x.x.x.x 格式的 IPv4-mapped IPv6 展示为 IPv4 */
function displayIp(ip: string): string {
  const m = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  return m ? m[1] : ip
}

/** 截断过长的设备信息用于展示，完整内容放 Tooltip */
function shortDevice(device?: string): string {
  if (!device) return ''
  return device.length > 60 ? device.slice(0, 57) + '…' : device
}

const columns = [
  { title: '可信 IP', key: 'ip', width: 180 },
  { title: '设备信息', key: 'device' },
  { title: '操作', key: 'action', width: 80, align: 'center' as const },
]

const deviceColumns = [
  { title: '设备', key: 'name' },
  { title: '指纹', key: 'fp', width: 110 },
  { title: '最近使用', key: 'lastAt', width: 120 },
  { title: '最近 IP', key: 'ip', width: 180 },
  { title: '操作', key: 'action', width: 80, align: 'center' as const },
]

onMounted(load)
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">登录安全</h2>
      <p class="g-page-desc">设置面板登录账号密码，并管理已认证的可信设备与可信 IP。</p>
    </div>

    <Card :bordered="false" class="g-sec-cred">
      <template #title>登录凭证</template>
      <template #extra>
        <Button size="small" :loading="loading" @click="load">刷新</Button>
      </template>

      <!-- 刷新只转按钮，不盖 Spin，避免四个圆点闪烁 -->
      <Form layout="vertical" class="g-sec-form">
        <div class="g-sec-grid" :class="{ 'is-configured': security.configured }">
          <FormItem label="用户名" required>
            <Input v-model:value="form.username" autocomplete="username" />
          </FormItem>
          <FormItem v-if="security.configured" label="当前密码" required>
            <Input.Password v-model:value="form.currentPassword" autocomplete="current-password" />
          </FormItem>
          <FormItem label="新密码" required>
            <Input.Password
              v-model:value="form.password"
              placeholder="8 位或以上"
              autocomplete="new-password"
            />
          </FormItem>
          <FormItem label="确认新密码" required>
            <Input.Password v-model:value="form.confirmPassword" autocomplete="new-password" />
          </FormItem>
        </div>
        <Button type="primary" :loading="saving" @click="save">保存登录凭证</Button>
      </Form>
    </Card>

    <Card :bordered="false" class="g-sec-devs">
      <template #title>可信设备</template>
      <template #extra>
        <Popconfirm title="确定清空全部可信设备？" @confirm="clearDevices">
          <Button danger size="small" :disabled="!devices.length || loading">全部清空</Button>
        </Popconfirm>
      </template>
      <p class="g-sec-tip">
        登录成功后浏览器里会存一份长期凭证（90 天有效，每次登录自动换新），认的是设备而不是 IP
        —— 手机流量的 IPv6 隔一会儿就换，有了它就不用反复输验证码。撤销后那台设备下次登录要重新验证。
      </p>
      <p class="g-sec-tip">
        本机：{{ myFingerprint }}
        <span class="g-sec-dim">（指纹只用来辨认是哪台，不参与登录校验，浏览器升级后会变）</span>
      </p>

      <Table
        v-if="devices.length"
        :columns="deviceColumns"
        :data-source="devices"
        :pagination="false"
        row-key="id"
        size="small"
        class="g-sec-table"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <span class="g-sec-device">{{ record.name || '未知设备' }}</span>
            <Tag v-if="record.id === myDeviceId" color="green" class="g-sec-tag">本机</Tag>
          </template>
          <template v-else-if="column.key === 'fp'">
            <Tooltip v-if="record.ua" :title="record.ua">
              <span class="g-sec-device g-sec-dim">{{ record.fp || '—' }}</span>
            </Tooltip>
            <span v-else class="g-sec-device g-sec-dim">{{ record.fp || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'lastAt'">
            <span class="g-sec-device g-sec-dim">{{ timeAgo(record.lastAt) }}</span>
          </template>
          <template v-else-if="column.key === 'ip'">
            <span class="g-sec-ip">{{ record.ip ? displayIp(record.ip) : '—' }}</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <Popconfirm title="确定撤销这台设备？" @confirm="revokeDevice(record.id)">
              <Button type="link" danger size="small">撤销</Button>
            </Popconfirm>
          </template>
        </template>
      </Table>

      <!-- 窄屏改为堆叠卡片 -->
      <ul v-if="devices.length" class="g-sec-cards">
        <li v-for="item in devices" :key="item.id" class="g-sec-card">
          <div class="g-sec-card-main">
            <span class="g-sec-ip">
              {{ item.name || '未知设备' }}
              <Tag v-if="item.id === myDeviceId" color="green" class="g-sec-tag">本机</Tag>
            </span>
            <span class="g-sec-device g-sec-dim">
              {{ timeAgo(item.lastAt) }} · {{ item.ip ? displayIp(item.ip) : '未记录 IP' }}
            </span>
          </div>
          <Popconfirm title="确定撤销这台设备？" @confirm="revokeDevice(item.id)">
            <Button type="link" danger size="small">撤销</Button>
          </Popconfirm>
        </li>
      </ul>

      <Empty v-if="!devices.length" description="暂无可信设备" />
    </Card>

    <Card :bordered="false" class="g-sec-ips">
      <template #title>可信 IP</template>
      <template #extra>
        <Popconfirm title="确定清空全部可信 IP？" @confirm="clearAll">
          <Button danger size="small" :disabled="!security.trustedIps.length || loading">全部清空</Button>
        </Popconfirm>
      </template>
      <p class="g-sec-tip">IP 通过验证码认证后自动加入，撤销后该 IP 下次登录将重新要求验证码（设备凭证有效时优先按设备放行）。</p>

      <Table
        v-if="security.trustedIps.length"
        :columns="columns"
        :data-source="security.trustedIps"
        :pagination="false"
        row-key="ip"
        size="small"
        class="g-sec-table"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ip'">
            <span class="g-sec-ip">{{ displayIp(record.ip) }}</span>
          </template>
          <template v-else-if="column.key === 'device'">
            <Tooltip v-if="record.device && record.device.length > 60" :title="record.device">
              <span class="g-sec-device">{{ shortDevice(record.device) }}</span>
            </Tooltip>
            <span v-else class="g-sec-device g-sec-dim">{{ record.device || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <Popconfirm title="确定撤销这个 IP？" @confirm="revoke(record.ip)">
              <Button type="link" danger size="small">撤销</Button>
            </Popconfirm>
          </template>
        </template>
      </Table>

      <!-- 窄屏改为堆叠卡片，避免表格列被挤压 -->
      <ul v-if="security.trustedIps.length" class="g-sec-cards">
        <li v-for="item in security.trustedIps" :key="item.ip" class="g-sec-card">
          <div class="g-sec-card-main">
            <span class="g-sec-ip">{{ displayIp(item.ip) }}</span>
            <span class="g-sec-device g-sec-dim">{{ item.device || '未记录设备信息' }}</span>
          </div>
          <Popconfirm title="确定撤销这个 IP？" @confirm="revoke(item.ip)">
            <Button type="link" danger size="small">撤销</Button>
          </Popconfirm>
        </li>
      </ul>

      <Empty v-if="!security.trustedIps.length" description="暂无可信 IP" />
    </Card>
  </div>
</template>

<style scoped>
.g-page-head {
  margin-bottom: 14px;
}

.g-sec-cred {
  margin-bottom: 16px;
}

.g-sec-devs {
  margin-bottom: 16px;
}

.g-sec-ips {
  margin-bottom: 16px;
}

.g-sec-tag {
  margin-left: 6px;
  transform: scale(0.9);
}

.g-sec-form {
  /* 固定最小高度，刷新时 Spin 不塌陷导致页面横向回弹 */
  min-height: 168px;
}

.g-sec-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 18px;
}

/* 已配置时固定字段落位，避免「当前密码」显隐引起左右跳 */
.g-sec-grid.is-configured > :nth-child(1) {
  grid-column: 1;
  grid-row: 1;
}

.g-sec-grid.is-configured > :nth-child(2) {
  grid-column: 2;
  grid-row: 1;
}

.g-sec-grid.is-configured > :nth-child(3) {
  grid-column: 1;
  grid-row: 2;
}

.g-sec-grid.is-configured > :nth-child(4) {
  grid-column: 2;
  grid-row: 2;
}

.g-sec-tip {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-sec-ip {
  font-variant-numeric: tabular-nums;
}

.g-sec-device {
  font-size: 12px;
  word-break: break-all;
}

.g-sec-dim {
  color: var(--g-text-dim);
}

/* 宽屏用表格，窄屏用堆叠卡片 */
.g-sec-cards {
  display: none;
  margin: 0;
  padding: 0;
  list-style: none;
}

.g-sec-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--g-border);
}

.g-sec-card:last-child {
  border-bottom: none;
}

.g-sec-card-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.g-sec-card .g-sec-ip {
  font-size: 13px;
  word-break: break-all;
}

@media (max-width: 700px) {
  .g-sec-grid {
    grid-template-columns: 1fr;
  }

  .g-sec-grid.is-configured > :nth-child(n) {
    grid-column: 1;
    grid-row: auto;
  }

  .g-sec-table {
    display: none;
  }

  .g-sec-cards {
    display: block;
  }
}
</style>
