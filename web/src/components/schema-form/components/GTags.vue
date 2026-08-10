<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Input, Select, Tag } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'

/**
 * 标签数组编辑器。
 *
 * 对应 schema 中的 `GTags`，值为数组（字符串或数字）。
 * componentProps 支持：
 *  - allowAdd / allowDel：是否允许增删（默认都允许）
 *  - options：给定候选项时，改用下拉多选，避免手输错值
 *  - mode：'multiple'（配合 options 使用）
 *  - placeholder
 */
const props = withDefaults(
  defineProps<{
    value?: any[]
    allowAdd?: boolean
    allowDel?: boolean
    options?: Array<{ label?: string; value: any }>
    placeholder?: string
    /** 输入内容是否转成数字（QQ号、群号等场景） */
    numeric?: boolean
  }>(),
  { allowAdd: true, allowDel: true },
)

const emit = defineEmits<{ 'update:value': [any[]] }>()

const list = ref<any[]>([])

watch(
  () => props.value,
  (val) => {
    list.value = Array.isArray(val) ? [...val] : []
  },
  { immediate: true },
)

function commit() {
  emit('update:value', [...list.value])
}

/* ---- 有候选项时走下拉多选 ---- */
const hasOptions = computed(() => Array.isArray(props.options) && props.options.length > 0)

const selectOptions = computed(() =>
  (props.options ?? []).map((o) => ({
    label: o.label ?? String(o.value),
    value: o.value,
  })),
)

const selectValue = computed({
  get: () => list.value,
  set: (val: any[]) => {
    list.value = Array.isArray(val) ? val : []
    commit()
  },
})

/* ---- 无候选项时走手动输入标签 ---- */
const inputVisible = ref(false)
const inputValue = ref('')
const inputRef = ref<any>(null)

async function showInput() {
  inputVisible.value = true
  await nextTick()
  inputRef.value?.focus?.()
}

function addTag() {
  const raw = inputValue.value.trim()
  if (raw) {
    const val = props.numeric && /^\d+$/.test(raw) ? Number(raw) : raw
    // 去重，避免同一个群号/功能名加两次
    if (!list.value.some((item) => String(item) === String(val))) {
      list.value.push(val)
      commit()
    }
  }
  inputValue.value = ''
  inputVisible.value = false
}

function removeTag(index: number) {
  list.value.splice(index, 1)
  commit()
}
</script>

<template>
  <Select
    v-if="hasOptions"
    v-model:value="selectValue"
    mode="multiple"
    allowClear
    :options="selectOptions"
    :placeholder="placeholder ?? '请选择'"
    class="g-tags-select"
  />

  <div v-else class="g-tags">
    <Tag
      v-for="(item, index) in list"
      :key="`${item}-${index}`"
      :closable="allowDel"
      class="g-tag"
      @close.prevent="removeTag(index)"
    >
      {{ item }}
    </Tag>

    <Input
      v-if="inputVisible"
      ref="inputRef"
      v-model:value="inputValue"
      size="small"
      class="g-tag-input"
      :placeholder="placeholder ?? '回车确认'"
      @blur="addTag"
      @keyup.enter="addTag"
    />
    <Tag v-else-if="allowAdd" class="g-tag-add" @click="showInput">
      <GIcon icon="ant-design:plus-outlined" :size="11" />
      <span>添加</span>
    </Tag>

    <span v-if="!list.length && !allowAdd" class="g-tags-empty">暂无内容</span>
  </div>
</template>

<style scoped>
.g-tags-select {
  width: 100%;
  max-width: 560px;
}

.g-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
}

.g-tag {
  margin: 0;
  padding: 2px 8px;
  border-radius: 6px;
}

.g-tag-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 2px 8px;
  border-style: dashed;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
}

.g-tag-add:hover {
  color: var(--g-brand);
  border-color: var(--g-brand);
}

.g-tag-input {
  width: 110px;
}

.g-tags-empty {
  font-size: 12px;
  color: var(--g-text-dim);
}
</style>
