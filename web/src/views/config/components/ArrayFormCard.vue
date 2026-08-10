<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Button,
  Card,
  Empty,
  Input,
  Space,
  Tooltip,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiGetConfigData, apiSetConfigData } from '@/api'
import type { ConfigCard } from '@/types'

/**
 * 数组型配置卡（type: 'arrayFormCard'）。
 * 数据是一个字符串数组，比如原神的公共 Cookie 列表。
 */
const props = defineProps<{ card: ConfigCard }>()

const loading = ref(true)
const saving = ref(false)
const items = ref<string[]>([])

const lengthMin = computed<number>(() => Number(props.card.lengthMin ?? 0))
const lengthMax = computed<number>(() => Number(props.card.lengthMax ?? Infinity))
const canAdd = computed(() => props.card.allowAdd !== false && items.value.length < lengthMax.value)
const canDel = computed(() => props.card.allowDel !== false && items.value.length > lengthMin.value)

async function load() {
  loading.value = true
  try {
    const res = await apiGetConfigData(props.card.key)
    items.value = Array.isArray(res) ? res.map((v) => (v == null ? '' : String(v))) : []
    // 保证至少有 lengthMin 个输入框
    while (items.value.length < lengthMin.value) items.value.push('')
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

function addItem() {
  if (!canAdd.value) {
    message.warning(`最多只能添加 ${lengthMax.value} 项`)
    return
  }
  items.value.push('')
}

function removeItem(index: number) {
  if (!canDel.value) {
    message.warning(`至少需要保留 ${lengthMin.value} 项`)
    return
  }
  items.value.splice(index, 1)
}

async function save() {
  // 空行直接丢掉，不写进配置文件
  const values = items.value.map((v) => (v ?? '').trim()).filter((v) => v !== '')

  if (values.length < lengthMin.value) {
    message.warning(`至少需要填写 ${lengthMin.value} 项`)
    return
  }

  saving.value = true
  try {
    await apiSetConfigData(props.card.key, values)
    items.value = values
    while (items.value.length < lengthMin.value) items.value.push('')
  } finally {
    saving.value = false
  }
}

watch(() => props.card.key, load, { immediate: true })
</script>

<template>
  <Card :bordered="false" :loading="loading" class="g-cfg-card">
    <template #title>
      <div class="g-cfg-head">
        <span class="g-cfg-title">{{ card.title }}</span>
        <span v-if="card.desc" class="g-cfg-desc">{{ card.desc }}</span>
      </div>
    </template>

    <template #extra>
      <Space>
        <Button size="small" :disabled="loading || saving" @click="load">
          <GIcon icon="ant-design:reload-outlined" :size="13" />
        </Button>
        <Button type="primary" size="small" :loading="saving" @click="save">保存</Button>
      </Space>
    </template>

    <template v-if="!loading">
      <Empty v-if="!items.length" :image="Empty.PRESENTED_IMAGE_SIMPLE" description="暂无内容" />

      <div v-for="(_, index) in items" :key="index" class="g-af-row">
        <span class="g-af-no">{{ index + 1 }}</span>
        <Input
          v-model:value="items[index]"
          :placeholder="card.placeholder || '请输入内容'"
          allowClear
        />
        <Tooltip title="删除这一项">
          <Button type="text" danger :disabled="!canDel" @click="removeItem(index)">
            <GIcon icon="ant-design:minus-circle-outlined" :size="15" />
          </Button>
        </Tooltip>
      </div>

      <Button v-if="canAdd" type="dashed" block class="g-af-add" @click="addItem">
        <GIcon icon="ant-design:plus-outlined" :size="13" />
        <span class="g-btn-text">{{ card.addBtnText || '添加一项' }}</span>
      </Button>
    </template>
  </Card>
</template>

<style scoped>
.g-cfg-card {
  margin-bottom: 16px;
}

.g-cfg-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.g-cfg-title {
  font-size: 15px;
  font-weight: 600;
}

.g-cfg-desc {
  font-size: 12px;
  font-weight: 400;
  color: var(--g-text-dim);
}

.g-af-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.g-af-no {
  width: 22px;
  flex-shrink: 0;
  font-size: 12px;
  text-align: center;
  color: var(--g-text-dim);
}

.g-af-add {
  margin-top: 4px;
}

.g-btn-text {
  margin-left: 4px;
}
</style>
