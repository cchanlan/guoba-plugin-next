<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Select, Spin } from 'ant-design-vue'
import { apiQueryFriendList } from '@/api'

/**
 * 好友（QQ号）多选。
 *
 * 对应 schema 中的 `GSelectFriend`，值为 QQ 号数组。
 * 与 GSelectGroup 同样允许直接输入未缓存到的 QQ 号。
 */
const props = withDefaults(
  defineProps<{
    value?: any[]
    placeholder?: string
    single?: boolean
    disabled?: boolean
  }>(),
  { single: false },
)

const emit = defineEmits<{ 'update:value': [any] }>()

interface FriendOption {
  value: string | number
  label: string
}

const options = ref<FriendOption[]>([])
const loading = ref(false)
const inner = ref<any>(props.single ? undefined : [])

watch(
  () => props.value,
  (val) => {
    inner.value = props.single ? (val ?? undefined) : Array.isArray(val) ? [...val] : []
    ensureSelectedInOptions()
  },
  { immediate: true },
)

function ensureSelectedInOptions() {
  const selected = props.single
    ? props.value != null
      ? [props.value]
      : []
    : Array.isArray(props.value)
      ? props.value
      : []
  for (const id of selected) {
    if (!options.value.some((o) => String(o.value) === String(id))) {
      options.value.push({ value: id, label: String(id) })
    }
  }
}

async function fetchFriends(keyword?: string) {
  loading.value = true
  try {
    const params: Record<string, any> = { pageNo: 1, pageSize: 50 }
    if (keyword) {
      if (/^\d+$/.test(keyword)) params.query_qq = keyword
      else params.query_name = keyword
    }
    const page = await apiQueryFriendList(params)
    const records: any[] = page?.records ?? []
    const fetched: FriendOption[] = records.map((item) => {
      const name = item.remark || item.nickname
      return {
        value: item.user_id,
        label: name ? `${name}（${item.user_id}）` : String(item.user_id),
      }
    })
    const keep = options.value.filter((o) => {
      const selected = props.single
        ? [inner.value]
        : Array.isArray(inner.value)
          ? inner.value
          : []
      return (
        selected.some((s: any) => String(s) === String(o.value)) &&
        !fetched.some((f) => String(f.value) === String(o.value))
      )
    })
    options.value = [...keep, ...fetched]
  } catch {
    // 好友列表拉取失败不阻断表单
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null

function onSearch(keyword: string) {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchFriends(keyword), 300)
}

function onChange(val: any) {
  inner.value = val
  emit('update:value', val)
}

onMounted(() => fetchFriends())
</script>

<template>
  <Select
    :value="inner"
    :mode="single ? undefined : 'tags'"
    :options="options"
    :placeholder="placeholder ?? (single ? '请选择好友' : '请选择或输入QQ号')"
    :disabled="disabled"
    :filterOption="false"
    :notFoundContent="loading ? undefined : '未找到，可直接输入QQ号'"
    showSearch
    allowClear
    class="g-select-friend"
    @search="onSearch"
    @change="onChange"
  >
    <template v-if="loading" #notFoundContent>
      <div class="g-select-loading"><Spin size="small" /></div>
    </template>
  </Select>
</template>

<style scoped>
.g-select-friend {
  width: 100%;
  max-width: 560px;
}

.g-select-loading {
  padding: 8px;
  text-align: center;
}
</style>
