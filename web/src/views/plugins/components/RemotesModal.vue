<script setup lang="ts">
/**
 * 插件的远端仓库地址（`.git/config` 里的 `remote.<name>.url`）。
 *
 * 用场景：插件当初是从别人的镜像装的，现在想换回自己的 fork；或者 GitHub 连不上要换 gitee。
 * 原来只能进终端 `git remote set-url`，这里把全部 remote 摊开，改完直接写回 git。
 *
 * 只改配置、不联网：保存后要等下次「检查更新 / 更新」才会用到新地址。
 */
import { computed, nextTick, ref } from 'vue'
import { Alert, Button, Input, Modal, Skeleton, Tag, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiPluginAddFetchUrl,
  apiPluginAddPushUrl,
  apiPluginAddRemote,
  apiPluginRemoveFetchUrl,
  apiPluginRemovePushUrl,
  apiPluginRemoveRemote,
  apiPluginRemotes,
  apiPluginSetRemote,
  type PluginRemote,
  type PluginRemotes,
} from '@/api'

const emit = defineEmits<{ refresh: [] }>()

const open = ref(false)
const loading = ref(false)
const name = ref('')
const data = ref<PluginRemotes | null>(null)
/** 每个 remote 的编辑框内容，key 是 remote 名 */
const draft = ref<Record<string, string>>({})
/** 正在保存的 remote 名，用来只给那一行转圈 */
const saving = ref('')
/** 新增：名字 / 地址 / 提交中 */
const newName = ref('')
const newUrl = ref('')
const adding = ref(false)
/** 每条 remote 的「新推送地址」草稿，key 是 remote 名 */
const pushDraft = ref<Record<string, string>>({})
/** 正在加推送地址的 remote 名 */
const pushing = ref('')
/** 每条 remote 的「备用拉取地址」草稿 */
const fetchDraft = ref<Record<string, string>>({})
/** 正在加备用拉取地址的 remote 名 */
const fetching = ref('')
/** 列表容器：加完新 remote 要滚到底，不然它藏在滚动区下面，看着像没加上 */
const listEl = ref<HTMLElement | null>(null)

const canAdd = computed(() => !!newName.value.trim() && !!newUrl.value.trim())

async function load() {
  loading.value = true
  try {
    data.value = await apiPluginRemotes(name.value)
    draft.value = Object.fromEntries(data.value.remotes.map((r) => [r.name, r.url]))
  } catch {
    // 报错交给全局拦截器提示，这里只负责别把旧数据留在弹窗里
    data.value = null
    draft.value = {}
  } finally {
    loading.value = false
  }
}

function openRemotes(pluginName: string) {
  name.value = pluginName
  data.value = null
  draft.value = {}
  saving.value = ''
  newName.value = ''
  newUrl.value = ''
  pushDraft.value = {}
  pushing.value = ''
  fetchDraft.value = {}
  fetching.value = ''
  open.value = true
  load()
}

/** 和原来的地址不一样才让保存，避免手滑点一下也发请求 */
function changed(r: PluginRemote) {
  return (draft.value[r.name] ?? '').trim() !== r.url
}

async function save(r: PluginRemote) {
  const url = (draft.value[r.name] ?? '').trim()
  if (!url) {
    message.warning('仓库地址不能为空')
    return
  }
  saving.value = r.name
  try {
    await apiPluginSetRemote({ name: name.value, remote: r.name, url })
    // 以 git 里实际存下的为准，顺便把输入框回填成保存后的值
    await load()
    emit('refresh')
  } catch {
    // 报错由全局拦截器弹出，这里只负责恢复按钮
  } finally {
    saving.value = ''
  }
}

