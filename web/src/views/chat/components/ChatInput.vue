<script setup lang="ts">
/**
 * 底部输入区，两档。
 *
 * 「普通」档就是文本 + 图片，「Raw」档直接把 JSON 段数组交给适配器 —— 相当于在
 * 插件里写 `e.reply([...])`，用来试按钮、markdown、自定义段这些普通档拼不出来的东西。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'

const props = defineProps<{
  disabled: boolean
  sending: boolean
  maxImages: number
  /** 引用的那条，父层给摘要，这里只负责显示与清除 */
  reply: { messageId: string; name: string; text: string } | null
}>()

const emit = defineEmits<{
  send: [payload: { text: string; images: string[] }]
  sendRaw: [raw: string]
  cancelReply: []
}>()

const RAW_PLACEHOLDER = `[{"type": "text", "text": "hello"}]`

const mode = ref<'normal' | 'raw'>('normal')
const text = ref('')
const raw = ref('')
const images = ref<string[]>([])

const inputEl = ref<any>(null)
const fileEl = ref<HTMLInputElement | null>(null)

const canSend = computed(() => {
  if (props.disabled || props.sending) return false
  return mode.value === 'raw' ? !!raw.value.trim() : !!text.value.trim() || !!images.value.length
})

/** 引用了就把焦点交给输入框，点完「引用」能直接打字 */
watch(
  () => props.reply,
  (v) => {
    if (!v) return
    mode.value = 'normal'
    nextTick(() => inputEl.value?.focus())
  },
)

function submit() {
  if (!canSend.value) return
  if (mode.value === 'raw') {
    // 先在本地挡一次非法 JSON，省一趟请求，也免得后端报错时看不出是哪儿的问题
    try {
      JSON.parse(raw.value)
    } catch (e: any) {
      message.error(`JSON 解析失败：${e?.message ?? e}`)
      return
    }
    emit('sendRaw', raw.value)
    return
  }
  emit('send', { text: text.value, images: images.value })
}

/** 发送成功后由父层调，失败时内容留着好改 */
function reset() {
  if (mode.value === 'raw') raw.value = ''
  else {
    text.value = ''
    images.value = []
  }
}

function onEnter(e: KeyboardEvent) {
  // Shift+Enter 换行，Ctrl/Cmd+Enter 也当发送（Raw 档多行内容更顺手）
  if (e.shiftKey) return
  e.preventDefault()
  submit()
}

/* ---------------- 图片 ---------------- */

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  // 清掉才能连着选同一个文件两次
  input.value = ''
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f)
  if (files.length) {
    e.preventDefault()
    addFiles(files)
  }
}

function addFiles(files: File[]) {
  const room = props.maxImages - images.value.length
  if (room <= 0) {
    message.warning(`最多带 ${props.maxImages} 张图`)
    return
  }
  files.slice(0, room).forEach((file) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') images.value.push(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

defineExpose({
  reset,
  focus: () => inputEl.value?.focus(),
  /** 按钮段的 input 会往输入框里填文本，由页面调 */
  setText: (v: string) => {
    mode.value = 'normal'
    text.value = v
    nextTick(() => inputEl.value?.focus())
  },
})
</script>

<template>
  <div class="g-cin" :class="{ 'is-disabled': disabled }">
    <div class="g-cin-bar">
      <a-radio-group v-model:value="mode" size="small" button-style="solid">
        <a-radio-button value="normal">普通</a-radio-button>
        <a-radio-button value="raw">发送 Raw</a-radio-button>
      </a-radio-group>
      <span class="g-cin-gap" />
      <span class="g-cin-tip">
        {{
          mode === 'raw'
            ? '段数组直接交给适配器，等价于插件里的 e.reply([...])'
            : '真的会发到 QQ 上'
        }}
      </span>
    </div>

    <!-- 引用条：跟 QQ 一样压在输入框上方，×撤掉 -->
    <div v-if="reply" class="g-cin-reply">
      <GIcon icon="ant-design:rollback-outlined" :size="12" />
      <span class="g-cin-reply-name">{{ reply.name }}</span>
      <span class="g-cin-reply-text">{{ reply.text }}</span>
      <button type="button" class="g-cin-reply-x" @click="emit('cancelReply')">
        <GIcon icon="ant-design:close-outlined" :size="11" />
      </button>
    </div>

    <template v-if="mode === 'normal'">
      <div v-if="images.length" class="g-cin-imgs">
        <div v-for="(img, i) in images" :key="i" class="g-cin-img">
          <img :src="img" alt="" />
          <span class="g-cin-img-del" @click="images.splice(i, 1)">
            <GIcon icon="ant-design:close-outlined" :size="10" />
          </span>
        </div>
      </div>

      <a-textarea
        ref="inputEl"
        v-model:value="text"
        :disabled="disabled"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行；可粘贴或选择图片…"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :bordered="false"
        @keydown.enter="onEnter"
        @paste="onPaste"
      />
    </template>

    <a-textarea
      v-else
      ref="inputEl"
      v-model:value="raw"
      :disabled="disabled"
      :placeholder="`段数组 JSON，例如 ${RAW_PLACEHOLDER}；Enter 发送，Shift+Enter 换行`"
      :auto-size="{ minRows: 3, maxRows: 8 }"
      :bordered="false"
      class="g-cin-raw"
      @keydown.enter="onEnter"
    />

    <div class="g-cin-acts">
      <template v-if="mode === 'normal'">
        <a-button
          size="small"
          type="text"
          :disabled="disabled || images.length >= maxImages"
          @click="fileEl?.click()"
        >
          <GIcon icon="ant-design:picture-outlined" :size="15" />
        </a-button>
        <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="onFileChange" />
      </template>
      <span class="g-cin-gap" />
      <a-button type="primary" size="small" :loading="sending" :disabled="!canSend" @click="submit">
        <GIcon icon="ant-design:send-outlined" :size="13" />
        发送
      </a-button>
    </div>
  </div>
</template>

<style scoped>
.g-cin {
  border-top: 1px solid var(--g-border);
  padding: 8px 10px 6px;
}

.g-cin.is-disabled {
  opacity: 0.6;
}

.g-cin-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.g-cin-gap {
  flex: 1;
}

.g-cin-tip {
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-cin-reply {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--g-brand);
  border-radius: 0 6px 6px 0;
  background: var(--g-bg-soft);
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-cin-reply-name {
  flex: none;
  color: var(--g-text-sub);
}

.g-cin-reply-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-cin-reply-x {
  flex: none;
  display: inline-flex;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--g-text-dim);
  cursor: pointer;
}

.g-cin-reply-x:hover {
  color: var(--g-danger);
}

.g-cin-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.g-cin-img {
  position: relative;
  width: 56px;
  height: 56px;
}

.g-cin-img img {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  border: 1px solid var(--g-border);
  object-fit: cover;
}

.g-cin-img-del {
  position: absolute;
  top: -5px;
  right: -5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--g-bg-elevated);
  border: 1px solid var(--g-border);
  color: var(--g-text-sub);
  cursor: pointer;
}

.g-cin-img-del:hover {
  color: var(--g-danger);
  border-color: var(--g-danger);
}

/* Raw 档用等宽字体，JSON 更好读 */
.g-cin-raw :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.g-cin-acts {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
