<script setup lang="ts">
/**
 * SQLite 浏览器。
 *
 * 库列表由后端扫描 data/ 与 plugins/ 得到（见 DataService.listDatabases）。
 * 表数据分页取，单元格双击就地编辑，另有 SQL 执行入口。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  Button,
  Empty,
  Input,
  Modal,
  Select,
  SelectOption,
  Spin,
  Table,
  Tag,
  Textarea,
  Tooltip,
  message,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiDbColumns,
  apiDbDeleteRow,
  apiDbList,
  apiDbRows,
  apiDbSql,
  apiDbTables,
  apiDbUpdateRow,
  type DbColumn,
  type DbFile,
  type DbTable,
} from '@/api'

const dbs = ref<DbFile[]>([])
const currentDb = ref<string>('')
const tables = ref<DbTable[]>([])
const currentTable = ref<string>('')
const columns = ref<DbColumn[]>([])

const rows = ref<Record<string, any>[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const keyword = ref('')

const loadingDbs = ref(false)
const loadingTables = ref(false)
const loadingRows = ref(false)

/** SQL 弹窗 */
const sqlOpen = ref(false)
const sqlText = ref('')
const sqlRunning = ref(false)
const sqlResult = ref<any>(null)

/** 单元格编辑 */
const editOpen = ref(false)
const editRow = ref<Record<string, any> | null>(null)
const editField = ref('')
const editValue = ref('')
const editSaving = ref(false)

function fmtSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 表格列定义。加一列操作，rowid 隐藏但要留着用于定位 */
const tableColumns = computed(() => {
  const cols = columns.value.map((c) => ({
    title: c.name,
    dataIndex: c.name,
    key: c.name,
    ellipsis: true,
    width: 180,
  }))
  return [
    ...cols,
    { title: '', key: '__action', width: 80, fixed: 'right' as const },
  ]
})

async function loadDbs() {
  loadingDbs.value = true
  try {
    dbs.value = await apiDbList()
    if (dbs.value.length > 0 && !currentDb.value) {
      // 默认选中主库（db.yaml 配的那个）
      currentDb.value = (dbs.value.find((d) => d.primary) ?? dbs.value[0]).path
    }
  } finally {
    loadingDbs.value = false
  }
}

async function loadTables() {
  if (!currentDb.value) return
  loadingTables.value = true
  tables.value = []
  currentTable.value = ''
  rows.value = []
  columns.value = []
  total.value = 0
  try {
    tables.value = await apiDbTables(currentDb.value)
  } finally {
    loadingTables.value = false
  }
}

async function selectTable(name: string) {
  currentTable.value = name
  page.value = 1
  keyword.value = ''
  columns.value = await apiDbColumns(currentDb.value, name)
  await loadRows()
}

async function loadRows() {
  if (!currentDb.value || !currentTable.value) return
  loadingRows.value = true
  try {
    const data = await apiDbRows({
      path: currentDb.value,
      table: currentTable.value,
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value.trim(),
    })
    rows.value = data.rows
    total.value = data.total
  } finally {
    loadingRows.value = false
  }
}

function onTableChange(pagination: any) {
  page.value = pagination.current
  pageSize.value = pagination.pageSize
  loadRows()
}

function openCellEdit(row: Record<string, any>, field: string) {
  const col = columns.value.find((c) => c.name === field)
  if (!col) return
  editRow.value = row
  editField.value = field
  const v = row[field]
  editValue.value = v == null ? '' : String(v)
  editOpen.value = true
}

async function saveCell() {
  if (!editRow.value) return
  const rowid = editRow.value.__rowid
  if (rowid == null) {
    message.error('该表没有 rowid，无法就地编辑，请用 SQL')
    return
  }
  editSaving.value = true
  try {
    await apiDbUpdateRow({
      path: currentDb.value,
      table: currentTable.value,
      rowid,
      data: { [editField.value]: editValue.value },
    })
    editOpen.value = false
    await loadRows()
  } catch {
    // 请求层已提示
  } finally {
    editSaving.value = false
  }
}

