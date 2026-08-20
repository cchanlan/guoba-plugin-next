<script setup lang="ts">
/**
 * 文件管理。
 *
 * 浏览 / 编辑 Yunzai 根目录下的文件：面包屑 + 列表，文件夹点击进入；单击文本 / 图片
 * 直接预览（代码块按内容宽度居中展示，不占满全宽）；支持上传、新建、重命名、删除。
 * 改动直接落盘。
 *
 * 文件夹的大小和下载都要走完整棵子树，所以都是**点了才做**：列目录时不顺手算大小
 * （`node_modules` 一层就十万个 inode，进目录就卡死），下载则由后端边打包边发。
 */
import { computed, onMounted, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiFileCreate,
  apiFileDelete,
  apiFileDirSize,
  apiFileList,
  apiFileMkdir,
  apiFileRead,
  apiFileRename,
  apiFileSave,
  apiFileUpload,
  fileDownloadDirUrl,
  fileDownloadUrl,
  type FsFile,
} from '@/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

/** 当前目录，相对 Yunzai 根；空串 = 根 */
const currentPath = ref('')
const list = ref<FsFile[]>([])
const loading = ref(false)

/* 预览 / 编辑 */
const viewOpen = ref(false)
const viewMode = ref<'text' | 'image' | ''>('')
const viewPath = ref('')
const viewName = ref('')
const viewContent = ref('')
const editing = ref(false)
const saving = ref(false)

/* 新建 */
const createOpen = ref(false)
const createType = ref<'dir' | 'file'>('dir')
const createName = ref('')

/* 重命名 */
const renameOpen = ref(false)
const renamePath = ref('')
const renameName = ref('')

/* 上传 */
const uploadEl = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

/** 已算出的文件夹占用，key 是相对路径；loading 表示正在算 */
interface DirSize {
  loading: boolean
  size?: number
  files?: number
  dirs?: number
  partial?: boolean
}
const dirSizes = ref<Record<string, DirSize>>({})
/** 「算全部」正在跑 */
const calcAllRunning = ref(false)

const columns = [
  { title: '名称', dataIndex: 'name', key: 'name' },
  { title: '大小', key: 'size', width: 120 },
  { title: '修改时间', key: 'mtime', width: 180 },
  { title: '操作', key: 'op', width: 240 },
]

/** 图片扩展名，单击直接预览 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'])

/** 二进制扩展名：没法在页面里编辑，只能下载 */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'zip', 'gz', 'tar', '7z', 'rar', 'xz', 'bz2',
  'exe', 'dll', 'so', 'bin', 'dat', 'db', 'sqlite', 'sqlite3',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'avi', 'mkv', 'mov', 'webm', 'flac', 'wav',
  'pdf', 'jar', 'pyc', 'class', 'node',
])

/** 文本编辑上限，跟后端 read 的 2MB 一致 */
const MAX_EDIT_SIZE = 2 * 1024 * 1024

/** 能不能在页面里编辑：非目录、不超 2MB、扩展名不是二进制 */
function isEditable(f: FsFile) {
  if (f.isDir) return false
  if (f.size > MAX_EDIT_SIZE) return false
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  return !BINARY_EXTS.has(ext)
}

/** 面包屑，根不显示在列表里 */
const breadcrumbs = computed(() => {
  const parts = currentPath.value ? currentPath.value.split('/') : []
  return parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join('/') }))
})

function isImage(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}


function fmtSize(size: number) {
  if (size >= 1 << 30) return `${(size / (1 << 30)).toFixed(2)} GB`
  if (size >= 1 << 20) return `${(size / (1 << 20)).toFixed(2)} MB`
  if (size >= 1 << 10) return `${(size / (1 << 10)).toFixed(1)} KB`
  return `${size} B`
}

function fmtTime(t: number) {
  if (!t) return ''
  const d = new Date(t * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 当前目录 + 名称 → 相对路径 */
function joinPath(name: string) {
  return currentPath.value ? `${currentPath.value}/${name}` : name
}

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    list.value = await apiFileList(currentPath.value)
  } catch {
    // showError 已关，错误在具体操作里露
  } finally {
    loading.value = false
  }
}

