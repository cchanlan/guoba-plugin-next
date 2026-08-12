<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, Button, Input, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiGetLoginStatus, apiRequestLoginCaptcha, apiRequestLoginCode } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { GUOBA_VERSION, ICP_NO } from '@/utils/env'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const captcha = ref('')
const loginToken = ref('')
const configured = ref(true)
const captchaRequired = ref(false)
const loading = ref(false)
const requesting = ref(false)
const tokenLoading = ref(false)
const tokenRequesting = ref(false)

async function loadStatus() {
  try {
    const status = await apiGetLoginStatus()
    configured.value = status.configured
    captchaRequired.value = status.captchaRequired
  } catch {
    message.error('无法获取登录状态，请确认锅巴服务已启动')
  }
}

async function requestCaptcha() {
  requesting.value = true
  try {
    const result = await apiRequestLoginCaptcha()
    message.success(result.pushed ? '验证码已私聊发送给主人' : '发送私聊失败，请查看 Yunzai 控制台')
  } catch (error: any) {
    message.error(error?.message || '验证码发送失败')
  } finally {
    requesting.value = false
  }
}

async function submit() {
  if (!username.value.trim() || !password.value) {
    message.warning('请输入用户名和密码')
    return
  }
  if (captchaRequired.value && !captcha.value.trim()) {
    message.warning('新 IP 首次登录需要验证码')
    return
  }
  loading.value = true
  try {
    await auth.loginByPassword(username.value.trim(), password.value, captcha.value.trim() || undefined)
    await auth.loadUserInfo()
    message.success('登录成功')
    const redirect = route.query.redirect as string | undefined
    router.replace(redirect || '/home')
  } catch (error: any) {
    if (error?.status === 428 || error?.code === 428) captchaRequired.value = true
    message.error(error?.message || '登录失败')
  } finally {
    loading.value = false
  }
}

async function requestToken() {
  tokenRequesting.value = true
  try {
    const result = await apiRequestLoginCode()
    message.success(result.pushed ? '登录令牌已私聊发送给主人' : '发送私聊失败，请查看 Yunzai 控制台')
  } catch (error: any) {
    message.error(error?.message || '令牌发送失败')
  } finally {
    tokenRequesting.value = false
  }
}

async function submitToken() {
  const code = loginToken.value.trim()
  if (!code) {
    message.warning('请输入登录令牌')
    return
  }
  tokenLoading.value = true
  try {
    // 令牌有两种来源：页面按钮请求的初始化验证码，以及 #锅巴登录 下发的快捷令牌
    try {
      await auth.loginByConsoleCode(code)
    } catch {
      await auth.loginByCode(code)
    }
    await auth.loadUserInfo()
    message.success('登录成功，请先设置账号密码')
    // 初始化登录后直接进登录安全页，引导先把账号密码设置好
    router.replace('/account/security')
  } catch (error: any) {
    message.error(error?.message || '令牌错误或已失效')
  } finally {
    tokenLoading.value = false
  }
}

onMounted(loadStatus)
</script>