function confirmDelRow(row: Record<string, any>) {
  const rowid = row.__rowid
  if (rowid == null) {
    message.error('该表没有 rowid，无法删除，请用 SQL')
    return
  }
  Modal.confirm({
    title: '确认删除这一行？',
    content: '删除后无法恢复。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      await apiDbDeleteRow({ path: currentDb.value, table: currentTable.value, rowid })
      await Promise.all([loadRows(), loadTables()])
    },
  })
}

async function runSql() {
  if (!sqlText.value.trim()) return
  sqlRunning.value = true
  sqlResult.value = null
  try {
    sqlResult.value = await apiDbSql(currentDb.value, sqlText.value.trim())
    // 写操作后刷新，行数可能变了
    if (sqlResult.value?.type === 'exec') {
      await Promise.all([loadTables(), loadRows()])
    }
  } catch (e: any) {
    sqlResult.value = { type: 'error', message: e?.message ?? String(e) }
  } finally {
    sqlRunning.value = false
  }
}

/** SQL 结果的表格列 */
const sqlColumns = computed(() => {
  const cols = sqlResult.value?.columns ?? []
  return cols.map((c: string) => ({
    title: c,
    dataIndex: c,
    key: c,
    ellipsis: true,
  }))
})

watch(currentDb, () => loadTables())

onMounted(async () => {
  await loadDbs()
})
</script>

<template>
  <div class="g-sqlite">
    <!-- 工具栏 -->
    <div class="g-toolbar">
      <Select
        v-model:value="currentDb"
        style="width: 340px"
        :loading="loadingDbs"
        placeholder="选择数据库"
        show-search
      >
        <SelectOption v-for="d in dbs" :key="d.path" :value="d.path">
          <span class="g-db-option">
            <span class="g-db-name">{{ d.name }}</span>
            <Tag v-if="d.primary" color="gold">主库</Tag>
            <span class="g-db-size">{{ fmtSize(d.size) }}</span>
          </span>
        </SelectOption>
      </Select>

      <Button :loading="loadingDbs" @click="loadDbs">
        <GIcon icon="ant-design:reload-outlined" :size="14" />
        <span class="g-btn-text">重新扫描</span>
      </Button>

      <Button :disabled="!currentDb" @click="sqlOpen = true">
        <GIcon icon="ant-design:code-outlined" :size="14" />
        <span class="g-btn-text">执行 SQL</span>
      </Button>

      <div class="g-toolbar-info" v-if="dbs.length">
        找到 {{ dbs.length }} 个数据库
      </div>
    </div>

    <div class="g-body">
      <!-- 左：表列表 -->
      <div class="g-tables">
        <Spin :spinning="loadingTables">
          <div class="g-tables-title">数据表（{{ tables.length }}）</div>
          <div v-if="tables.length" class="g-table-list">
            <div
              v-for="t in tables"
              :key="t.name"
              class="g-table-item"
              :class="{ 'g-table-item-active': currentTable === t.name }"
              @click="selectTable(t.name)"
            >
              <GIcon
                :icon="t.type === 'view'
                  ? 'ant-design:eye-outlined'
                  : 'ant-design:table-outlined'"
                :size="13"
              />
              <span class="g-table-name">{{ t.name }}</span>
              <span class="g-table-count">{{ t.count }}</span>
            </div>
          </div>
          <Empty v-else-if="!loadingTables" description="没有数据表" />
        </Spin>
      </div>

      <!-- 右：表数据 -->
      <div class="g-rows">
        <template v-if="currentTable">
          <div class="g-rows-head">
            <div class="g-rows-title">{{ currentTable }}</div>
            <Input
              v-model:value="keyword"
              placeholder="在所有列中搜索"
              style="width: 240px"
              allowClear
              @pressEnter="(page = 1), loadRows()"
            >
              <template #prefix>
                <GIcon icon="ant-design:search-outlined" :size="13" />
              </template>
            </Input>
          </div>

          <Table
            :columns="tableColumns"
            :data-source="rows"
            :loading="loadingRows"
            row-key="__rowid"
            size="small"
            :scroll="{ x: 'max-content', y: 'calc(100vh - 400px)' }"
            :pagination="{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100', '200'],
              showTotal: (t: number) => `共 ${t} 行`,
            }"
            @change="onTableChange"
          >
            <template #bodyCell="{ column, record, text }">
              <template v-if="column.key === '__action'">
                <Button type="link" size="small" danger @click="confirmDelRow(record)">
                  删除
                </Button>
              </template>
              <template v-else>
                <!-- 双击就地编辑，单击不动免得误触 -->
                <div
                  class="g-cell"
                  :title="String(text ?? '')"
                  @dblclick="openCellEdit(record, column.key as string)"
                >
                  <span v-if="text === null" class="g-null">NULL</span>
                  <span v-else>{{ text }}</span>
                </div>
              </template>
            </template>
          </Table>

          <p class="g-hint">双击单元格可编辑</p>
        </template>

        <Empty v-else description="选择左侧的表查看数据" />
      </div>
    </div>

    <!-- SQL 弹窗 -->
    <Modal v-model:open="sqlOpen" title="执行 SQL" width="820px" :footer="null">
      <Textarea
        v-model:value="sqlText"
        :rows="6"
        placeholder="SELECT * FROM sqlite_master LIMIT 10"
        class="g-sql-input"
      />
      <div class="g-sql-actions">
        <Button type="primary" :loading="sqlRunning" @click="runSql">
          <GIcon icon="ant-design:play-circle-outlined" :size="14" />
          <span class="g-btn-text">执行</span>
        </Button>
        <span class="g-sql-db">{{ currentDb }}</span>
      </div>

      <div v-if="sqlResult" class="g-sql-result">
        <template v-if="sqlResult.type === 'error'">
          <pre class="g-sql-error">{{ sqlResult.message }}</pre>
        </template>

        <template v-else-if="sqlResult.type === 'select'">
          <div class="g-sql-meta">
            返回 {{ sqlResult.total }} 行 · 耗时 {{ sqlResult.elapsed }}ms
            <Tag v-if="sqlResult.truncated" color="warning">仅显示前 1000 行</Tag>
          </div>
          <Table
            :columns="sqlColumns"
            :data-source="sqlResult.rows"
            size="small"
            :scroll="{ x: 'max-content', y: 320 }"
            :pagination="{ pageSize: 20 }"
            :row-key="(_: any, i?: number) => i ?? 0"
          />
        </template>

        <template v-else>
          <div class="g-sql-meta">
            执行成功 · 影响 {{ sqlResult.affected ?? 0 }} 行 · 耗时 {{ sqlResult.elapsed }}ms
          </div>
        </template>
      </div>
    </Modal>

    <!-- 单元格编辑 -->
    <Modal
      v-model:open="editOpen"
      :title="`编辑 ${editField}`"
      :confirm-loading="editSaving"
      @ok="saveCell"
    >
      <Textarea v-model:value="editValue" :rows="6" />
      <p class="g-hint">留空会写入空字符串，不是 NULL。</p>
    </Modal>
  </div>