function goBreadcrumb(path: string) {
  currentPath.value = path
  load()
}

/* ---------------- 预览 / 编辑 ---------------- */

/** 单击：文件夹进入，图片直接预览，其余读文本预览 */
async function onOpen(f: FsFile) {
  if (f.isDir) {
    currentPath.value = joinPath(f.name)
    load()
    return
  }
  const rel = joinPath(f.name)
  if (isImage(f.name)) {
    viewMode.value = 'image'
    viewPath.value = rel
    viewName.value = f.name
    viewContent.value = ''
    editing.value = false
    viewOpen.value = true
    return
  }
  try {
    const data = await apiFileRead(rel)
    viewMode.value = 'text'
    viewPath.value = rel
    viewName.value = f.name
    viewContent.value = data.content
    editing.value = false
    viewOpen.value = true
  } catch (e: any) {
    message.error(e?.message ?? '读取失败')
  }
}

/** 操作列的「编辑」按钮：直接进文本编辑态 */
async function onEdit(f: FsFile) {
  if (f.isDir) return
  const rel = joinPath(f.name)
  try {
    const data = await apiFileRead(rel)
    viewMode.value = 'text'
    viewPath.value = rel
    viewName.value = f.name
    viewContent.value = data.content
    editing.value = true
    viewOpen.value = true
  } catch (e: any) {
    message.error(e?.message ?? '读取失败')
  }
}

async function savePreview() {
  saving.value = true
  try {
    await apiFileSave({ path: viewPath.value, content: viewContent.value })
    viewOpen.value = false
    message.success('已保存')
    load()
  } catch {
    // 错误已由请求层弹出
  } finally {
    saving.value = false
  }
}

/** 图片 / 文本下载地址，token 走 query 才能直接进 <img> / <a> */
function fileUrl(rel: string) {
  return fileDownloadUrl(rel, auth.token)
}

/* ---------------- 新建 ---------------- */

function openCreate(type: 'dir' | 'file') {
  createType.value = type
  createName.value = ''
  createOpen.value = true
}

async function submitCreate() {
  const name = createName.value.trim()
  if (!name) {
    message.warning('输入名称')
    return
  }
  try {
    if (createType.value === 'dir') await apiFileMkdir(joinPath(name))
    else await apiFileCreate({ path: joinPath(name) })
    createOpen.value = false
    message.success(createType.value === 'dir' ? '已创建文件夹' : '已创建文件')
    load()
  } catch {
    // 错误已由请求层弹出
  }
}

/* ---------------- 重命名 ---------------- */

function openRename(f: FsFile) {
  renamePath.value = joinPath(f.name)
  renameName.value = f.name
  renameOpen.value = true
}

async function submitRename() {
  const name = renameName.value.trim()
  if (!name) {
    message.warning('输入新名称')
    return
  }
  try {
    await apiFileRename({ path: renamePath.value, newName: name })
    renameOpen.value = false
    message.success('已重命名')
    load()
  } catch {
    // 错误已由请求层弹出
  }
}

/* ---------------- 删除 ---------------- */

function confirmDelete(f: FsFile) {
  Modal.confirm({
    title: f.isDir ? `删除文件夹「${f.name}」？` : `删除文件「${f.name}」？`,
    content: f.isDir ? '文件夹里的内容会一起删掉，且不可恢复。' : '删除后不可恢复。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      try {
        await apiFileDelete(joinPath(f.name))
        message.success('已删除')
        load()
      } catch {
        // 错误已由请求层弹出
      }
    },
  })
}

/* ---------------- 上传 ---------------- */

function onUploadChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length) void uploadFiles(files)
}

