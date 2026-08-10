<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Button, Result, Spin } from 'ant-design-vue'
import { useAuthStore } from '@/stores/auth'

/**
 * 免密登录中转页。
 *
 * `#锅巴登录` 会下发形如 http://host:port/#/ml/{code} 的地址，
 * 这里用 code 换 token（见 LoginService.getQuickLogin，code 3 分钟内有效且一次性）。
 */
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const failed = ref(false)
const errorText = ref('')

onMounted(async () => {
  const code = String(route.params.code ?? '')
  if (!code) {
    failed.value = true
    errorText.value = '登录地址不完整'
    return
  }
  try {
    await auth.loginByCode(code)
    await auth.loadUserInfo()
    router.replace('/home')
  } catch (e: any) {
    failed.value = true
    errorText.value = e?.message || '登录失败，链接可能已过期或已被使用'
  }
})
</script>

<template>
  <div class="g-magic">
    <Result
      v-if="failed"
      status="error"
      title="登录失败"
      :sub-title="errorText"
    >
      <template #extra>
        <Button type="primary" @click="router.replace('/login')">返回登录</Button>
      </template>
    </Result>

    <div v-else class="g-magic-loading">
      <Spin size="large" />
      <p class="g-magic-text">正在登录…</p>
    </div>
  </div>
</template>

<style scoped>
.g-magic {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--g-bg);
}

.g-magic-loading {
  text-align: center;
}

.g-magic-text {
  margin-top: 16px;
  font-size: 14px;
  color: var(--g-text-sub);
}
</style>