</template>

<style scoped>
.g-sqlite {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.g-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.g-toolbar-info {
  margin-left: auto;
  /* 工具栏按钮多时不许压缩这段文字，否则会被截成半个字 */
  flex: none;
  white-space: nowrap;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-btn-text {
  margin-left: 6px;
}

.g-db-option {
  display: flex;
  align-items: center;
  gap: 8px;
}

.g-db-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.g-db-size {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.g-tables,
.g-rows {
  background: var(--g-bg-card);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  padding: 14px;
}

.g-tables-title {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-table-list {
  max-height: calc(100vh - 320px);
  overflow: auto;
}

.g-table-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-table-item:hover {
  background: var(--g-bg-soft);
}

.g-table-item-active {
  background: var(--g-brand-soft);
  color: var(--g-brand);
  font-weight: 600;
}

.g-table-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-table-count {
  font-size: 11px;
  color: var(--g-text-dim);
}

.g-rows-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.g-rows-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--g-text);
}

.g-cell {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.g-null {
  color: var(--g-text-dim);
  font-style: italic;
}

.g-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-sql-input {
  font-family: var(--g-font-mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 13px;
}

.g-sql-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

.g-sql-db {
  font-size: 12px;
  color: var(--g-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-sql-result {
  margin-top: 14px;
}

.g-sql-meta {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-sql-error {
  margin: 0;
  padding: 10px;
  background: var(--g-bg-soft);
  border: 1px solid var(--g-danger);
  border-radius: 8px;
  font-family: var(--g-font-mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--g-danger);
}

@media (max-width: 1100px) {
  .g-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
