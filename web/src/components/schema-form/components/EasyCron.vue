<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button, Input, Popover, Tag } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { explainCron } from '@/utils/cron'

/**
 * Cron 表达式输入。
 *
 * 对应 schema 中的 `EasyCron`。Yunzai 用的是 node-schedule 风格的表达式，
 * 支持 5 段（分 时 日 月 周）或 6 段（含秒）。
 * 这里在输入之外提供常用预设与人类可读解释，降低手写出错概率。
 */
const props = defineProps<{
  value?: string
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:value': [string] }>()

const inner = ref(props.value ?? '')

watch(
  () => props.value,
  (val) => {
    inner.value = val ?? ''
  },
)

function onInput(val: string) {
  inner.value = val
  emit('update:value', val)
}

/** 常用预设，覆盖签到、推送这类典型场景 */
const presets = [
  { label: '每分钟', expr: '0 * * * * ?' },
  { label: '每小时', expr: '0 0 * * * ?' },
  { label: '每天 0 点', expr: '0 0 0 * * ?' },
  { label: '每天 8 点', expr: '0 0 8 * * ?' },
  { label: '每天 0:02', expr: '0 2 0 * * ?' },
  { label: '每周一 8 点', expr: '0 0 8 ? * 1' },
  { label: '每月 1 号 0 点', expr: '0 0 0 1 * ?' },
]

function applyPreset(expr: string) {
  onInput(expr)
}

/** 解释表达式，解析不了就不显示，避免给出误导信息 */
const explain = computed(() => explainCron(inner.value ?? ''))

const invalid = computed(() => {
  const expr = inner.value?.trim()
  if (!expr) return false
  const segments = expr.split(/\s+/)
  // node-schedule 接受 5 或 6 段
  return segments.length < 5 || segments.length > 6
})
</script>

<template>
  <div class="g-cron">
    <div class="g-cron-row">
      <Input
        :value="inner"
        :placeholder="placeholder ?? '如 0 0 8 * * ?（秒 分 时 日 月 周）'"
        :disabled="disabled"
        :status="invalid ? 'error' : undefined"
        allowClear
        @update:value="onInput"
      />
      <Popover placement="bottomRight" trigger="click">
        <template #content>
          <div class="g-cron-presets">
            <Tag
              v-for="item in presets"
              :key="item.expr"
              class="g-cron-preset"
              @click="applyPreset(item.expr)"
            >
              {{ item.label }}
            </Tag>
          </div>
        </template>
        <Button :disabled="disabled" class="g-cron-btn">
          <GIcon icon="ant-design:clock-circle-outlined" :size="14" />
        </Button>
      </Popover>
    </div>

    <div v-if="invalid" class="g-cron-tip is-error">
      表达式需为 5 段（分 时 日 月 周）或 6 段（含秒）
    </div>
    <div v-else-if="explain" class="g-cron-tip">{{ explain }}</div>
  </div>
</template>

<style scoped>
.g-cron {
  max-width: 480px;
}

.g-cron-row {
  display: flex;
  gap: 6px;
}

.g-cron-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.g-cron-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 240px;
}

.g-cron-preset {
  margin: 0;
  cursor: pointer;
  border-radius: 6px;
}

.g-cron-preset:hover {
  color: var(--g-brand);
  border-color: var(--g-brand);
}

.g-cron-tip {
  margin-top: 4px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-cron-tip.is-error {
  color: #d9614c;
}
</style>