/** 新增一个 remote。加错了可以用行尾的「删除」撤掉 */
async function add() {
  const remote = newName.value.trim()
  const url = newUrl.value.trim()
  if (!remote || !url) {
    message.warning('名字和地址都要填')
    return
  }
  adding.value = true
  try {
    await apiPluginAddRemote({ name: name.value, remote, url })
    newName.value = ''
    newUrl.value = ''
    await load()
    emit('refresh')
    await nextTick()
    // remote 按字母序排，新加的未必在末尾 —— 直接滚到它那一行
    listEl.value
      ?.querySelector(`[data-remote="${CSS.escape(remote)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  } catch {
    // 报错由全局拦截器弹出
  } finally {
    adding.value = false
  }
}

/** 删 remote 前问一句：删的要是当前分支的上游，更新会立刻没法用 */
function confirmRemove(r: PluginRemote) {
  const upstream = r.name === data.value?.remote
  Modal.confirm({
    title: `删除远端 ${r.name}？`,
    content: upstream
      ? '当前分支的上游正挂在它上面，删掉后「检查更新」就不知道该拉哪儿了。只删 .git/config 里的配置，已经拉下来的代码不受影响。'
      : '只删 .git/config 里的这条配置，已经拉下来的代码不受影响。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      await apiPluginRemoveRemote({ name: name.value, remote: r.name })
      await load()
      emit('refresh')
    },
  })
}

/** 给这个 remote 再挂一条推送地址（`remote set-url --add --push`） */
async function addPush(r: PluginRemote) {
  const url = (pushDraft.value[r.name] ?? '').trim()
  if (!url) {
    message.warning('推送地址不能为空')
    return
  }
  pushing.value = r.name
  try {
    await apiPluginAddPushUrl({ name: name.value, remote: r.name, url })
    pushDraft.value[r.name] = ''
    await load()
    emit('refresh')
  } catch {
    // 报错由全局拦截器弹出
  } finally {
    pushing.value = ''
  }
}

/** 删一条推送地址。后端按序号回原始配置取真值删（展示值是打码的） */
function confirmRemovePush(r: PluginRemote, index: number) {
  Modal.confirm({
    title: `删除这条推送地址？`,
    content: `${r.pushurl[index]} 只会从 .git/config 里删掉，已经推上去的代码不受影响。`,
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      await apiPluginRemovePushUrl({ name: name.value, remote: r.name, index })
      await load()
      emit('refresh')
    },
  })
}

/** 追加一条备用拉取地址。git fetch 仍然只认第一条，这里只是记进配置 */
async function addFetch(r: PluginRemote) {
  const url = (fetchDraft.value[r.name] ?? '').trim()
  if (!url) {
    message.warning('拉取地址不能为空')
    return
  }
  fetching.value = r.name
  try {
    await apiPluginAddFetchUrl({ name: name.value, remote: r.name, url })
    fetchDraft.value[r.name] = ''
    await load()
    emit('refresh')
  } catch {
    // 报错由全局拦截器弹出
  } finally {
    fetching.value = ''
  }
}

/** 删一条备用拉取地址（第一条是在用的，不给删） */
function confirmRemoveFetch(r: PluginRemote, index: number) {
  Modal.confirm({
    title: '删除这条备用拉取地址？',
    content: `${r.urls[index]} 只会从 .git/config 里删掉，当前实际拉取用的是第一条，不受影响。`,
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      await apiPluginRemoveFetchUrl({ name: name.value, remote: r.name, index })
      await load()
      emit('refresh')
    },
  })
}

defineExpose({ openRemotes })
</script>

<template>
  <Modal v-model:open="open" :title="`远端仓库 · ${name}`" :width="640" :footer="null">
    <Skeleton v-if="loading" active :paragraph="{ rows: 5 }" />

    <template v-else-if="data">
      <div class="g-rm-head">
        <span class="g-rm-branch">
          <GIcon icon="ant-design:branches-outlined" :size="12" />
          {{ data.branch || '游离 HEAD' }}
        </span>
        <span v-if="data.remote" class="g-rm-dim">
          更新检查走 <code>{{ data.remote }}</code>
        </span>
      </div>

      <div v-if="data.remotes.length" ref="listEl" class="g-rm-list">
        <div v-for="r in data.remotes" :key="r.name" class="g-rm-item" :data-remote="r.name">
          <div class="g-rm-top">
            <span class="g-rm-name">{{ r.name }}</span>
            <Tag v-if="r.name === data.remote" color="blue">当前分支上游</Tag>
            <Button type="text" size="small" danger class="g-rm-del" @click="confirmRemove(r)">
              删除
            </Button>
          </div>
          <div class="g-rm-url-label">
            拉取地址
            <span class="g-rm-dim">fetch / 检查更新用它</span>
          </div>
          <div class="g-rm-row">
            <Input
              v-model:value="draft[r.name]"
              placeholder="https://github.com/xxx/xxx.git"
              allow-clear
              @press-enter="changed(r) && save(r)"
            />
            <Button
              type="primary"
              size="small"
              :disabled="!changed(r)"
              :loading="saving === r.name"
              @click="save(r)"
            >
              保存
            </Button>
          </div>
          <!-- 备用拉取地址：git fetch 只认第一条，这些只是记在配置里 -->
          <div
            v-for="(u, i) in r.urls.slice(1)"
            :key="`${r.name}-u-${i}`"
            class="g-rm-push-item"
          >
            <code>{{ u }}</code>
            <Button type="text" size="small" danger @click="confirmRemoveFetch(r, i + 1)">
              删除
            </Button>
          </div>
          <div class="g-rm-push-add">
            <Input
              v-model:value="fetchDraft[r.name]"
              placeholder="备用拉取地址（只有第一条生效）"
              size="small"
              allow-clear
              @press-enter="addFetch(r)"
            />
            <Button
              size="small"
              :disabled="!(fetchDraft[r.name] || '').trim()"
              :loading="fetching === r.name"
              @click="addFetch(r)"
            >
              添加
            </Button>
          </div>
          <div v-if="r.urls.length > 1" class="g-rm-dim g-rm-push-tip">
            git fetch 只拿第一条地址，备用地址不会自动顶上
          </div>
          <div class="g-rm-meta">
            <code v-for="f in r.fetch" :key="f">{{ f }}</code>
          </div>
          <!-- 推送地址：0 条时 push 走上边的 url；加了之后 push 只走这些 -->
          <div class="g-rm-push">
            <div class="g-rm-push-head">
              <span class="g-rm-push-label">推送地址</span>
              <span v-if="!r.pushurl.length" class="g-rm-dim">未单独配置，push 走上边的地址</span>
            </div>
            <div v-for="(p, i) in r.pushurl" :key="`${r.name}-${i}`" class="g-rm-push-item">
              <code>{{ p }}</code>
              <Button type="text" size="small" danger @click="confirmRemovePush(r, i)">
                删除
              </Button>
            </div>
            <div class="g-rm-push-add">
              <Input
                v-model:value="pushDraft[r.name]"
                placeholder="https://github.com/xxx/xxx.git（可带账号令牌）"
                size="small"
                allow-clear
                @press-enter="addPush(r)"
              />
              <Button
                size="small"
                :disabled="!(pushDraft[r.name] || '').trim()"
                :loading="pushing === r.name"
                @click="addPush(r)"
              >
                添加
              </Button>
            </div>
            <div v-if="!r.pushurl.length" class="g-rm-dim g-rm-push-tip">
              加第一条后，push 只走这些地址，上边的地址只用于拉取
            </div>
          </div>
        </div>
      </div>

      <Alert v-else type="info" show-icon message="这个插件没有配置任何 remote" />

      <!-- 新增：名字 + 地址，加完就能在上面改地址 / 删掉 -->
      <div class="g-rm-add">
        <div class="g-rm-label">新增远端</div>
        <div class="g-rm-row">
          <Input
            v-model:value="newName"
            placeholder="名字，如 gitee"
            class="g-rm-add-name"
            :maxlength="64"
          />
          <Input
            v-model:value="newUrl"
            placeholder="https://gitee.com/xxx/xxx-plugin.git"
            allow-clear
            @press-enter="add"
          />
          <Button
            type="primary"
            size="small"
            :disabled="!canAdd"
            :loading="adding"
            @click="add"
          >
            添加
          </Button>
        </div>
      </div>

      <p class="g-rm-tip">
        改的只是 <code>.git/config</code> 里的地址，已经拉下来的代码不受影响；下次「检查更新」走新地址。
      </p>
    </template>

    <Alert v-else type="warning" show-icon message="读不到这个插件的 remote 配置" />
  </Modal>
</template>

<style scoped>
.g-rm-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-rm-branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.g-rm-head code,
.g-rm-meta code,
.g-rm-tip code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--g-bg-soft);
}

.g-rm-dim {
  color: var(--g-text-dim);
}

.g-rm-list {
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid var(--g-border);
  border-radius: 6px;
}

.g-rm-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--g-border);
}

.g-rm-item:last-child {
  border-bottom: none;
}

.g-rm-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.g-rm-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text);
}

/* 删除按钮推到行尾，平时不抢视线，悬停才显红 */
.g-rm-del {
  margin-left: auto;
  padding: 0 4px;
}

/* 拉取地址的小标题：跟推送区对称，让「这一条是干什么的」一眼能看出来 */
.g-rm-url-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--g-text-sub);
}

/* 新增区：名字固定宽，地址占满，按钮不缩 */
.g-rm-add {
  margin-top: 12px;
}

.g-rm-label {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text);
}

.g-rm-add-name {
  width: 130px;
  flex-shrink: 0;
}

/* 输入框占满，保存按钮不缩 */
.g-rm-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.g-rm-row :deep(.ant-btn) {
  flex-shrink: 0;
}

.g-rm-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--g-text-dim);
  word-break: break-all;
}

/* 推送地址区：跟 fetch 那行用虚线分开，避免看成同一个东西 */
.g-rm-push {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--g-border);
}

.g-rm-push-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
}

.g-rm-push-label {
  color: var(--g-text-sub);
}

.g-rm-push-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 1px 0;
  font-size: 12px;
  color: var(--g-text-dim);
  word-break: break-all;
}

.g-rm-push-item code {
  flex: 1;
  min-width: 0;
}

.g-rm-push-item :deep(.ant-btn) {
  flex-shrink: 0;
  padding: 0 4px;
}

.g-rm-push-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.g-rm-push-add :deep(.ant-btn) {
  flex-shrink: 0;
}

.g-rm-push-tip {
  margin-top: 4px;
  font-size: 11px;
}

.g-rm-tip {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--g-text-dim);
}
</style>
