<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Button, Result, Space } from 'ant-design-vue'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
</script>

<template>
  <div class="g-404">
    <Result status="404" title="404" sub-title="这个页面走丢了">
      <template #extra>
        <Space>
          <Button type="primary" @click="router.push(auth.isLogin ? '/home' : '/login')">
            {{ auth.isLogin ? '回到首页' : '去登录' }}
          </Button>
          <Button @click="router.back()">返回上一页</Button>
        </Space>
      </template>
    </Result>
  </div>
</template>

<style scoped>
.g-404 {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--g-bg);
}
</style>
