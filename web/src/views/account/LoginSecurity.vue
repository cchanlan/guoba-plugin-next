<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { Button, Card, Empty, Form, FormItem, Input, Popconfirm, Table, Tooltip, message } from 'ant-design-vue'
import { apiClearTrustedIps, apiGetLoginSecurity, apiRevokeTrustedIp, apiSetLoginCredentials } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { LoginSecurity, TrustedIp } from '@/types'

const auth = useAuthStore()

const loading = ref(true)
const saving = ref(false)
const security = ref<LoginSecurity>({ configured: false, username: '', trustedIps: [] })
const form = reactive({ username: '', currentPassword: '', password: '', confirmPassword: '' })

async function load() {
  loading.value = true
  try {
    security.value = await apiGetLoginSecurity()
    form.username = security.value.username
  } finally {
    loading.value = false
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

onMounted(load)
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">登录安全</h2>
      <p class="g-page-desc">设置面板登录账号密码，并管理已通过验证码认证的可信 IP。</p>
    </div>

    <Card :bordered="false" :loading="loading" class="g-sec-cred">
      <template #title>登录凭证</template>
      <template #extra><Button size="small" @click="load">刷新</Button></template>

      <Form layout="vertical">
        <div class="g-sec-grid">
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

    <Card :bordered="false" class="g-sec-ips">
      <template #title>可信 IP</template>
      <template #extra>
        <Popconfirm title="确定清空全部可信 IP？" @confirm="clearAll">
          <Button danger size="small" :disabled="!security.trustedIps.length">全部清空</Button>
        </Popconfirm>
      </template>
      <p class="g-sec-tip">IP 通过验证码认证后自动加入，撤销后该 IP 下次登录将重新要求验证码。</p>

      <Table
        v-if="security.trustedIps.length"
        :columns="columns"
        :data-source="security.trustedIps"
        :pagination="false"
        row-key="ip"
        size="small"
        class="g-sec-table"
      >
        <template #bodyCell="{ column, record }: { column: any; record: TrustedIp }">
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

.g-sec-ips {
  margin-bottom: 16px;
}

.g-sec-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 18px;
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

  .g-sec-table {
    display: none;
  }

  .g-sec-cards {
    display: block;
  }
}
</style>
