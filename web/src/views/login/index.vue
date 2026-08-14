<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, Button, Input, Tooltip, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiGetLoginStatus, apiRequestLoginCaptcha, apiRequestLoginCode } from '@/api'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { GUOBA_VERSION, ICP_NO } from '@/utils/env'

const auth = useAuthStore()
const appStore = useAppStore()
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
    message.warning('这台设备首次登录需要验证码')
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
    await auth.loginByConsoleCode(code)
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
      <!-- 主题跟随全局（跟面板里那颗按钮共用一份状态），登录页也能就地切 -->
      <Tooltip :title="appStore.isDark ? '切换到浅色' : '切换到深色'" placement="left">
        <Button type="text" class="g-login-theme" @click="appStore.toggleTheme()">
          <GIcon
            :icon="appStore.isDark ? 'ant-design:sun-outlined' : 'ant-design:moon-outlined'"
            :size="17"
          />
        </Button>
      </Tooltip>
      <header class="g-login-head">
        <span class="g-login-badge">
          <img src="/logo.png" alt="Guoba" class="g-login-logo" />
        </span>
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
          <p class="g-login-tip">
            验证码由机器人单独一行私聊给主人。这台设备验证一次后会被记住 90 天，之后即使 IP
            变了（手机流量的 IPv6 常变）也不用再验。
          </p>
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
/* 登录页跟随全局主题：颜色全部取 styles/index.css 里 html[data-theme] 那套变量，
   antd 组件那边由 App.vue 的 ConfigProvider 统一负责，
   这样 message / Modal 这些浮层不会再出现「深色页面配浅色弹窗」 */
.g-login {
  /* 登录卡片是页面唯一主体，投影比普通卡片重一些，单独一个变量 */
  --g-login-shadow: 0 16px 42px rgba(15, 23, 42, 0.1);

  position: relative;
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  overflow: auto;
  color: var(--g-text);
  background: var(--g-bg);
}

html[data-theme='dark'] .g-login {
  --g-login-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}

/* 两团品牌色暖光，给纯色底铺一点层次 */
.g-login-bg {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at 16% 18%, rgba(209, 159, 86, 0.16), transparent 42%),
    radial-gradient(circle at 84% 82%, rgba(209, 159, 86, 0.1), transparent 45%);
}

.g-login-card {
  position: relative;
  width: min(100%, 400px);
  padding: 36px 32px 24px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 16px;
  box-shadow: var(--g-login-shadow);
}

/* 主题按钮浮在卡片右上角，不占表单的位置 */
.g-login-theme {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--g-text-sub);
}

.g-login-theme:hover {
  color: var(--g-brand);
  background: var(--g-brand-soft);
}

.g-login-head { margin-bottom: 26px; text-align: center; }

.g-login-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  margin-bottom: 14px;
  background: var(--g-brand-soft);
  border: 1px solid rgba(209, 159, 86, 0.28);
  border-radius: 16px;
}

.g-login-logo { width: 36px; height: 36px; }
.g-login-head h1 { margin: 0; font-size: 21px; font-weight: 600; color: var(--g-text); }
.g-login-head p { margin: 7px 0 0; font-size: 12px; color: var(--g-text-dim); }
.g-login-alert { margin-bottom: 20px; }
.g-login-form { display: flex; flex-direction: column; gap: 8px; }
.g-login-form label { margin-top: 4px; font-size: 13px; font-weight: 500; color: var(--g-text-sub); }
.g-captcha-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
.g-login-tip { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--g-text-dim); }

footer {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
  padding-top: 16px;
  font-size: 11px;
  color: var(--g-text-dim);
  border-top: 1px solid var(--g-border);
}

:deep(.ant-input-affix-wrapper), :deep(.ant-btn) { border-radius: 10px; }
:deep(.ant-alert) { border-radius: 12px; }
/* 聚焦时用品牌色描边替代默认的蓝调外发光 */
:deep(.ant-input-affix-wrapper-focused) { box-shadow: 0 0 0 3px var(--g-brand-soft); }

/* 主按钮颜色交给 ConfigProvider 的 colorPrimary，这里只补一层同色投影 */
:deep(.ant-btn-primary) {
  margin-top: 14px;
  font-weight: 500;
  box-shadow: 0 6px 16px rgba(209, 159, 86, 0.26);
}
:deep(.ant-btn-primary:hover) { box-shadow: 0 8px 20px rgba(209, 159, 86, 0.32); }

@media (max-width: 480px) {
  .g-login { padding: 14px; }
  .g-login-card { padding: 30px 22px 20px; }
  .g-captcha-row { grid-template-columns: 1fr; }
}
</style>
