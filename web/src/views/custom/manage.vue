<script setup lang="ts">
/**
 * 扩展页面的管理。
 *
 * 在这里直接建页面、写 HTML / CSS / JS，存到 Bot 的 data 目录（见
 * server/service/both/CustomPageStoreService.js），保存后立刻出现在侧边栏。
 * 插件自带的页面（source 为 plugin）只列出来，内容归插件管，这里不改。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button, Empty, Input, InputNumber, Modal, Select, Spin, Table, Tabs, TabPane, Tag, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import GCodeEditor from '@/components/GCodeEditor.vue'
import {
  apiGetCustomPages,
  apiGetStorePage,
  apiRemoveStorePage,
  apiSaveStorePage,
  type CustomPage,
  type CustomPageSource,
} from '@/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const loading = ref(false)
const pages = ref<CustomPage[]>([])

const columns = [
  { title: '页面', key: 'title' },
  { title: 'id', dataIndex: 'id', key: 'id', width: 160 },
  { title: '来源', key: 'source', width: 190 },
  { title: '排序', dataIndex: 'priority', key: 'priority', width: 80, align: 'center' as const },
  { title: '操作', key: 'action', width: 190, align: 'center' as const },
]

async function load() {
  loading.value = true
  try {
    pages.value = await apiGetCustomPages()
  } finally {
    loading.value = false
  }
}

onMounted(load)

/* ---------------- 编辑器 ---------------- */

const HTML_TPL = `<h3>我的页面</h3>
<p id="tip">在「页面管理」里编辑这段内容。</p>`

const CSS_TPL = `#tip {
  color: var(--g-text-sub);
}`

const JS_TPL = `// 片段模式下和面板同文档，直接操作 DOM 就行
// 接口地址：window.__GUOBA__.apiBase + '/hello'
console.log('页面已加载')`

const API_TPL = `// 可选。导出 init(ctx) 就能注册自己的接口，自带登录鉴权。
// 挂载在 /api/custom/_page/<页面id> 下，如下例即 GET .../hello
export function init(ctx) {
  ctx.registerApi('get', '/hello', (req, res) => {
    res.json({ok: true, code: 0, result: {now: Date.now()}, message: 'ok'})
  })
}`

const FRAME_TPL = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h3>我的页面</h3>
  <p id="tip">这是一个独立的 HTML 文档。</p>
  <script src="script.js"><\/script>
