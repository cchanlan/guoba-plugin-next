<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { Button, Modal, Space, Tooltip, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { FORM_MODEL_KEY, PLUGIN_NAME_KEY } from '../context'
import { apiDoPluginAction } from '@/api'
import { get } from 'lodash-es'

/**
 * 插件自定义按钮组。
 *
 * schema 形如：
 * ```
 * {
 *   component: 'GButtons',
 *   componentProps: {
 *     spaceSize: 8,
 *     buttons: [
 *       { label: '同步数据', action: 'syncData', type: 'primary', icon: '...',
 *         confirm: '确定要同步吗？', tooltip: {title: '...', placement: 'top'},
 *         args: ['#{someField}', 123] },
 *     ],
 *   },
 * }
 * ```
 * 点击后调用 POST /plugin/do/:pluginName/action。
 * args 里字符串中的 `#{字段路径}` 会用表单当前值替换。
 */
interface ButtonDef {
  label?: string
  action?: string
  type?: string
  icon?: string
  size?: string
  block?: boolean
  danger?: boolean
  shape?: string
  ghost?: boolean
  disabled?: boolean
  confirm?: string
  tooltip?: { title?: string; placement?: string }
  args?: any[]
}

const props = withDefaults(
  defineProps<{
    buttons?: ButtonDef[]
    spaceSize?: number
  }>(),
  { spaceSize: 8 },
)

const formModel = inject(FORM_MODEL_KEY, undefined)
const pluginName = inject(PLUGIN_NAME_KEY, undefined)

const loadingAction = ref('')

const list = computed(() => (Array.isArray(props.buttons) ? props.buttons : []))
const formatError = computed(() =>
  Array.isArray(props.buttons) || props.buttons == null ? '' : 'buttons 需要是数组',
)

/** 把 `#{a.b}` 替换成表单里的实际值 */
function resolveArgs(args?: any[]) {
  if (!Array.isArray(args)) return []
  const values = formModel?.value ?? {}
  return args.map((arg) => {
    if (typeof arg !== 'string') return arg
    return arg.replace(/#\{([^}]+)\}/g, (_m, path: string) => {
      const v = get(values, path.trim())
      return v == null ? '' : String(v)
    })
  })
}

async function run(btn: ButtonDef) {
  if (!btn.action) {
    message.warning('按钮缺少 action 参数')
    return
  }
  if (!pluginName?.value) {
    message.warning('当前页面没有插件上下文，无法执行操作')
    return
  }

  if (btn.confirm) {
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '请确认',
        content: btn.confirm,
        okText: '确定',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
    if (!confirmed) return
  }

  loadingAction.value = btn.action
  try {
    await apiDoPluginAction(pluginName.value, btn.action, resolveArgs(btn.args))
  } catch {
    // 请求层已提示
  } finally {
    loadingAction.value = ''
  }
}
</script>

<template>
  <div class="g-buttons">
    <div v-if="formatError" class="g-buttons-error">{{ formatError }}</div>

    <Space :size="spaceSize" wrap>
      <template v-for="(btn, idx) in list" :key="idx">
        <Tooltip v-if="btn.tooltip?.title" :title="btn.tooltip.title" :placement="btn.tooltip.placement as any">
          <Button
            :type="(btn.type as any)"
            :size="(btn.size as any)"
            :block="btn.block"
            :danger="btn.danger"
            :shape="(btn.shape as any)"
            :ghost="btn.ghost"
            :disabled="btn.disabled"
            :loading="loadingAction === btn.action"
            @click="run(btn)"
          >
            <GIcon v-if="btn.icon" :icon="btn.icon" :size="13" />
            <span :class="{ 'g-btn-text': !!btn.icon }">{{ btn.label }}</span>
          </Button>
        </Tooltip>

        <Button
          v-else
          :type="(btn.type as any)"
          :size="(btn.size as any)"
          :block="btn.block"
          :danger="btn.danger"
          :shape="(btn.shape as any)"
          :ghost="btn.ghost"
          :disabled="btn.disabled"
          :loading="loadingAction === btn.action"
          @click="run(btn)"
        >
          <GIcon v-if="btn.icon" :icon="btn.icon" :size="13" />
          <span :class="{ 'g-btn-text': !!btn.icon }">{{ btn.label }}</span>
        </Button>
      </template>
    </Space>
  </div>
</template>

<style scoped>
.g-buttons-error {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--g-danger, #e05c5c);
}

.g-btn-text {
  margin-left: 5px;
}
</style>