async function uploadFiles(files: File[]) {
  uploading.value = true
  try {
    const fd = new FormData()
    fd.set('path', currentPath.value)
    for (const f of files) fd.append('files', f)
    const data = await apiFileUpload(fd)
    message.success(`已上传 ${data.saved.length} 个文件`)
    load()
  } catch {
    // 错误已由请求层弹出
  } finally {
    uploading.value = false
  }
}

function downloadUrl(f: FsFile) {
  return f.isDir
    ? fileDownloadDirUrl(joinPath(f.name), auth.token)
    : fileDownloadUrl(joinPath(f.name), auth.token)
}

/** 当前目录整个打包下载（根目录也能下，包名会是 Yunzai.zip） */
const currentZipUrl = computed(() => fileDownloadDirUrl(currentPath.value, auth.token))

/** 用一个临时 <a> 触发下载：确认之后才走，不能事先写死在 href 上 */
function triggerDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * 下载当前整个目录。这个按钮离「刷新」很近，在根目录上点下去就是十几 G，
 * 所以先问一句。行内那个文件夹的下载是用户指着某个目录点的，不用再确认。
 */
function downloadCurrent() {
  Modal.confirm({
    title: `打包下载「${currentPath.value || 'Yunzai 根目录'}」？`,
    content: '会把这个目录下的所有文件打成一个 zip 边打边传，目录很大时要传很久，浏览器里可以随时取消。',
    okText: '开始下载',
    cancelText: '取消',
    onOk() {
      triggerDownload(currentZipUrl.value)
    },
  })
}

/* ---------------- 文件夹大小 ---------------- */

/** 算一个文件夹：结果按相对路径缓存，重复点不重复算 */
async function calcSize(f: FsFile) {
  const rel = joinPath(f.name)
  if (dirSizes.value[rel]?.loading) return
  dirSizes.value[rel] = { loading: true }
  try {
    const d = await apiFileDirSize(rel)
    dirSizes.value[rel] = { loading: false, ...d }
  } catch {
    // 错误已由请求层弹出，清掉 loading 让用户能重试
    delete dirSizes.value[rel]
  }
}

/** 算当前目录下所有文件夹。同时开 3 个，一个个出结果，不用等全部算完 */
async function calcAllSizes() {
  if (calcAllRunning.value) return
  const queue = list.value.filter((f) => f.isDir && !dirSizes.value[joinPath(f.name)])
  if (!queue.length) return
  calcAllRunning.value = true
  try {
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) await calcSize(f)
      }),
    )
  } finally {
    calcAllRunning.value = false
  }
}

/** 大小列的文字：撞上后端上限时标「≥」，别让不完整的数字冒充准数 */
function dirSizeText(f: FsFile) {
  const d = dirSizes.value[joinPath(f.name)]
  if (!d || d.loading || d.size === undefined) return ''
  return `${d.partial ? '≥ ' : ''}${fmtSize(d.size)}`
}

function dirSizeTitle(f: FsFile) {
  const d = dirSizes.value[joinPath(f.name)]
  if (!d || d.loading || d.size === undefined) return '算这个文件夹占多大'
  const base = `${d.files} 个文件、${d.dirs} 个子文件夹`
  return d.partial ? `${base}（目录太大只数了一部分，实际更多）` : base
}

onMounted(load)
</script>

