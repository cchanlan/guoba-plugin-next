<script setup lang="ts">
/**
 * 插件的更新日志 + 选版本回滚。
 *
 * 原来的回滚只能退回「本次运行内那次更新之前」——重启一次入口就没了，更新了三个版本也只能整段退。
 * 这里把提交历史直接摊在页面上，回滚变成「挑一条提交 reset 过去」，于是：
 * - 重启之后照样能回滚，因为选项来自 `git log` 而不是内存里的记录；
 * - 想退几个版本就退几个版本。
 *
 * 数据**不联网**：待更新那段是上次「检查更新」fetch 到的东西，所以头部一定要写清上次检查时间，
 * 免得用户以为看到的就是远端最新。
 */
import { computed, ref } from 'vue'
import { Alert, Button, Checkbox, Modal, Skeleton, Tag, Tooltip, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiPluginGitLog, apiPluginUpdateRollback, type GitCommit, type PluginGitLog } from '@/api'
import { sameCommit, sinceText } from '../gitText'

const emit = defineEmits<{ refresh: []; check: [name: string] }>()

const open = ref(false)
const loading = ref(false)
const name = ref('')
const data = ref<PluginGitLog | null>(null)
/** 有本地改动时，回滚要不要把改动一起丢掉。每次打开都重新问 */
const discardLocal = ref(false)
/** 正在回滚的目标 hash，用来只给那一行转圈 */
const rolling = ref('')

/** 一键退回的目标（上次更新 / 上次回滚之前的位置） */
const rollbackTo = computed(() => data.value?.rollbackTo ?? null)

/** 上次那一步是更新还是回滚，决定按钮叫什么 */
const rollbackToText = computed(() => {
  const rec = rollbackTo.value
  if (!rec) return ''
  return rec.via === 'rollback' ? `撤销回滚，回到 ${rec.short}` : `退回更新前的 ${rec.short}`
})

async function load() {
  loading.value = true
  try {
    data.value = await apiPluginGitLog(name.value)
  } catch {
    // 报错交给全局拦截器提示，这里只负责别把旧数据留在弹窗里
    data.value = null
  } finally {
    loading.value = false
  }
}

function openLog(pluginName: string) {
  name.value = pluginName
  data.value = null
  discardLocal.value = false
  rolling.value = ''
  open.value = true
  load()
}

/** 是不是当前 HEAD 那条 */
function isHead(c: GitCommit) {
  return sameCommit(c.hash, data.value?.shortCommit)
}

/** 是不是一键退回的那条 —— 列表里标一下，用户不用记 hash */
function isRollbackTarget(c: GitCommit) {
  return sameCommit(c.hash, rollbackTo.value?.commit)
}

/** 回滚前先说清会丢什么。dirty 且没勾「丢弃改动」就直接拦住，别让 git 报一句英文错误了事 */
function confirmTo(c: GitCommit | null) {
  const info = data.value
  if (!info) return
  if (info.dirty && !discardLocal.value) {
    message.warning(`${name.value} 有 ${info.changed.length} 个文件被改过，先勾上「连本地改动一起丢掉」`)
    return
  }
  const target = c ? c.hash : (rollbackTo.value?.short ?? '')
  // 待更新列表里的提交是「还没到过的版本」，那是往前跳，不叫回滚
  const forward = !!c && info.pending.some((p) => sameCommit(p.hash, c.hash))
  const parts = [
    c?.subject || '',
    forward
      ? `会把 ${name.value} 的代码 reset 到这个提交，后面那些更新先不合进来；这条路不会自动装依赖，要装就走「更新插件」。`
      : `会把 ${name.value} 的代码 reset 到这个提交，装上的依赖不动，重启后生效。`,
  ]
  if (info.dirty) parts.push(`本地 ${info.changed.length} 个文件的改动会被丢掉，找不回来。`)
  Modal.confirm({
    title: `把 ${name.value} ${forward ? '切换' : '回滚'}到 ${target}？`,
    content: parts.filter(Boolean).join(' '),
    okText: forward ? '切换' : '回滚',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      rolling.value = c ? c.hash : 'last'
      try {
        await apiPluginUpdateRollback({
          name: name.value,
          commit: c ? c.hash : undefined,
          discardLocal: discardLocal.value,
        })
        emit('refresh')
        // HEAD 变了，重新读一遍：当前版本、待更新数量、能不能撤销回滚全都不一样了
        await load()
      } finally {
        rolling.value = ''
      }
    },
  })
}

/** 去检查更新。两个弹窗叠着不好看，把这个关掉，让更新面板接手 */
function toCheck() {
  open.value = false
  emit('check', name.value)
}

defineExpose({ openLog })
</script>

