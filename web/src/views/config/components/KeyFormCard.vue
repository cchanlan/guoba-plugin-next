<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Button,
  Card,
  Collapse,
  CollapsePanel,
  Empty,
  Form,
  FormItem,
  Input,
  Modal,
  Popconfirm,
  Space,
  message,
} from 'ant-design-vue'
import SchemaForm from '@/components/schema-form/SchemaForm.vue'
import GIcon from '@/components/GIcon.vue'
import { apiGetConfigData, apiRemoveCardForm, apiSetConfigData } from '@/api'
import {
  CONFIG_INTEGER_KEY,
  displayKey,
  evalTitleTemplate,
  normalizeRules,
  structuredCloneSafe,
} from '@/utils/schema'
import type { ConfigCard } from '@/types'

/**
 * 键值型配置卡（type: 'keyFormCard'）。
 *
 * 数据形如 `{ default: {...}, '123456': {...} }`，每个 key 一份独立表单。
 * 后端对纯数字 key 会加 INTEGER__ 前缀，展示时要去掉，提交时保持原样。
 */
const props = defineProps<{ card: ConfigCard }>()

interface Entry {
  key: string
  data: Record<string, any>
  /** 本地新增、尚未保存到后端 */
  isNew?: boolean
}

const loading = ref(true)
const hydrated = ref(false)
const saving = ref(false)
const entries = ref<Entry[]>([])
const activeKeys = ref<string[]>([])
/**
 * 每个 key 对应的表单实例。
 * 折叠面板收起时表单会被销毁，所以收起前要把值同步回 entry.data（见下方 watch）。
 */
const formRefs = new Map<string, InstanceType<typeof SchemaForm>>()

const addOpen = ref(false)
const addValue = ref('')
const addFormRef = ref<any>(null)

const promptProps = computed<Record<string, any>>(() => props.card.promptProps ?? {})
const addRules = computed(() => normalizeRules(promptProps.value.rules))

/**
 * 卡片头部标题。
 * card.title 往往是个模板表达式（每个子项各算一次），
 * 这里去掉模板部分留下固定文案，实在没有就用兜底名。
 */
const cardTitle = computed(() => {
  const raw = String(props.card.title ?? '')
  const stripped = raw.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/[（(]\s*[)）]/g, '').trim()
  return stripped || '分组配置'
})

function setFormRef(key: string, el: any) {
  // 卸载时 Vue 会回传 null，此时不清空引用，交由 activeKeys 的 watch 统一处理
  if (el) formRefs.set(key, el)
}

/** 把某项表单的当前值同步回 entry.data，并释放引用 */
function flushEntry(key: string) {
  const form = formRefs.get(key)
  if (!form) return
  const entry = entries.value.find((e) => e.key === key)
  if (entry) entry.data = structuredCloneSafe(form.getValues())
  formRefs.delete(key)
}

// 折叠面板收起会销毁内部表单，收起前先把值存回 entry.data，否则用户的编辑会丢
watch(activeKeys, (next, prev) => {
  for (const key of prev ?? []) {
    if (!next.includes(key)) flushEntry(key)
  }
})

function entryTitle(entry: Entry) {
  const title = props.card.title ?? ''
  if (!title.includes('{{')) {
    // 没有模板就退回展示 key 本身
    return `${title || '配置'}（${displayKey(entry.key)}）`
  }
  // 与后端模板约定一致：form.key 为原始 key，form.values 为该项数据
  return evalTitleTemplate(title, { key: displayKey(entry.key), values: entry.data })
}

async function load() {
  loading.value = true
  formRefs.clear()
  try {
    const res = await apiGetConfigData(props.card.key)
    const obj = res && typeof res === 'object' && !Array.isArray(res) ? res : {}
    entries.value = Object.keys(obj).map((key) => ({
      key,
      data: obj[key] && typeof obj[key] === 'object' ? obj[key] : {},
    }))
    // 默认展开第一项，其余收起，避免一次渲染上百个表单
    activeKeys.value = entries.value.length ? [entries.value[0].key] : []
  } catch {
    entries.value = []
    activeKeys.value = []
  } finally {
    loading.value = false
    hydrated.value = true
  }
}

/** 收集所有值：展开中的取表单实时值，收起的用 entry.data */
function collectValues() {
  const result: Record<string, any> = {}
  for (const entry of entries.value) {
    const form = formRefs.get(entry.key)
    const values = structuredCloneSafe(form ? form.getValues() : entry.data)
    // 这个字段是后端为了展示群名临时塞进来的，不能写回配置
    delete values.__GROUP_TIP_TEXT__
    result[entry.key] = values
  }
  return result
}

