<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button, Card, Empty, Space, message } from 'ant-design-vue'
import SchemaForm from '@/components/schema-form/SchemaForm.vue'
import GIcon from '@/components/GIcon.vue'
import { apiGetConfigData, apiSetConfigData } from '@/api'
import { structuredCloneSafe } from '@/utils/schema'
import type { ConfigCard } from '@/types'

const props = defineProps<{ card: ConfigCard }>()

const formRef = ref<InstanceType<typeof SchemaForm> | null>(null)
const loading = ref(true)
const saving = ref(false)
const data = ref<Record<string, any>>({})

async function load() {
  loading.value = true
  try {
    const res = await apiGetConfigData(props.card.key)
    data.value = res && typeof res === 'object' ? res : {}
  } catch {
    data.value = {}
  } finally {
    loading.value = false
  }
}

async function save() {
  const form = formRef.value
  if (!form) return
  try {
    await form.validate()
  } catch {
    message.warning('请先修正表单中的错误')
    return
  }
  saving.value = true
  try {
    await apiSetConfigData(props.card.key, structuredCloneSafe(form.getValues()))
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

    <Empty v-if="!loading && !card.schemas?.length" description="该配置项暂无可视化表单" />
    <SchemaForm
      v-else-if="!loading"
      ref="formRef"
      :schemas="card.schemas"
      :data="data"
    />
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
</style>
