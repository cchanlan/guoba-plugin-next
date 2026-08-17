<script setup lang="ts">
/**
 * 备份管理：服务器上已有的包，可下载 / 还原 / 删除，也能把别的机器上的包上传进来。
 */
import { computed, onMounted, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiBackupList,
  apiBackupRemove,
  apiBackupUpload,
  backupDownloadUrl,
  type BackupFile,
} from '@/api'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { formatBytes } from '@/utils/format'

const emit = defineEmits<{ restore: [string] }>()

const appStore = useAppStore()
const auth = useAuthStore()
/** 手机上五列表格挤不下，包名会被压成一列竖排的字 —— 换成卡片 */
const isMobile = computed(() => appStore.isMobile)
const list = ref<BackupFile[]>([])
const loading = ref(false)
const uploading = ref(false)
const uploadEl = ref<HTMLInputElement | null>(null)

const columns = [
  { title: '备份包', key: 'name', width: 280 },
  { title: '内容', key: 'summary', width: 190 },
  { title: '大小', key: 'size', width: 100 },
  { title: '时间', key: 'mtime', width: 160 },
  { title: '操作', key: 'op', width: 200 },
]

async function load() {
  loading.value = true
  try {
    list.value = await apiBackupList()
  } catch {
    // 错误已由请求层弹出
  } finally {
    loading.value = false
  }
}

function fmtTime(ms: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function confirmRemove(f: BackupFile) {
  Modal.confirm({
    title: `删除备份包「${f.name}」？`,
    content: '删除后不可恢复，如果还需要请先下载。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      try {
        await apiBackupRemove(f.name)
        message.success('已删除')
        await load()
      } catch {
        // 错误已由请求层弹出
      }
    },
  })
}

function onUploadChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length) void upload(files)
}

async function upload(files: File[]) {
  uploading.value = true
  try {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const saved = await apiBackupUpload(fd)
    message.success(`已上传 ${saved.length} 个备份包`)
    await load()
  } catch {
    // 错误已由请求层弹出（含「不是有效的锅巴备份包」）
  } finally {
    uploading.value = false
  }
}

defineExpose({ load })
onMounted(load)
</script>

<template>
  <div class="g-bk-packs">
    <div class="g-bk-tip">
      <p>
        备份包存在服务器 <code>data/guoba/backups/</code>。搬家时把包下载下来，
        在新机器的这个页面上传，再去「还原」页操作即可 —— 上传时会立刻校验是不是有效的锅巴备份包。
      </p>
    </div>

    <div class="g-bk-bar">
      <a-button size="small" :loading="loading" @click="load">
        <GIcon icon="ant-design:reload-outlined" :size="13" />
        刷新
      </a-button>
      <a-button size="small" :loading="uploading" @click="uploadEl?.click()">
        <GIcon icon="ant-design:upload-outlined" :size="13" />
        上传备份包
      </a-button>
      <input ref="uploadEl" type="file" accept=".zip" multiple hidden @change="onUploadChange" />
    </div>

    <!-- 手机端：卡片列表 -->
    <div v-if="isMobile" class="g-bk-cards">
      <a-spin :spinning="loading">
        <div v-for="f in list" :key="f.name" class="g-bk-card">
          <div class="g-bk-card-name">
            <GIcon icon="ant-design:save-outlined" :size="14" />
            <span>{{ f.name }}</span>
          </div>
          <div v-if="f.summary?.note" class="g-bk-pack-note">{{ f.summary.note }}</div>
          <div v-else-if="!f.summary" class="g-bk-pack-bad">读不出 manifest，可能不是锅巴的包</div>
          <div class="g-bk-card-meta">
            <template v-if="f.summary">
              {{ f.summary.entries }} 个条目 · {{ f.summary.plugins }} 个插件 ·
              原始 {{ formatBytes(f.summary.totalSize) }}<br />
            </template>
            {{ formatBytes(f.size) }} · {{ fmtTime(f.mtime) }}
          </div>
          <div class="g-bk-card-ops">
            <a class="g-bk-op" :href="backupDownloadUrl(f.name, auth.token)">
              <GIcon icon="ant-design:cloud-download-outlined" :size="13" />
              下载
            </a>
            <a-button size="small" @click="emit('restore', f.name)">还原</a-button>
            <a-button size="small" danger @click="confirmRemove(f)">删除</a-button>
          </div>
        </div>
        <a-empty
          v-if="!list.length && !loading"
          :image="false"
          description="还没有备份包，去「新建备份」建一个"
        />
      </a-spin>
    </div>

    <a-table
      v-else
      :data-source="list"
      :columns="columns"
      :pagination="false"
      :loading="loading"
      :scroll="{ x: 930 }"
      row-key="name"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="g-bk-pack-name">
            <GIcon icon="ant-design:save-outlined" :size="14" />
            <span>{{ record.name }}</span>
          </div>
          <div v-if="record.summary?.note" class="g-bk-pack-note">{{ record.summary.note }}</div>
          <div v-else-if="!record.summary" class="g-bk-pack-bad">读不出 manifest，可能不是锅巴的包</div>
        </template>

        <template v-else-if="column.key === 'summary'">
          <template v-if="record.summary">
            {{ record.summary.entries }} 个条目 · {{ record.summary.plugins }} 个插件
            <div class="g-bk-pack-sub">原始 {{ formatBytes(record.summary.totalSize) }}</div>
          </template>
          <span v-else>—</span>
        </template>

        <template v-else-if="column.key === 'size'">{{ formatBytes(record.size) }}</template>

        <template v-else-if="column.key === 'mtime'">{{ fmtTime(record.mtime) }}</template>

        <template v-else-if="column.key === 'op'">
          <a class="g-bk-op" :href="backupDownloadUrl(record.name, auth.token)">
            <GIcon icon="ant-design:cloud-download-outlined" :size="13" />
            下载
          </a>
          <a-button size="small" type="text" @click="emit('restore', record.name)">还原</a-button>
          <a-button size="small" type="text" danger @click="confirmRemove(record)">删除</a-button>
        </template>
      </template>

      <template #emptyText>
        <a-empty :image="false" description="还没有备份包，去「新建备份」建一个" />
      </template>
    </a-table>
  </div>
</template>

<style scoped>
.g-bk-tip {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-bk-tip p {
  margin: 0;
}

.g-bk-tip code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  font-size: 12px;
}

.g-bk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.g-bk-packs :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.g-bk-pack-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  word-break: break-all;
}

.g-bk-pack-note {
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-bk-pack-bad {
  font-size: 12px;
  color: var(--g-danger);
}

.g-bk-pack-sub {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-op {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 8px;
  font-size: 13px;
}

.g-bk-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.g-bk-card {
  padding: 10px 12px;
  border: 1px solid var(--g-border);
  border-radius: 8px;
  background: var(--g-bg-soft);
}

.g-bk-card-name {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-weight: 500;
  /* 包名很长，换行断在任意字符，但一行有整卡片的宽度，不会被压成一列 */
  word-break: break-all;
  line-height: 1.5;
}

.g-bk-card-meta {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--g-text-dim);
}

.g-bk-card-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--g-border);
}

/* 卡片里的「下载」不用再留右边距，交给 flex gap */
.g-bk-card-ops .g-bk-op {
  margin-right: 0;
}

.g-bk-cards :deep(.ant-spin-container) {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