<template>
  <Modal v-model:open="open" :title="`更新日志 · ${name}`" :width="620" :footer="null">
    <Skeleton v-if="loading" active :paragraph="{ rows: 6 }" />

    <template v-else-if="data">
      <!-- 当前状态：装的是哪一版、有没有落后、上次什么时候检查的 -->
      <div class="g-gl-head">
        <span class="g-gl-branch">
          <GIcon icon="ant-design:branches-outlined" :size="12" />
          {{ data.branch || '游离 HEAD' }}
        </span>
        <code>{{ data.shortCommit }}</code>
        <Tag v-if="data.behind > 0" color="orange">落后 {{ data.behind }} 个提交</Tag>
        <Tag v-if="data.ahead > 0">本地有 {{ data.ahead }} 个未推送提交</Tag>
        <Tooltip v-if="data.dirty" :title="data.changed.map((c) => c.file).join('、')">
          <Tag color="red">{{ data.changed.length }} 个文件有改动</Tag>
        </Tooltip>
        <span class="g-gl-dim">{{ sinceText(data.lastFetchAt) }}</span>
        <Button type="link" size="small" class="g-gl-check" @click="toCheck">检查更新</Button>
      </div>

      <div v-if="rollbackTo" class="g-gl-quick">
        <Button
          size="small"
          danger
          ghost
          :loading="rolling === 'last'"
          @click="confirmTo(null)"
        >
          {{ rollbackToText }}
        </Button>
        <span class="g-gl-dim">面板上次动过这个插件之前，它待在这个提交上</span>
      </div>

      <!-- 待更新：上次检查拉到的新提交，还没合进来。挑一条就是「只更新到这一版」 -->
      <template v-if="data.pending.length">
        <div class="g-gl-label">
          待更新（{{ data.pending.length }}）
          <span class="g-gl-dim">挑中间某条就只更新到那一版</span>
        </div>
        <div class="g-gl-list">
          <div v-for="c in data.pending" :key="`p-${c.hash}`" class="g-gl-item is-pending">
            <div class="g-gl-main">
              <div class="g-gl-subject">{{ c.subject }}</div>
              <div class="g-gl-meta">
                <code>{{ c.hash }}</code>
                <span>{{ c.author }}</span>
                <span>{{ c.date }}</span>
              </div>
            </div>
            <Button size="small" :loading="rolling === c.hash" @click="confirmTo(c)">
              更新到此
            </Button>
          </div>
        </div>
      </template>

      <div class="g-gl-label">
        版本历史（{{ data.commits.length }}）
        <span class="g-gl-dim">挑一条就能回到那一版</span>
      </div>
      <div class="g-gl-list">
        <div
          v-for="c in data.commits"
          :key="c.hash"
          class="g-gl-item"
          :class="{ 'is-head': isHead(c) }"
        >
          <div class="g-gl-main">
            <div class="g-gl-subject">{{ c.subject }}</div>
            <div class="g-gl-meta">
              <code>{{ c.hash }}</code>
              <span>{{ c.author }}</span>
              <span>{{ c.date }}</span>
            </div>
          </div>
          <Tag v-if="isHead(c)" color="green">当前</Tag>
          <Tag v-else-if="isRollbackTarget(c)" color="purple">上次改动前</Tag>
          <Button
            v-if="!isHead(c)"
            size="small"
            :loading="rolling === c.hash"
            @click="confirmTo(c)"
          >
            回到此版本
          </Button>
        </div>
      </div>

      <Alert
        v-if="!data.lastFetchAt"
        type="info"
        show-icon
        class="g-gl-alert"
        message="还没检查过更新，上面只有本地已有的提交"
      />

      <div v-if="data.dirty" class="g-gl-danger">
        <Checkbox v-model:checked="discardLocal">连本地改动一起丢掉</Checkbox>
        <span class="g-gl-dim">
          回滚走的是 git reset --hard，不勾这个就不让回，免得把自己改的代码冲没了
        </span>
      </div>
    </template>

    <Alert v-else type="warning" show-icon message="读不到这个插件的提交历史" />
  </Modal>
</template>

<style scoped>
.g-gl-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-gl-branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.g-gl-head code,
.g-gl-meta code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
}

.g-gl-dim {
  font-size: 12px;
  color: var(--g-text-dim);
}

/* 窄屏上「检查更新」自己占一行，不去挤标签 */
.g-gl-check {
  margin-left: auto;
  padding: 0;
}

.g-gl-quick {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.g-gl-label {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.g-gl-list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--g-border);
  border-radius: 6px;
}

/* 一条提交：标题一行、hash/作者/时间一行、右边跟状态和按钮。
   标题能换行，所以窄屏上不会被按钮压成竖排 */
.g-gl-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--g-border);
}

.g-gl-item:last-child {
  border-bottom: none;
}

.g-gl-item.is-head {
  background: var(--g-bg-soft);
}

.g-gl-item.is-pending .g-gl-subject {
  color: var(--g-text-sub);
}

.g-gl-main {
  flex: 1;
  min-width: 0;
}

.g-gl-subject {
  font-size: 13px;
  line-height: 1.5;
  color: var(--g-text);
  word-break: break-word;
}

.g-gl-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 3px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-gl-item > .ant-tag,
.g-gl-item > .ant-btn {
  flex-shrink: 0;
}

.g-gl-alert {
  margin-top: 12px;
}

.g-gl-danger {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid var(--g-border);
  border-radius: 6px;
}
</style>
