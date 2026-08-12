<script setup lang="ts">
/**
 * 底部输入区，两档。
 *
 * 「普通」档就是文本 + 图片，「Raw」档直接把 JSON 段数组交给适配器 —— 相当于在
 * 插件里写 `e.reply([...])`，用来试按钮、markdown、自定义段这些普通档拼不出来的东西。
 *
 * 图片以原始 File 对象提交（multipart），不再转 base64 —— 共享 TRSS 端口时 body
 * 解析器是宿主的 express.json，默认 100kb，一张图塞进 JSON 就 413 了。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'

/** 预览用的图片，objectURL 由组件负责回收 */
interface PickedImage {
  file: File
  url: string
}

/** 右键 @ 攒起来的待 @ 对象，发送时转成 at 段 */
interface PickedAt {
  qq: string
  name: string
}

const props = defineProps<{
  disabled: boolean
  sending: boolean
  maxImages: number
  /** 引用的那条，父层给摘要，这里只负责显示与清除 */
  reply: { messageId: string; name: string; text: string } | null
}>()

const emit = defineEmits<{
  send: [payload: { text: string; images: File[]; ats: PickedAt[] }]
  sendRaw: [raw: string]
  cancelReply: []
}>()

const RAW_PLACEHOLDER = `[{"type": "text", "text": "hello"}]`

const mode = ref<'normal' | 'raw'>('normal')
const text = ref('')
const raw = ref('')
const images = ref<PickedImage[]>([])
/** 右键 @ 攒起来的人，发送时转 at 段 */
const ats = ref<PickedAt[]>([])

/** 一次最多 @ 几个人，跟图片一样给个上限 */
const MAX_ATS = 5

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
  emit('send', {
    text: text.value,
    images: images.value.map((i) => i.file),
    ats: ats.value,
  })
}

/** 发送成功后由父层调，失败时内容留着好改 */
function reset() {
  if (mode.value === 'raw') raw.value = ''
  else {
    text.value = ''
    clearImages()
    ats.value = []
  }
}

/** 右键 @ 某个人：去重、限数，重复了只把输入焦点捞回来 */
function addAt(one: { qq: string; name: string }) {
  if (!one.qq) return
  if (ats.value.some((a) => a.qq === one.qq)) {
    nextTick(() => inputEl.value?.focus())
    return
  }
  if (ats.value.length >= MAX_ATS) {
    message.warning(`一次最多 @ ${MAX_ATS} 个人`)
    return
  }
  ats.value.push(one)
  nextTick(() => inputEl.value?.focus())
}

function clearImages() {
  for (const img of images.value) URL.revokeObjectURL(img.url)
  images.value = []
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
    images.value.push({ file, url: URL.createObjectURL(file) })
  })
}

defineExpose({
  reset,
  focus: () => inputEl.value?.focus(),
  /** 右键 @ 某个人，由页面调 */
  addAt,
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
    <!-- 档位 tab 压在最上，跟参考图一样分两栏 -->
    <div class="g-cin-tabs">
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

    <!-- 待 @ 的人：右键菜单攒起来的，发送时转成真 at 段 -->
    <div v-if="ats.length" class="g-cin-ats">
      <span v-for="(a, i) in ats" :key="a.qq" class="g-cin-at">
        @{{ a.name || a.qq }}
        <button type="button" class="g-cin-at-x" @click="ats.splice(i, 1)">
          <GIcon icon="ant-design:close-outlined" :size="9" />
        </button>
      </span>
    </div>

    <template v-if="mode === 'normal'">
      <div v-if="images.length" class="g-cin-imgs">
        <div v-for="(img, i) in images" :key="img.url" class="g-cin-img">
          <img :src="img.url" alt="" />
          <span class="g-cin-img-del" @click="images.splice(i, 1)">
            <GIcon icon="ant-design:close-outlined" :size="10" />
          </span>
        </div>
      </div>
    </template>

    <a-textarea
      v-if="mode === 'normal'"
      ref="inputEl"
      v-model:value="text"
      :disabled="disabled"
      :placeholder="'输入消息，Enter 发送，Shift+Enter 换行；可粘贴或选择图片…'"
      :auto-size="{ minRows: 2, maxRows: 6 }"
      :bordered="false"
      @keydown.enter="onEnter"
      @paste="onPaste"
    />
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
        <!-- 图片按钮在左下角，圆形发送键在右下角 -->
        <button
          type="button"
          class="g-cin-imgbtn"
          :disabled="disabled || images.length >= maxImages"
          :title="images.length >= maxImages ? `最多 ${maxImages} 张` : '添加图片'"
          @click="fileEl?.click()"
        >
          <GIcon icon="ant-design:picture-outlined" :size="17" />
        </button>
        <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="onFileChange" />
      </template>
      <span class="g-cin-gap" />
      <button
        type="button"
        class="g-cin-send"
        :class="{ 'is-sending': sending }"
        :disabled="!canSend"
        :title="mode === 'raw' ? '发送段数组' : '发送消息'"
        @click="submit"
      >
        <GIcon icon="ant-design:send-outlined" :size="17" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.g-cin {
  border-top: 1px solid var(--g-border);
  padding: 8px 10px 8px;
}

.g-cin.is-disabled {
  opacity: 0.6;
}

.g-cin-tabs {
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

.g-cin-ats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.g-cin-at {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--g-brand-soft);
  color: var(--g-brand);
  font-size: 12px;
}

.g-cin-at-x {
  display: inline-flex;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
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
  gap: 6px;
  margin-top: 4px;
}

.g-cin-imgbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--g-text-sub);
  cursor: pointer;
}

.g-cin-imgbtn:hover:not(:disabled) {
  background: var(--g-bg-soft);
  color: var(--g-brand);
}

.g-cin-imgbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 圆形发送键，跟参考图一致 */
.g-cin-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: var(--g-brand);
  color: #fff;
  cursor: pointer;
  transition: transform 0.12s, box-shadow 0.12s;
}

.g-cin-send:hover:not(:disabled) {
  transform: scale(1.06);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.g-cin-send:active:not(:disabled) {
  transform: scale(0.96);
}

.g-cin-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.g-cin-send.is-sending {
  animation: g-cin-pulse 1s infinite;
}

@keyframes g-cin-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
