<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button, Upload, message } from 'ant-design-vue'
import type { UploadChangeParam, UploadFile } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { API_BASE, TOKEN_KEY } from '@/utils/env'
import { useAuthStore } from '@/stores/auth'

/**
 * 文件上传。
 *
 * 对应 schema 中的 `Upload`。componentProps 支持：
 *  - action：上传地址（相对锅巴 api 根路径）
 *  - accept / maxCount / listType
 *  - resultField：从响应里取哪个字段作为表单值，默认取 result 本身
 *
 * 值为已上传文件的地址字符串（maxCount 为 1）或字符串数组。
 */
const props = withDefaults(
  defineProps<{
    value?: string | string[]
    action?: string
    accept?: string
    maxCount?: number
    listType?: 'text' | 'picture' | 'picture-card'
    resultField?: string
    disabled?: boolean
  }>(),
  { maxCount: 1, listType: 'text' },
)

const emit = defineEmits<{ 'update:value': [string | string[] | undefined] }>()

const auth = useAuthStore()

const uploadUrl = computed(() => {
  const action = props.action ?? '/upload'
  return action.startsWith('http') ? action : `${API_BASE}${action.startsWith('/') ? '' : '/'}${action}`
})

const headers = computed(() => ({ [TOKEN_KEY]: auth.token }))

const fileList = ref<UploadFile[]>([])

/** 把表单值同步成 antd 需要的 fileList 结构 */
watch(
  () => props.value,
  (val) => {
    const urls = Array.isArray(val) ? val : val ? [val] : []
    fileList.value = urls.map((url, idx) => ({
      uid: `-${idx + 1}`,
      name: url.split('/').pop() || `文件${idx + 1}`,
      status: 'done',
      url,
    })) as UploadFile[]
  },
  { immediate: true },
)

function pickUrl(response: any): string | undefined {
  if (!response) return undefined
  // 后端标准结构为 {ok, code, result, message}
  const payload = response.result ?? response
  if (props.resultField) return payload?.[props.resultField]
  if (typeof payload === 'string') return payload
  return payload?.url ?? payload?.path ?? undefined
}

function onChange(info: UploadChangeParam) {
  fileList.value = info.fileList

  if (info.file.status === 'done') {
    const url = pickUrl(info.file.response)
    if (!url) {
      message.warning('上传成功，但未能从响应中解析出文件地址')
      return
    }
    emitValue()
  } else if (info.file.status === 'error') {
    message.error(`${info.file.name} 上传失败`)
  } else if (info.file.status === 'removed') {
    emitValue()
  }
}

function emitValue() {
  const urls = fileList.value
    .filter((f) => f.status === 'done')
    .map((f) => f.url ?? pickUrl(f.response))
    .filter((v): v is string => !!v)

  if (props.maxCount === 1) {
    emit('update:value', urls[0])
  } else {
    emit('update:value', urls)
  }
}
</script>

<template>
  <Upload
    v-model:fileList="fileList"
    :action="uploadUrl"
    :headers="headers"
    :accept="accept"
    :maxCount="maxCount"
    :listType="listType"
    :disabled="disabled"
    name="file"
    @change="onChange"
  >
    <Button v-if="fileList.length < (maxCount ?? 1)" :disabled="disabled">
      <GIcon icon="ant-design:upload-outlined" :size="14" />
      <span class="g-upload-text">选择文件</span>
    </Button>
  </Upload>
</template>

<style scoped>
.g-upload-text {
  margin-left: 6px;
}
</style>
