<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Select, SelectOption, Spin } from 'ant-design-vue'
import { apiQueryGroupList } from '@/api'

/**
 * 群号多选。
 *
 * 对应 schema 中的 `GSelectGroup`，值为群号数组。
 * 支持远程搜索（按群号或群名），并允许直接输入未在列表中的群号，
 * 因为 Bot 可能尚未缓存到该群。
 */
const props = withDefaults(
  defineProps<{
    value?: any[]
    placeholder?: string
    /** 单选模式（默认多选） */
    single?: boolean
    disabled?: boolean
  }>(),
  { single: false },
)

const emit = defineEmits<{ 'update:value': [any] }>()

interface GroupOption {
  value: string | number
  label: string
  groupName?: string
}

const options = ref<GroupOption[]>([])
const loading = ref(false)
const inner = ref<any>(props.single ? undefined : [])

watch(
  () => props.value,
  (val) => {
    if (props.single) {
      inner.value = val ?? undefined
    } else {
      inner.value = Array.isArray(val) ? [...val] : []
    }
    ensureSelectedInOptions()
  },
  { immediate: true },
)

/** 已选中但不在候选列表里的群号，补进选项，否则 Select 只会显示裸 id */
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

async function fetchGroups(keyword?: string) {
  loading.value = true
  try {
    const params: Record<string, any> = { pageNo: 1, pageSize: 50 }
    if (keyword) {
      // 纯数字按群号查，否则按群名查
      if (/^\d+$/.test(keyword)) params.query_group_id = keyword
      else params.query_name = keyword
    }
    const page = await apiQueryGroupList(params)
    const records: any[] = page?.records ?? []
    const fetched: GroupOption[] = records.map((item) => ({
      value: item.group_id,
      label: item.group_name ? `${item.group_name}（${item.group_id}）` : String(item.group_id),
      groupName: item.group_name,
    }))
    // 保留已选中的项，避免搜索后回显丢失
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
    // 群列表拉取失败不阻断表单，用户仍可手动输入群号
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null

function onSearch(keyword: string) {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchGroups(keyword), 300)
}

function onChange(val: any) {
  inner.value = val
  emit('update:value', val)
}

onMounted(() => fetchGroups())
</script>

<template>
  <Select
    :value="inner"
    :mode="single ? undefined : 'tags'"
    :options="options"
    :placeholder="placeholder ?? (single ? '请选择群' : '请选择或输入群号')"
    :disabled="disabled"
    :filterOption="false"
    :notFoundContent="loading ? undefined : '未找到，可直接输入群号'"
    showSearch
    allowClear
    class="g-select-group"
    @search="onSearch"
    @change="onChange"
  >
    <template v-if="loading" #notFoundContent>
      <div class="g-select-loading"><Spin size="small" /></div>
    </template>
  </Select>
</template>

<style scoped>
.g-select-group {
  width: 100%;
  max-width: 560px;
}

.g-select-loading {
  padding: 8px;
  text-align: center;
}
</style>