<template>
  <div class="g-page g-files">
    <div class="g-page-head">
      <h2 class="g-page-title">文件管理</h2>
      <p class="g-page-desc">
        浏览 / 编辑 <b>Yunzai 根目录</b>下的文件，改动直接写到磁盘，请小心操作。
        单击文件可预览，文本编辑限 2MB，二进制文件只能下载。
        文件夹的大小要点「计算」才算，下载文件夹会打包成 zip。
      </p>
    </div>

    <div class="g-files-bar">
      <div class="g-files-crumb">
        <button type="button" class="g-files-crumb-btn is-root" @click="goBreadcrumb('')">Yunzai</button>
        <template v-for="cr in breadcrumbs" :key="cr.path">
          <GIcon icon="ant-design:right-outlined" :size="11" class="g-files-sep" />
          <button type="button" class="g-files-crumb-btn" @click="goBreadcrumb(cr.path)">{{ cr.name }}</button>
        </template>
      </div>

      <div class="g-files-acts">
        <a-button size="small" :loading="loading" @click="load">
          <GIcon icon="ant-design:reload-outlined" :size="13" />
          刷新
        </a-button>
        <a-button size="small" :loading="calcAllRunning" @click="calcAllSizes">
          <GIcon icon="ant-design:calculator-outlined" :size="13" />
          算全部大小
        </a-button>
        <a-button size="small" title="把当前目录整个打包成 zip 下载" @click="downloadCurrent">
          <GIcon icon="ant-design:file-zip-outlined" :size="13" />
          下载当前目录
        </a-button>
        <a-button size="small" :loading="uploading" @click="uploadEl?.click()">
          <GIcon icon="ant-design:upload-outlined" :size="13" />
          上传
        </a-button>
        <a-button size="small" @click="openCreate('dir')">
          <GIcon icon="ant-design:folder-add-outlined" :size="13" />
          新建文件夹
        </a-button>
        <a-button size="small" @click="openCreate('file')">
          <GIcon icon="ant-design:file-add-outlined" :size="13" />
          新建文件
        </a-button>
        <input ref="uploadEl" type="file" multiple hidden @change="onUploadChange" />
      </div>
    </div>

    <a-table
      class="g-files-table"
      :data-source="list"
      :columns="columns"
      :pagination="false"
      row-key="name"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <span
            class="g-files-name"
            :class="{ 'is-dir': record.isDir }"
            :title="record.isDir ? '进入文件夹' : '单击预览'"
            @click="onOpen(record)"
          >
            <GIcon :icon="record.isDir ? 'ant-design:folder-outlined' : 'ant-design:file-outlined'" :size="15" />
            <span>{{ record.name }}</span>
          </span>
        </template>

        <template v-else-if="column.key === 'size'">
          <template v-if="!record.isDir">{{ fmtSize(record.size) }}</template>
          <!-- 文件夹：算过就显示结果（可点重算），没算过给个「计算」 -->
          <a-button
            v-else
            size="small"
            type="text"
            class="g-files-size-btn"
            :loading="dirSizes[joinPath(record.name)]?.loading"
            :title="dirSizeTitle(record)"
            @click="calcSize(record)"
          >
            {{ dirSizeText(record) || '计算' }}
          </a-button>
        </template>

        <template v-else-if="column.key === 'mtime'">
          {{ fmtTime(record.mtime) }}
        </template>

        <template v-else-if="column.key === 'op'">
          <!-- 文件夹也占一个编辑位，保证下载列对齐（文件夹的编辑禁用） -->
          <a-button
            size="small"
            type="text"
            :disabled="record.isDir || !isEditable(record)"
            :title="record.isDir ? '文件夹' : isEditable(record) ? '编辑' : '二进制或超过 2MB，无法在页面编辑'"
            @click="onEdit(record)"
          >
            <GIcon icon="ant-design:edit-outlined" :size="13" />
            编辑
          </a-button>
          <a
            class="g-files-op"
            :href="downloadUrl(record)"
            :title="record.isDir ? '打包成 zip 下载' : '下载'"
          >
            <GIcon
              :icon="record.isDir ? 'ant-design:file-zip-outlined' : 'ant-design:cloud-download-outlined'"
              :size="13"
            />
            下载
          </a>
          <a-button size="small" type="text" @click="openRename(record)">改名</a-button>
          <a-button size="small" type="text" danger @click="confirmDelete(record)">删除</a-button>
        </template>
      </template>

      <template #emptyText>
        <a-empty :image="false" :description="currentPath ? '这个目录是空的' : 'Yunzai 根目录是空的'" />
      </template>
    </a-table>

    <!-- 预览 / 编辑：图片直接看大图，文本按内容宽度居中展示，可切编辑 -->
    <a-modal
      v-model:open="viewOpen"
      :title="viewName"
      :width="viewMode === 'image' ? 'min(90vw, 960px)' : '760px'"
      :footer="null"
      destroy-on-close
    >
      <div class="g-files-preview">
        <template v-if="viewMode === 'image'">
          <img :src="fileUrl(viewPath)" :alt="viewName" class="g-files-img" />
        </template>
        <template v-else-if="viewMode === 'text'">
          <pre v-if="!editing" class="g-files-code">{{ viewContent }}</pre>
          <a-textarea
            v-else
            v-model:value="viewContent"
            :auto-size="{ minRows: 2 }"
            spellcheck="false"
            class="g-files-edit"
          />
        </template>
      </div>

      <div v-if="viewMode === 'text'" class="g-files-view-actions">
        <template v-if="!editing">
          <a-button type="primary" @click="editing = true">
            <GIcon icon="ant-design:edit-outlined" :size="13" />
            编辑
          </a-button>
        </template>
        <template v-else>
          <a-button @click="editing = false">取消</a-button>
          <a-button type="primary" :loading="saving" @click="savePreview">保存</a-button>
        </template>
      </div>
    </a-modal>

    <!-- 新建：就输个名字，窄一点。width 要传数字，antd 才会补 px，字符串无单位会被 CSS 忽略 -->
    <a-modal
      v-model:open="createOpen"
      :title="createType === 'dir' ? '新建文件夹' : '新建文件'"
      :width="300"
      @ok="submitCreate"
    >
      <a-input
        v-model:value="createName"
        :placeholder="createType === 'dir' ? '文件夹名' : '文件名'"
        @press-enter="submitCreate"
      />
    </a-modal>

    <!-- 重命名 -->
    <a-modal v-model:open="renameOpen" title="重命名" :width="300" @ok="submitRename">
      <a-input v-model:value="renameName" @press-enter="submitRename" />
    </a-modal>
  </div>
