<script setup lang="ts">
/**
 * 「回到顶部」浮动按钮。
 *
 * 给日志 / 消息记录 / 沙盒这类会把页面拖到最底下的页面用：
 * 手机上滚到底之后，顶部的筛选栏、说明文字都在屏幕外，得有个按钮一步回去。
 * 页面本身不滚（宽屏一般都在容器内滚）时按钮不出现。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import GIcon from './GIcon.vue'
import { getPageScroller, scrollPageToTop } from '@/utils/scroll'

const props = withDefaults(defineProps<{ threshold?: number }>(), { threshold: 160 })

const visible = ref(false)
let scroller: HTMLElement | null = null

function sync() {
  visible.value = (scroller?.scrollTop ?? 0) > props.threshold
}

onMounted(() => {
  scroller = getPageScroller()
  scroller?.addEventListener('scroll', sync, { passive: true })
  // 打开页面就被拖到底的情况，挂上来时就该显示
  sync()
})

onBeforeUnmount(() => scroller?.removeEventListener('scroll', sync))
</script>

<template>
  <Transition name="g-backtop">
    <button v-if="visible" class="g-backtop" title="回到顶部" @click="scrollPageToTop()">
      <GIcon icon="ant-design:arrow-up-outlined" :size="15" />
    </button>
  </Transition>
</template>

<style scoped>
.g-backtop {
  position: fixed;
  right: 14px;
  /* 躲开各页面底部的输入框 / 状态栏 */
  bottom: 78px;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  color: var(--g-text-sub);
  background: var(--g-bg-elevated);
  border: 1px solid var(--g-border);
  border-radius: 50%;
  box-shadow: var(--g-shadow);
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s;
}

.g-backtop:hover {
  color: var(--g-brand);
  border-color: var(--g-brand);
}

.g-backtop-enter-active,
.g-backtop-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.g-backtop-enter-from,
.g-backtop-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
