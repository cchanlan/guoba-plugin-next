<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, Button, Input, Spin, Tabs, TabPane, Typography, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiCreateConfirmRequest, apiPollConfirmRequest, apiRequestLoginCode } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { GUOBA_VERSION, ICP_NO } from '@/utils/env'

/**
 * 登录页。
 *
 * 后端不支持账号密码登录（LoginController.login 直接返回错误），
 * 只有三条路：
 *  1. 群里/私聊发送 `#锅巴登录`，Bot 回复带 code 的免密地址；
 *  2. 请求后端在控制台打印验证码，再把验证码填进来；
 *  3. 页面发起待确认请求，主人发 `#锅巴确认登录` 后本页自动进入面板。
 */
const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const activeTab = ref('code')

const codeInput = ref('')
const codeLoading = ref(false)
const requesting = ref(false)
const requested = ref(false)

async function requestCode() {
  requesting.value = true
  try {
    const res = await apiRequestLoginCode()
    requested.value = true
    // 后端会同时私聊主人，pushed 为收到的主人数量
    if (res?.pushed) {
      message.success('验证码已私聊发送给主人，也可在 Yunzai 控制台查看')
    } else {
      message.success('已请求验证码，请查看 Yunzai 控制台输出')
    }
  } catch {
    // 请求层已提示（例如上一个验证码还没失效）
  } finally {
    requesting.value = false
  }
}

function redirectAfterLogin() {
  const redirect = route.query.redirect as string | undefined
  router.replace(redirect || '/home')
}

/* ---------------- 聊天确认登录 ---------------- */

const confirmCode = ref('')
const confirmLeft = ref(0)
const confirmWaiting = ref(false)
const confirmStarting = ref(false)
let pollTimer: number | undefined
let countdownTimer: number | undefined

function stopConfirm() {
  window.clearInterval(pollTimer)
  window.clearInterval(countdownTimer)
  pollTimer = undefined
  countdownTimer = undefined
  confirmWaiting.value = false
}

onUnmounted(stopConfirm)

async function startConfirm() {
  stopConfirm()
  confirmStarting.value = true
  let id: string
  try {
    const res = await apiCreateConfirmRequest()
    id = res.id
    confirmCode.value = res.code
    confirmLeft.value = res.expire
  } catch {
    // 请求层已提示
    return
  } finally {
    confirmStarting.value = false
  }

  confirmWaiting.value = true

  countdownTimer = window.setInterval(() => {
    confirmLeft.value--
    if (confirmLeft.value <= 0) {
      stopConfirm()
      message.warning('登录请求已过期，请重新发起')
    }
  }, 1000)

  pollTimer = window.setInterval(async () => {
    try {
      const res = await apiPollConfirmRequest(id)
      if (res.status !== 'approved') return
      stopConfirm()
      auth.loginByConfirmToken(res.token)
      await auth.loadUserInfo()
      message.success('登录成功')
      redirectAfterLogin()
    } catch {
      // 过期或已被取用，交给倒计时收尾
      stopConfirm()
      message.warning('登录请求已失效，请重新发起')
    }
  }, 2000)
}

async function submitCode() {
  const code = codeInput.value.trim()
  if (!code) {
    message.warning('请输入控制台打印的验证码')
    return
  }
  codeLoading.value = true
  try {
    await auth.loginByConsoleCode(code)
    await auth.loadUserInfo()
    message.success('登录成功')
    redirectAfterLogin()
  } catch (e: any) {
    message.error(e?.message || '验证码错误或已失效')
  } finally {
    codeLoading.value = false
  }
}
</script>