</body>
</html>`

function emptyForm(): CustomPageSource & { create: boolean } {
  return {
    create: true,
    id: '',
    title: '',
    icon: '',
    mode: 'html',
    priority: 100,
    html: HTML_TPL,
    css: CSS_TPL,
    js: JS_TPL,
    api: '',
  }
}

const open = ref(false)
const saving = ref(false)
const activeTab = ref('html')
const form = reactive(emptyForm())

const idInvalid = computed(() => !!form.id && !/^[A-Za-z0-9_-]+$/.test(form.id))

function reset(data?: CustomPageSource) {
  Object.assign(form, emptyForm(), data ? { ...data, create: false } : {})
  activeTab.value = 'html'
}

function create() {
  reset()
  open.value = true
}

async function edit(id: string) {
  try {
    const data = await apiGetStorePage(id)
    reset(data)
    open.value = true
  } catch {
    // 请求层已弹过提示
  }
}

/** 切到 iframe 模式时，如果 HTML 还是片段模板，换成完整文档模板 */
function onModeChange(mode: any) {
  if (mode === 'frame' && (!form.html.trim() || form.html === HTML_TPL)) {
    form.html = FRAME_TPL
  } else if (mode === 'html' && form.html === FRAME_TPL) {
    form.html = HTML_TPL
  }
}

async function save() {
  if (!form.id.trim()) return message.warn('请填写页面 id')
  if (idInvalid.value) return message.warn('页面 id 只允许字母、数字、下划线和中划线')
  if (!form.title.trim()) return message.warn('请填写页面标题')
  saving.value = true
  try {
    await apiSaveStorePage({ ...form })
    open.value = false
    // 侧边栏要跟着变
    await auth.loadUserInfo()
    await load()
  } finally {
    saving.value = false
  }
}

function remove(page: any) {
  Modal.confirm({
    title: `删除页面「${page.title}」？`,
    content: '页面文件会从磁盘上一起删掉，不可恢复。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await apiRemoveStorePage(page.id)
      await auth.loadUserInfo()
      await load()
    },
  })
}

function visit(page: any) {
  router.push(`/custom/${page.id}`)
}
</script>
<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">页面管理</h2>
      <p class="g-page-desc">
        在这里建自己的页面，写好 HTML / CSS / JS 保存，侧边栏「扩展页面」下就能打开。
        插件自带的页面也列在这里，但内容由插件维护。
      </p>
    </div>

    <div class="g-manage-bar">
      <Button type="primary" @click="create">
        <template #icon><GIcon icon="ant-design:plus-outlined" /></template>
        新建页面
      </Button>
      <Button :loading="loading" @click="load">刷新</Button>
    </div>

    <Table
      :columns="columns"
      :data-source="pages"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="middle"
    >
      <template #emptyText>
        <Empty description="还没有任何扩展页面，点「新建页面」开始" />
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'title'">
          <span class="g-manage-title">
            <GIcon :icon="record.icon || 'ant-design:file-text-outlined'" :size="16" />
            <a @click="visit(record)">{{ record.title }}</a>
          </span>
        </template>

        <template v-else-if="column.key === 'source'">
          <Tag v-if="record.source === 'store'" color="green">面板创建</Tag>
          <Tag v-else color="blue">插件 {{ record.pluginName }}</Tag>
        </template>

        <template v-else-if="column.key === 'action'">
          <Button type="link" size="small" @click="visit(record)">打开</Button>
          <template v-if="record.source === 'store'">
            <Button type="link" size="small" @click="edit(record.id)">编辑</Button>
            <Button type="link" size="small" danger @click="remove(record)">删除</Button>
          </template>
          <span v-else class="g-manage-tip">插件维护</span>
        </template>
      </template>
    </Table>

    <Modal
      v-model:open="open"
      :title="form.create ? '新建页面' : `编辑「${form.title || form.id}」`"
      :confirm-loading="saving"
      :width="820"
      ok-text="保存"
      cancel-text="取消"
      @ok="save"
    >
      <div class="g-manage-form">
        <div class="g-manage-row">
          <label class="g-manage-label">页面 id</label>
          <Input
            v-model:value="form.id"
            :disabled="!form.create"
            :status="idInvalid ? 'error' : ''"
            placeholder="my-page，字母数字下划线中划线"
          />
        </div>
        <div class="g-manage-row">
          <label class="g-manage-label">标题</label>
          <Input v-model:value="form.title" placeholder="显示在侧边栏上的名字" />
        </div>
        <div class="g-manage-row">
          <label class="g-manage-label">图标</label>
          <Input v-model:value="form.icon" placeholder="emoji（📊）或 iconify 名（ant-design:bar-chart-outlined）" />
        </div>
        <div class="g-manage-row">
          <label class="g-manage-label">渲染方式</label>
          <Select v-model:value="form.mode" @change="onModeChange">
            <Select.Option value="html">片段 —— 注入面板，继承主题样式</Select.Option>
            <Select.Option value="frame">独立页 —— iframe 嵌完整 HTML，互不干扰</Select.Option>
          </Select>
        </div>
        <div class="g-manage-row">
          <label class="g-manage-label">排序</label>
          <InputNumber v-model:value="form.priority" :min="1" :max="9999" />
          <span class="g-manage-tip">数字越小越靠前</span>
        </div>
      </div>

      <Tabs v-model:activeKey="activeTab" size="small">
        <TabPane key="html" :tab="form.mode === 'frame' ? 'HTML 文档' : 'HTML 片段'">
          <GCodeEditor v-model="form.html" :rows="15" />
          <p class="g-manage-hint">
            <template v-if="form.mode === 'frame'">
              完整的 HTML 文档，自己 <code>&lt;link href="style.css"&gt;</code> /
              <code>&lt;script src="script.js"&gt;</code> 引下面两个标签页的内容。
            </template>
            <template v-else>
              一段 HTML，会注入到面板里，样式跟着面板主题走。
            </template>
          </p>
        </TabPane>
        <TabPane key="css" tab="CSS">
          <GCodeEditor v-model="form.css" :rows="15" />
        </TabPane>
        <TabPane key="js" tab="JS">
          <GCodeEditor v-model="form.js" :rows="15" />
        </TabPane>
        <TabPane key="api" tab="接口 (可选)">
          <GCodeEditor v-model="form.api" :rows="15" :placeholder="API_TPL" />
          <p class="g-manage-hint">
            导出 <code>init(ctx)</code> 就能注册接口，挂在
            <code>/api/custom/_page/{{ form.id || '页面id' }}</code> 下，自动带登录鉴权。
            这段代码在 Bot 进程里执行，跟插件同权限，只写你自己清楚的逻辑。
          </p>
        </TabPane>
      </Tabs>
    </Modal>
  </div>
</template>

<style scoped>
.g-manage-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.g-manage-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.g-manage-tip {
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-manage-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}

.g-manage-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.g-manage-label {
  flex: none;
  width: 66px;
  color: var(--g-text-sub);
  font-size: 13px;
  text-align: right;
}

.g-manage-hint {
  margin: 8px 0 0;
  color: var(--g-text-dim);
  font-size: 12px;
  line-height: 1.7;
}

.g-manage-hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--g-bg-soft);
  font-size: 12px;
}
</style>
