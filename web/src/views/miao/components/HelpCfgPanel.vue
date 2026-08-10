<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Button,
  Card,
  Col,
  Form,
  FormItem,
  Input,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Upload,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import GColorPicker from '@/components/schema-form/components/GColorPicker.vue'
import { miaoHelpIconUrl } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { MiaoHelpCfgBody } from '@/types'

/**
 * 喵喵帮助基础配置。
 * 保存由父组件统一处理（需要和 helpList、icon 一起提交为 FormData）。
 */
const props = defineProps<{
  cfg: MiaoHelpCfgBody
  themeNames: string[]
  saving?: boolean
}>()

const emit = defineEmits<{
  save: []
  'update:icon': [file: File | null]
}>()

const auth = useAuthStore()

const iconTs = ref(Date.now())
const iconPreview = ref('')

const iconUrl = computed(() => iconPreview.value || miaoHelpIconUrl(auth.token, iconTs.value))

const themeOptions = computed(() => props.themeNames.map((n) => ({ label: n, value: n })))

/**
 * theme 字段既可能是 'all' 也可能是皮肤名数组。
 * 这里统一用数组编辑，空数组在后端会被转回 'all'。
 */
const themeValue = computed<string[]>({
  get() {
    const t = props.cfg.theme
    if (t === 'all' || t == null) return []
    return Array.isArray(t) ? t : [t]
  },
  set(val) {
    props.cfg.theme = val.length ? val : 'all'
  },
})

const excludeValue = computed<string[]>({
  get: () => (Array.isArray(props.cfg.themeExclude) ? props.cfg.themeExclude : []),
  set: (val) => {
    props.cfg.themeExclude = val
  },
})

/** 确保 style 对象存在，避免模板里 v-model 写到 undefined 上 */
const style = computed(() => {
  if (!props.cfg.style || typeof props.cfg.style !== 'object') {
    props.cfg.style = {}
  }
  return props.cfg.style
})

const styleFields = [
  { key: 'fontColor', label: '标题字体色' },
  { key: 'descColor', label: '描述字体色' },
  { key: 'contBgColor', label: '内容背景色' },
  { key: 'headerBgColor', label: '头部背景色' },
  { key: 'rowBgColor1', label: '奇数行背景色' },
  { key: 'rowBgColor2', label: '偶数行背景色' },
]

function beforeIconUpload(file: File) {
  if (!/\.(png|jpe?g|webp)$/i.test(file.name)) {
    message.warning('图标需要是 png / jpg / webp 格式')
    return false
  }
  // 交给父组件在保存时一起提交，这里只做本地预览
  emit('update:icon', file)
  iconPreview.value = URL.createObjectURL(file)
  message.success('已选择新图标，点保存后生效')
  // 阻止 antd 自行上传
  return false
}

function resetIcon() {
  emit('update:icon', null)
  iconPreview.value = ''
  iconTs.value = Date.now()
}
</script>

<template>
  <Card :bordered="false" class="g-miao-card">
    <template #title><span class="g-miao-title">基础配置</span></template>
    <template #extra>
      <Button type="primary" size="small" :loading="saving" @click="emit('save')">保存</Button>
    </template>

    <Form layout="vertical">
      <Row :gutter="16">
        <Col :xs="24" :md="12">
          <FormItem label="帮助标题">
            <Input v-model:value="cfg.title" placeholder="喵喵帮助" allowClear />
          </FormItem>
        </Col>
        <Col :xs="24" :md="12">
          <FormItem label="副标题">
            <Input v-model:value="cfg.subTitle" placeholder="Yunzai-Bot & Miao-Plugin" allowClear />
          </FormItem>
        </Col>

        <Col :xs="12" :md="6">
          <FormItem label="列数">
            <InputNumber v-model:value="cfg.columnCount" :min="1" :max="6" class="g-full" />
          </FormItem>
        </Col>
        <Col :xs="12" :md="6">
          <FormItem label="列宽（px）">
            <InputNumber v-model:value="cfg.colWidth" :min="100" :max="600" class="g-full" />
          </FormItem>
        </Col>
        <Col :xs="24" :md="12">
          <FormItem label="内容背景模糊度">
            <Slider v-model:value="style.contBgBlur" :min="0" :max="20" />
          </FormItem>
        </Col>

        <Col :xs="24" :md="12">
          <FormItem label="启用皮肤" extra="留空等于 all，随机使用所有皮肤">
            <Select
              v-model:value="themeValue"
              mode="multiple"
              :options="themeOptions"
              placeholder="不选则使用全部皮肤（all）"
              allowClear
            />
          </FormItem>
        </Col>
        <Col :xs="24" :md="12">
          <FormItem label="排除皮肤">
            <Select
              v-model:value="excludeValue"
              mode="multiple"
              :options="themeOptions"
              placeholder="选择要排除的皮肤"
              allowClear
            />
          </FormItem>
        </Col>
      </Row>

      <div class="g-miao-subtitle">配色</div>
      <Row :gutter="16">
        <Col v-for="f in styleFields" :key="f.key" :xs="24" :sm="12" :lg="8">
          <FormItem :label="f.label">
            <GColorPicker v-model:value="style[f.key]" />
          </FormItem>
        </Col>
      </Row>

      <div class="g-miao-subtitle">帮助图标</div>
      <div class="g-icon-row">
        <img :src="iconUrl" alt="icon" class="g-icon-preview" />
        <div class="g-icon-actions">
          <Space>
            <Upload :before-upload="beforeIconUpload" :show-upload-list="false" accept="image/*">
              <Button>
                <GIcon icon="ant-design:upload-outlined" :size="13" />
                <span class="g-btn-text">选择图标</span>
              </Button>
            </Upload>
            <Button v-if="iconPreview" @click="resetIcon">取消更换</Button>
          </Space>
          <p class="g-tip">
            图标是一张雪碧图，喵喵按 icon 序号从中裁切。替换时请保持原有排列与尺寸。
          </p>
        </div>
      </div>
    </Form>
  </Card>
</template>

<style scoped>
.g-miao-card {
  margin-bottom: 16px;
}

.g-miao-title {
  font-size: 15px;
  font-weight: 600;
}

.g-miao-subtitle {
  margin: 8px 0 14px;
  padding-left: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--g-text-sub);
  border-left: 3px solid var(--g-brand);
}

.g-full {
  width: 100%;
}

.g-tip {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-icon-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.g-icon-preview {
  width: 120px;
  flex-shrink: 0;
  border: 1px solid var(--g-border);
  border-radius: 8px;
  background: var(--g-bg-soft);
}

.g-icon-actions p {
  margin: 8px 0 0;
  max-width: 420px;
}

.g-btn-text {
  margin-left: 5px;
}
</style>