<template>
  <div class="g-login">
    <div class="g-login-bg" />

    <div class="g-login-card">
      <div class="g-login-head">
        <img src="/logo.png" alt="Guoba" class="g-login-logo" />
        <div>
          <h1 class="g-login-title">锅巴面板</h1>
          <p class="g-login-sub">Yunzai 后台管理 · v{{ GUOBA_VERSION }}</p>
        </div>
      </div>

      <Tabs v-model:activeKey="activeTab" centered>
        <TabPane key="code" tab="验证码登录">
          <Alert
            type="info"
            show-icon
            class="g-login-alert"
            message="点击下方按钮后，Bot 会把验证码私聊发给主人"
            description="同时也会打印在 Yunzai 控制台（需日志等级 info 或以上）。验证码 5 分钟内有效。"
          />

          <Button
            block
            class="g-login-request"
            :loading="requesting"
            @click="requestCode"
          >
            <GIcon icon="ant-design:code-outlined" :size="14" />
            <span class="g-btn-text">
              {{ requested ? '重新请求验证码' : '请求验证码' }}
            </span>
          </Button>

          <Input
            v-model:value="codeInput"
            size="large"
            placeholder="请输入收到的验证码"
            class="g-login-input"
            allowClear
            @pressEnter="submitCode"
          >
            <template #prefix>
              <GIcon icon="ant-design:safety-outlined" :size="15" />
            </template>
          </Input>

          <Button
            type="primary"
            size="large"
            block
            :loading="codeLoading"
            @click="submitCode"
          >
            登录
          </Button>
        </TabPane>

        <TabPane key="chat" tab="聊天登录">
          <Alert
            type="info"
            show-icon
            class="g-login-alert"
            message="向 Bot 发送「#锅巴确认登录」即可进入"
            description="点击下方按钮后，用主人账号给 Bot 发这条指令，本页会自动登录，无需复制任何内容。"
          />

          <template v-if="confirmWaiting">
            <div class="g-confirm-wait">
              <Spin />
              <p class="g-confirm-tip">等待主人确认…</p>
              <p class="g-confirm-cmd">请向 Bot 发送 <code>#锅巴确认登录</code></p>
              <p class="g-confirm-meta">
                本次识别码 <b>{{ confirmCode }}</b> · {{ confirmLeft }} 秒后过期
              </p>
            </div>

            <Button block @click="stopConfirm">取消</Button>
          </template>

          <template v-else>
            <div class="g-login-steps">
              <div class="g-step">
                <span class="g-step-no">1</span>
                <span>点击下方「发起登录请求」</span>
              </div>
              <div class="g-step">
                <span class="g-step-no">2</span>
                <span>向 Bot 发送 <code>#锅巴确认登录</code></span>
              </div>
              <div class="g-step">
                <span class="g-step-no">3</span>
                <span>本页自动进入面板，请求 2 分钟内有效</span>
              </div>
            </div>

            <Button
              type="primary"
              size="large"
              block
              :loading="confirmStarting"
              @click="startConfirm"
            >
              发起登录请求
            </Button>

            <Typography.Text type="secondary" class="g-login-note">
              也可以发送「#锅巴登录」，Bot 会回复一个免密登录地址。
            </Typography.Text>
          </template>
        </TabPane>
      </Tabs>

      <footer v-if="ICP_NO" class="g-login-footer">{{ ICP_NO }}</footer>
    </div>
  </div>
</template>

<style scoped>
.g-login {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--g-bg);
  overflow: hidden;
}

/* 背景用两团柔和的品牌色光斑，避免纯色死板 */
.g-login-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 22% 28%, rgba(209, 159, 86, 0.18), transparent 42%),
    radial-gradient(circle at 78% 72%, rgba(86, 132, 209, 0.14), transparent 45%);
  pointer-events: none;
}

.g-login-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  padding: 32px 30px 24px;
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 16px;
  box-shadow: var(--g-shadow);
}

.g-login-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
}

.g-login-logo {
  width: 44px;
  height: 44px;
}

.g-login-title {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  color: var(--g-text);
}

.g-login-sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-login-alert {
  margin-bottom: 16px;
}

.g-login-request {
  margin-bottom: 12px;
}

.g-btn-text {
  margin-left: 6px;
}

.g-login-input {
  margin-bottom: 14px;
}

.g-login-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
}

.g-step {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--g-brand);
  background: var(--g-brand-soft);
  border-radius: 50%;
}

.g-step code {
  padding: 1px 5px;
  background: var(--g-brand-soft);
  border-radius: 4px;
  color: var(--g-brand);
}

.g-login-note {
  display: block;
  font-size: 12px;
}

/* 等待主人确认时的占位块 */
.g-confirm-wait {
  padding: 22px 16px 18px;
  margin-bottom: 12px;
  text-align: center;
  background: var(--g-brand-soft);
  border-radius: 10px;
}

.g-confirm-tip {
  margin: 12px 0 0;
  font-size: 14px;
  color: var(--g-text);
}

.g-confirm-cmd {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-confirm-cmd code {
  padding: 1px 5px;
  background: var(--g-bg-card);
  border-radius: 4px;
  color: var(--g-brand);
}

.g-confirm-meta {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-confirm-meta b {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 1px;
  color: var(--g-brand);
}

.g-login-footer {
  margin-top: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--g-text-dim);
}
</style>