async function save() {
  // 只校验当前已渲染的表单，收起的项未被编辑过
  for (const entry of entries.value) {
    const form = formRefs.get(entry.key)
    if (!form) continue
    try {
      await form.validate()
    } catch {
      activeKeys.value = [...new Set([...activeKeys.value, entry.key])]
      message.warning(`「${entryTitle(entry)}」中有未填写正确的项`)
      return
    }
  }

  saving.value = true
  try {
    await apiSetConfigData(props.card.key, collectValues())
    // 保存成功后这些项已落盘，删除时需要走后端接口
    entries.value.forEach((e) => (e.isNew = false))
  } finally {
    saving.value = false
  }
}

function openAdd() {
  addValue.value = ''
  addOpen.value = true
}

async function confirmAdd() {
  try {
    await addFormRef.value?.validate()
  } catch {
    return
  }
  const raw = addValue.value.trim()
  // 纯数字 key 要补上后端约定的前缀，否则写进 yaml 会变成字符串键
  const key = /^\d+$/.test(raw) ? CONFIG_INTEGER_KEY + raw : raw

  if (entries.value.some((e) => e.key === key)) {
    message.warning('该配置已存在')
    return
  }

  // 以默认配置为模板，方便直接改
  const template = entries.value.find((e) => e.key === 'default')?.data
  const data = structuredCloneSafe(template ?? {})
  delete data.__GROUP_TIP_TEXT__
  entries.value.push({ key, data, isNew: true })
  activeKeys.value = [...activeKeys.value, key]
  addOpen.value = false
  message.success('已添加，记得点保存')
}

async function removeEntry(entry: Entry) {
  const idx = entries.value.findIndex((e) => e.key === entry.key)
  if (idx < 0) return

  // 本地新增还没保存过的项，后端没有对应数据，直接移除即可
  if (!entry.isNew) {
    try {
      await apiRemoveCardForm(entry.key, props.card.key)
    } catch {
      return
    }
  }
  entries.value.splice(idx, 1)
  formRefs.delete(entry.key)
  activeKeys.value = activeKeys.value.filter((k) => k !== entry.key)
}

watch(() => props.card.key, () => {
  hydrated.value = false
  load()
}, { immediate: true })
</script>

<template>
  <Card :bordered="false" :loading="loading && !hydrated" class="g-cfg-card">
    <template #title>
      <div class="g-cfg-head">
        <span class="g-cfg-title">{{ cardTitle }}</span>
        <span v-if="card.desc" class="g-cfg-desc">{{ card.desc }}</span>
      </div>
    </template>

    <template #extra>
      <Space>
        <Button v-if="card.allowAdd" size="small" @click="openAdd">
          <GIcon icon="ant-design:plus-outlined" :size="12" />
          <span class="g-btn-text">{{ card.addBtnText || '新增' }}</span>
        </Button>
        <Button size="small" :loading="loading" :disabled="saving" @click="load">
          <GIcon icon="ant-design:reload-outlined" :size="13" />
        </Button>
        <Button type="primary" size="small" :loading="saving" @click="save">保存</Button>
      </Space>
    </template>

    <Empty v-if="hydrated && !entries.length" description="暂无配置项" />

    <Collapse v-else-if="hydrated" v-model:activeKey="activeKeys" class="g-kf-collapse">
      <CollapsePanel v-for="entry in entries" :key="entry.key" :forceRender="false">
        <template #header>
          <span class="g-kf-title">{{ entryTitle(entry) }}</span>
        </template>

        <template v-if="card.allowDel && entry.key !== 'default'" #extra>
          <Popconfirm
            title="删除后不可恢复，确定删除？"
            ok-text="删除"
            cancel-text="取消"
            @confirm="removeEntry(entry)"
          >
            <Button type="text" danger size="small" @click.stop>
              <GIcon icon="ant-design:delete-outlined" :size="13" />
            </Button>
          </Popconfirm>
        </template>

        <SchemaForm
          :ref="(el: any) => setFormRef(entry.key, el)"
          :schemas="card.schemas"
          :data="entry.data"
        />
      </CollapsePanel>
    </Collapse>

    <Modal
      v-model:open="addOpen"
      :title="card.addBtnText || '新增'"
      :ok-text="promptProps.okText || '添加'"
      cancel-text="取消"
      destroy-on-close
      @ok="confirmAdd"
    >
      <Form ref="addFormRef" :model="{ value: addValue }" layout="vertical">
        <FormItem :label="promptProps.content || '请输入标识：'" name="value" :rules="addRules">
          <Input
            v-model:value="addValue"
            :placeholder="promptProps.placeholder || '请输入'"
            allowClear
            @pressEnter="confirmAdd"
          />
        </FormItem>
      </Form>
    </Modal>
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

.g-btn-text {
  margin-left: 4px;
}

.g-kf-title {
  font-size: 13px;
  font-weight: 500;
}
</style>
