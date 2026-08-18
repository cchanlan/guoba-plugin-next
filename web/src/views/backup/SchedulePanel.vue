<script setup lang="ts">
/**
 * 定时自动备份。
 *
 * 定时任务由后端的 node-schedule 挂（Yunzai 自带的依赖，锅巴不额外装包）。自动包的名字是
 * `guoba-backup-auto-*`，保留份数只清理这一类 —— 手动点的和上传进来的包不会被顺手删掉。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import EasyCron from '@/components/schema-form/components/EasyCron.vue'
import { apiBackupSaveSettings, apiBackupScan, apiBackupSettings, type BackupScan } from '@/api'
import { useAppStore } from '@/stores/app'
import { formatBytes } from '@/utils/format'
import EntryPicker from './EntryPicker.vue'
import type { PickerGroup } from './types'

const appStore = useAppStore()
/** 手机上 110px 的标签列会把控件挤没，改成标签在上、控件在下 */
const isMobile = computed(() => appStore.isMobile)

const enable = ref(false)
const cron = ref('0 0 4 * * ?')
const keep = ref(5)
const active = ref(false)
const nextAt = ref('')
/** 'recommend' = 留空由后端按推荐项备份；'custom' = 用下面勾的 keys */
const mode = ref<'recommend' | 'custom'>('recommend')
const keys = ref<string[]>([])

const loading = ref(false)
const saving = ref(false)
const scan = ref<BackupScan | null>(null)
const scanning = ref(false)

const groups = computed<PickerGroup[]>(() => {
  const data = scan.value
  if (!data) return []
  const out: PickerGroup[] = [{ key: 'root', title: 'Bot 本体', entries: data.root.entries }]
  for (const p of data.plugins) {
    out.push({
      key: `plugin:${p.name}`,
      title: p.name,
      subtitle: p.git ? p.branch || '' : '非 git 插件',
      entries: p.entries,
    })
  }
  return out
})

/** 自定义模式下选中的合计体积，提醒别把几个 G 的缓存排进每日任务 */
const pickedSize = computed(() => {
  const set = new Set(keys.value)
  let size = 0
  for (const g of groups.value) for (const e of g.entries) if (set.has(e.key)) size += e.size
  return size
})

async function load() {
  loading.value = true
  try {
    const s = await apiBackupSettings()
    enable.value = s.enable
    cron.value = s.cron || '0 0 4 * * ?'
    keep.value = s.keep || 5
    active.value = !!s.active
    nextAt.value = s.nextAt || ''
    keys.value = s.keys ?? []
    mode.value = keys.value.length ? 'custom' : 'recommend'
    if (mode.value === 'custom') await loadScan()
  } catch {
    // 错误已由请求层弹出
  } finally {
    loading.value = false
  }
}

async function loadScan() {
  if (scan.value || scanning.value) return
  scanning.value = true
  try {
    scan.value = await apiBackupScan()
  } catch {
    // 错误已由请求层弹出
  } finally {
    scanning.value = false
  }
}

async function onModeChange() {
  if (mode.value === 'custom') await loadScan()
}

async function save() {
  if (mode.value === 'custom' && !keys.value.length) {
    message.warning('自定义模式下要至少勾一个条目，或者改回「推荐项」')
    return
  }
  saving.value = true
  try {
    const s = await apiBackupSaveSettings({
      enable: enable.value,
      cron: cron.value,
      keep: keep.value,
      keys: mode.value === 'custom' ? keys.value : [],
    })
    enable.value = s.enable
    cron.value = s.cron
    keep.value = s.keep
    active.value = !!s.active
    nextAt.value = s.nextAt || ''
    keys.value = s.keys ?? []
    message.success(enable.value ? '已保存，定时备份已启用' : '已保存，定时备份已关闭')
  } catch {
    // 错误已由请求层弹出
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="g-bk-sched">
    <div class="g-bk-tip">
      <p>
        到点自动打一个包，名字带 <code>auto</code> 前缀。超出保留份数的<b>只会清理自动备份</b>，
        你手动建的和上传的包不会被删。
      </p>
      <p>Bot 没运行时定时任务不会触发；上一个备份还没跑完时这一次会跳过。</p>
    </div>

    <a-spin :spinning="loading">
      <a-form
        :layout="isMobile ? 'vertical' : 'horizontal'"
        :label-col="isMobile ? undefined : { style: { width: '110px' } }"
        class="g-bk-form"
      >
        <a-form-item label="启用">
          <a-switch v-model:checked="enable" />
          <a-tag v-if="enable && active" color="green">已挂载</a-tag>
          <a-tag v-else-if="enable" color="red">未挂载</a-tag>
          <span v-if="enable && active && nextAt" class="g-bk-hint">
            下次执行：{{ new Date(nextAt).toLocaleString() }}
          </span>
          <span class="g-bk-hint">关掉后已挂的定时任务会立即撤销</span>
        </a-form-item>

        <a-form-item label="备份周期">
          <EasyCron v-model:value="cron" :disabled="!enable" />
        </a-form-item>

        <a-form-item label="保留份数">
          <a-input-number v-model:value="keep" :min="1" :max="100" :precision="0" />
          <span class="g-bk-hint">超出的从旧到新删</span>
        </a-form-item>

        <a-form-item label="备份内容">
          <a-radio-group v-model:value="mode" @change="onModeChange">
            <a-radio value="recommend">推荐项（每次按当时的扫描结果取）</a-radio>
            <a-radio value="custom">自定义勾选</a-radio>
          </a-radio-group>
          <div class="g-bk-hint is-block">
            推荐项 = 体积不大、又不像缓存的那些条目，新装的插件也会自动带上；
            自定义则固定为你勾的那批，插件换了名字就会失效。
          </div>
        </a-form-item>
      </a-form>

      <div v-if="mode === 'custom'" class="g-bk-custom">
        <a-spin :spinning="scanning">
          <EntryPicker v-model="keys" :groups="groups" has-recommend />
        </a-spin>
        <div v-if="pickedSize > 512 * 1024 * 1024" class="g-bk-hint is-warn">
          选了 {{ formatBytes(pickedSize) }}，每天跑一次会很占磁盘，注意保留份数。
        </div>
      </div>

      <div class="g-bk-foot">
        <a-button type="primary" :loading="saving" @click="save">
          <GIcon icon="ant-design:save-outlined" :size="13" />
          保存设置
        </a-button>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.g-bk-tip {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-bk-tip p {
  margin: 0 0 4px;
}

.g-bk-tip code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
  font-size: 12px;
}

.g-bk-form {
  max-width: 720px;
}

.g-bk-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-hint.is-block {
  display: block;
  margin: 4px 0 0;
  line-height: 1.6;
}

.g-bk-hint.is-warn {
  display: block;
  margin: 8px 0 0;
  color: var(--g-danger);
}

.g-bk-custom {
  margin: 4px 0 16px;
}

.g-bk-sched :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

@media (max-width: 768px) {
  .g-bk-hint {
    margin-left: 0;
    display: block;
  }
}
</style>