<template>
  <main class="g-login">
    <div class="g-login-bg" />
    <section class="g-login-card">
      <header class="g-login-head">
        <img src="/logo.png" alt="Guoba" class="g-login-logo" />
        <h1>锅巴 Web 控制台</h1>
        <p>安全登录认证 · v{{ GUOBA_VERSION }}</p>
      </header>

      <Alert
        v-if="!configured"
        type="warning"
        show-icon
        class="g-login-alert"
        message="尚未设置登录账号"
        description="点击「获取令牌」，机器人会把登录令牌私聊发给主人，输入令牌进入面板后请尽快设置用户名和密码。"
      />

      <form v-if="!configured" class="g-login-form" @submit.prevent="submitToken">
        <label>登录令牌</label>
        <div class="g-captcha-row">
          <Input
            v-model:value="loginToken"
            size="large"
            placeholder="请输入机器人发来的登录令牌"
            autocomplete="one-time-code"
            @pressEnter="submitToken"
          >
            <template #prefix><GIcon icon="ant-design:key-outlined" :size="16" /></template>
          </Input>
          <Button size="large" :loading="tokenRequesting" @click="requestToken">获取令牌</Button>
        </div>
        <Button type="primary" size="large" html-type="submit" block :loading="tokenLoading">
          令牌登录
        </Button>
      </form>

      <form v-else class="g-login-form" @submit.prevent="submit">
        <label>用户名</label>
        <Input v-model:value="username" size="large" placeholder="请输入用户名" autocomplete="username">
          <template #prefix><GIcon icon="ant-design:user-outlined" :size="16" /></template>
        </Input>

        <label>密码</label>
        <Input.Password
          v-model:value="password"
          size="large"
          placeholder="请输入密码"
          autocomplete="current-password"
          @pressEnter="submit"
        >
          <template #prefix><GIcon icon="ant-design:lock-outlined" :size="16" /></template>
        </Input.Password>

        <template v-if="captchaRequired">
          <label>验证码</label>
          <div class="g-captcha-row">
            <Input
              v-model:value="captcha"
              size="large"
              placeholder="请输入机器人私聊验证码"
              autocomplete="one-time-code"
              @pressEnter="submit"
            >
              <template #prefix><GIcon icon="ant-design:safety-outlined" :size="16" /></template>
            </Input>
            <Button size="large" :loading="requesting" @click="requestCaptcha">获取验证码</Button>
          </div>
          <p class="g-login-tip">每个新 IP 首次登录需验证，验证码会由机器人单独一行私聊给主人。</p>
        </template>

        <Button type="primary" size="large" html-type="submit" block :loading="loading" :disabled="!configured">
          登录
        </Button>
        <p class="g-login-tip">忘记密码？主人私聊机器人发送「#锅巴重置密码」即可清空凭证重新初始化。</p>
      </form>

      <footer>
        <span>锅巴面板</span>
        <span v-if="ICP_NO">{{ ICP_NO }}</span>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.g-login {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  overflow: auto;
  background: #f1f4f9;
}

.g-login-bg {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at 18% 20%, rgba(79, 119, 216, 0.13), transparent 35%),
    radial-gradient(circle at 82% 78%, rgba(83, 153, 218, 0.12), transparent 38%);
}

.g-login-card {
  position: relative;
  width: min(100%, 420px);
  padding: 34px 30px 24px;
  color: #283244;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(211, 219, 232, 0.8);
  border-radius: 18px;
  box-shadow: 0 20px 55px rgba(36, 54, 85, 0.16);
}

.g-login-head { text-align: center; margin-bottom: 24px; }
.g-login-logo { width: 46px; height: 46px; margin-bottom: 10px; }
.g-login-head h1 { margin: 0; font-size: 22px; font-weight: 650; color: #202938; }
.g-login-head p { margin: 6px 0 0; font-size: 12px; color: #98a1b2; }
.g-login-alert { margin-bottom: 18px; }
.g-login-form { display: flex; flex-direction: column; gap: 10px; }
.g-login-form label { margin-top: 2px; font-size: 13px; color: #566176; }
.g-captcha-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
.g-login-tip { margin: -2px 0 4px; font-size: 12px; line-height: 1.6; color: #8993a5; }
footer { display: flex; justify-content: center; gap: 12px; margin-top: 22px; font-size: 11px; color: #a4acb9; }

:deep(.ant-input-affix-wrapper), :deep(.ant-btn) { border-radius: 9px; }
:deep(.ant-btn-primary) { margin-top: 6px; background: #4f77d8; box-shadow: 0 7px 15px rgba(79, 119, 216, 0.25); }

@media (max-width: 480px) {
  .g-login { padding: 14px; }
  .g-login-card { padding: 28px 20px 20px; }
  .g-captcha-row { grid-template-columns: 1fr; }
}

:global([data-theme='dark']) .g-login { background: #0d1017; }
:global([data-theme='dark']) .g-login-card {
  color: var(--g-text);
  background: var(--g-bg-card);
  border-color: var(--g-border);
  box-shadow: var(--g-shadow);
}
:global([data-theme='dark']) .g-login-head h1 { color: var(--g-text); }
:global([data-theme='dark']) .g-login-form label { color: var(--g-text-sub); }
</style>