</template>

<style scoped>
/* antd 4 的按钮是 inline-block + 基线对齐，svg 图标会被顶起来跟文字错位；
   改成 flex 居中，图标和文字才垂直对齐 */
.g-files :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-files-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.g-files-crumb {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.g-files-crumb-btn {
  border: none;
  background: none;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--g-text-sub);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.g-files-crumb-btn:hover {
  background: var(--g-bg-soft);
  color: var(--g-brand);
}

.g-files-crumb-btn.is-root {
  color: var(--g-brand);
  font-weight: 500;
}

.g-files-sep {
  color: var(--g-text-dim);
  flex: none;
}

.g-files-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

.g-files-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  color: var(--g-text);
  font-size: 13px;
}

.g-files-name.is-dir {
  cursor: pointer;
  color: var(--g-brand);
}

.g-files-name:not(.is-dir) {
  cursor: pointer;
}

.g-files-name span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-files-op {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-files-op:hover {
  color: var(--g-brand);
}

/* 大小列的「计算」/ 结果按钮：跟文件的纯文本大小视觉重量接近，别抢眼 */
.g-files-size-btn {
  padding: 0 4px;
  height: auto;
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-files-size-btn:hover {
  color: var(--g-brand);
}

/* 预览区：内容块居中，宽度自适应内容，不占满整个 modal */
.g-files-preview {
  text-align: center;
}

/* 代码块 inline-block，由内容（最长行）决定宽度；超宽内部横向滚动 */
.g-files-code {
  display: inline-block;
  max-width: 100%;
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: var(--g-bg-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  white-space: pre;
  word-break: normal;
}

.g-files-img {
  max-width: 100%;
  max-height: 70vh;
  border-radius: 6px;
  box-shadow: var(--g-shadow);
}

.g-files-edit {
  text-align: left;
  /* 跟预览的 pre 同一套排版：padding / 字号 / 行高一致，高度才对得上；
     auto-size 让高度跟随内容行数，超长时在这里封顶内部滚动 */
  max-height: 60vh;
  overflow-y: auto;
  padding: 10px !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.g-files-view-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
