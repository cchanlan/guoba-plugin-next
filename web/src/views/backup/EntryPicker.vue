<script setup lang="ts">
/**
 * 条目勾选器。
 *
 * 新建备份和还原都用它：一组是 Bot 本体，其余每个插件一组。勾选状态由外部持有
 * （key 数组），组件只负责展示和改动。
 *
 * 组内按路径拆成目录树 —— `data/` 之类的大目录被后端拆成了几十个子条目，平铺成一长条
 * 列表根本没法看，折起来点进去选才对。**能勾的最小单位仍是后端给的条目**，目录节点
 * 只是分组，勾它等于勾下面整棵子树。
 */
import { computed, ref } from 'vue'
import GIcon from '@/components/GIcon.vue'
import { formatBytes } from '@/utils/format'
import { KIND_COLOR, KIND_TEXT, type PickerEntry, type PickerGroup, type TreeNode } from './types'

const props = withDefaults(
  defineProps<{
    groups: PickerGroup[]
    modelValue: string[]
    /** 有没有 recommended 信息，决定「只选推荐」按钮显不显示 */
    hasRecommend?: boolean
    disabled?: boolean
  }>(),
  { hasRecommend: false, disabled: false },
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const keyword = ref('')
/** 默认只展开第一组（Bot 本体），插件组太多，全展开一屏放不下 */
const activeKeys = ref<string[]>(props.groups.length ? [props.groups[0].key] : ['root'])
/** 树内的展开状态，目录 key 带组前缀所以所有组共用一个数组也不会串 */
const expanded = ref<string[]>([])
/** 仓库自带的内容（clone 就有的代码和素材）要不要显示。默认显示 —— 想整个插件带走就得能勾到 */
const showTracked = ref(true)

const picked = computed(() => new Set(props.modelValue))

const allEntries = computed(() => props.groups.flatMap((g) => g.entries))

/** 关键字过滤 + 「仓库自带」开关。组名命中关键字时整组都留下 */
const shownGroups = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const base = showTracked.value
    ? props.groups
    : props.groups.map((g) => ({...g, entries: g.entries.filter((e) => e.kind !== 'tracked')}))
  if (!kw) return base
  return base
    .map((g) => {
      if (g.title.toLowerCase().includes(kw)) return g
      return {...g, entries: g.entries.filter((e) => e.rel.toLowerCase().includes(kw))}
    })
    .filter((g) => g.entries.length > 0)
})

function sortNodes(list: TreeNode[]) {
  return [...list].sort((a, b) => {
    // 目录排前面，同类按名字
    const ad = a.children ? 0 : 1
    const bd = b.children ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, 'zh')
  })
}

/** 自底向上累加体积，并把只有一个孩子的目录压平 */
function rollup(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (!n.children) return n
    const children = rollup(n.children)
    // 只有一个孩子的目录没有点进去的价值，名字接起来把孩子提上来
    if (children.length === 1) {
      const only = children[0]
      return { ...only, name: `${n.name}/${only.name}` }
    }
    let size = 0
    let files = 0
    let leaves = 0
    let truncated = false
    for (const c of children) {
      size += c.size
      files += c.files
      leaves += c.leaves
      truncated = truncated || c.truncated
    }
    return { ...n, children: sortNodes(children), size, files, leaves, truncated }
  })
}

function buildTree(groupKey: string, entries: PickerEntry[]) {
  const roots: TreeNode[] = []
  const dirs = new Map<string, TreeNode>()

  for (const e of entries) {
    const segs = e.rel === '.' ? ['.'] : e.rel.split('/').filter(Boolean)
    let list = roots
    let prefix = ''
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segs[i]}` : segs[i]
      let dir = dirs.get(prefix)
      if (!dir) {
        dir = {
          key: `dir:${groupKey}|${prefix}`,
          name: segs[i],
          children: [],
          size: 0,
          files: 0,
          truncated: false,
          leaves: 0,
        }
        dirs.set(prefix, dir)
        list.push(dir)
      }
      list = dir.children!
    }
    list.push({
      key: e.key,
      name: e.rel === '.' ? '（整个目录）' : segs[segs.length - 1],
      entry: e,
      size: e.size,
      files: e.files,
      truncated: !!e.truncated,
      leaves: 1,
    })
  }

  return sortNodes(rollup(roots))
}

function collectDirs(nodes: TreeNode[], out: string[] = []) {
  for (const n of nodes) {
    if (!n.children) continue
    out.push(n.key)
    collectDirs(n.children, out)
  }
  return out
}

/** 过滤后的组 + 它的树。leafKeys 是「这棵树里现在看得见的条目」，勾选取交集时要用 */
const views = computed(() =>
  shownGroups.value.map((g) => {
    const tree = buildTree(g.key, g.entries)
    return { group: g, tree, leafKeys: g.entries.map((e) => e.key), dirKeys: collectDirs(tree) }
  }),
)

/** 搜索时全展开，不然命中的条目藏在折叠的目录里等于没搜 */
const expandedKeys = computed(() =>
  keyword.value.trim() ? views.value.flatMap((v) => v.dirKeys) : expanded.value,
)

const stat = computed(() => {
  let size = 0
  let files = 0
  let truncated = false
  for (const e of allEntries.value) {
    if (!picked.value.has(e.key)) continue
    size += e.size
    files += e.files
    truncated = truncated || !!e.truncated
  }
  return { count: picked.value.size, size, files, truncated }
})

function groupStat(group: PickerGroup) {
  let size = 0
  let count = 0
  for (const e of group.entries) {
    if (!picked.value.has(e.key)) continue
    count++
    size += e.size
  }
  return { count, size }
}

function set(keys: Iterable<string>) {
  emit('update:modelValue', [...new Set(keys)])
}

function toggleLeaf(entry: PickerEntry) {
  const next = new Set(props.modelValue)
  if (next.has(entry.key)) next.delete(entry.key)
  else next.add(entry.key)
  set(next)
}

/**
 * a-tree 的勾选回调给的是「这棵树里所有勾上的节点」，含目录节点，也**不含**被搜索过滤掉的
 * 条目 —— 直接拿它当结果会把看不见的勾选清掉。所以只在本树可见条目的范围内替换。
 */
function onCheck(view: { leafKeys: string[] }, keys: unknown) {
  const list = (Array.isArray(keys) ? keys : (keys as { checked?: unknown[] })?.checked ?? []) as string[]
  const visible = new Set(view.leafKeys)
  const next = new Set(props.modelValue)
  for (const k of view.leafKeys) next.delete(k)
  for (const k of list) if (visible.has(k)) next.add(k)
  set(next)
}

function checkedOf(view: { leafKeys: string[] }) {
  return view.leafKeys.filter((k) => picked.value.has(k))
}

function onExpand(keys: unknown) {
  expanded.value = keys as string[]
}

function onTitleClick(node: TreeNode) {
  if (props.disabled) return
  // 目录点标题就展开/收起，叶子点标题就等于点勾选框 —— 不用非得瞄准那个小方块
  if (node.children) {
    const cur = new Set(expandedKeys.value)
    if (cur.has(node.key)) cur.delete(node.key)
    else cur.add(node.key)
    expanded.value = [...cur]
  } else if (node.entry) {
    toggleLeaf(node.entry)
  }
}

/** 只勾当前过滤结果里的这些，避免搜索时误伤看不见的条目 */
function selectShown() {
  const next = new Set(props.modelValue)
  for (const v of views.value) for (const k of v.leafKeys) next.add(k)
  set(next)
}

function selectRecommended() {
  set(allEntries.value.filter((e) => e.recommended).map((e) => e.key))
}

function clearAll() {
  set([])
}

function toggleGroup(group: PickerGroup, checked: boolean) {
  const next = new Set(props.modelValue)
  for (const e of group.entries) {
    if (checked) next.add(e.key)
    else next.delete(e.key)
  }
  set(next)
}

function groupChecked(group: PickerGroup) {
  return group.entries.length > 0 && group.entries.every((e) => picked.value.has(e.key))
}

function groupIndeterminate(group: PickerGroup) {
  const n = groupStat(group).count
  return n > 0 && n < group.entries.length
}

/**
 * 插件组当前是哪种备份方式。
 *
 * 这就是「.git 克隆 还是 直接带走整个插件」的区别，而且不用额外开关 —— 勾满了就是整个
 * 插件都在包里（还原时不需要 clone，网络不行也能搬家），只勾一部分就是老路子：
 * 记下仓库地址，还原时 clone 回来再把配置盖上去。
 */
function groupMode(group: PickerGroup) {
  if (!group.key.startsWith('plugin:')) return null
  const {count} = groupStat(group)
  const all = group.entries.length
  if (all && count === all) return {text: '整个插件带走', color: 'green'}
  if (count > 0) return {text: '还原时 clone + 盖配置', color: 'blue'}
  return {text: '不备份文件，还原时 clone', color: 'default'}
}
</script>

<template>
  <div class="g-bk-picker">
    <div class="g-bk-picker-bar">
      <a-input
        v-model:value="keyword"
        allow-clear
        size="small"
        placeholder="搜索路径 / 插件名"
        class="g-bk-search"
      >
        <template #prefix>
          <GIcon icon="ant-design:search-outlined" :size="12" />
        </template>
      </a-input>
      <div class="g-bk-picker-acts">
        <a-button v-if="hasRecommend" size="small" :disabled="disabled" @click="selectRecommended">
          只选推荐
        </a-button>
        <a-button size="small" :disabled="disabled" @click="selectShown">
          {{ keyword.trim() ? '全选结果' : '全选' }}
        </a-button>
        <a-button size="small" :disabled="disabled" @click="clearAll">清空</a-button>
        <a-checkbox v-model:checked="showTracked" class="g-bk-showall">
          显示仓库自带内容
        </a-checkbox>
      </div>
      <div class="g-bk-picker-sum">
        已选 <b>{{ stat.count }}</b> 项 ·
        <b>{{ stat.truncated ? '>' : '' }}{{ formatBytes(stat.size) }}</b> ·
        {{ stat.files }} 个文件
      </div>
    </div>

    <a-alert
      v-if="stat.size > 2 * 1024 * 1024 * 1024"
      type="warning"
      show-icon
      class="g-bk-picker-warn"
      message="选中的内容超过 2 GB，打包会比较慢且占磁盘，建议只留配置和数据"
    />

    <a-collapse v-model:activeKey="activeKeys" class="g-bk-groups">
      <a-collapse-panel v-for="v in views" :key="v.group.key">
        <template #header>
          <div class="g-bk-ghead" @click.stop>
            <a-checkbox
              v-if="v.group.entries.length"
              :checked="groupChecked(v.group)"
              :indeterminate="groupIndeterminate(v.group)"
              :disabled="disabled"
              @change="toggleGroup(v.group, ($event.target as HTMLInputElement).checked)"
            />
            <a-tag v-else color="green" class="g-bk-gonly" title="这个目录里没有可备份的内容">
              空目录
            </a-tag>
            <span class="g-bk-gtitle">{{ v.group.title }}</span>
            <!-- 勾满 = 整个插件都在包里，还原不用 clone；只勾一部分 = 老路子 -->
            <a-tag v-if="groupMode(v.group)" :color="groupMode(v.group)!.color" class="g-bk-gmode">
              {{ groupMode(v.group)!.text }}
            </a-tag>
            <a-tag v-if="v.group.warn" color="orange">{{ v.group.warn }}</a-tag>
            <span v-if="v.group.subtitle" class="g-bk-gsub">{{ v.group.subtitle }}</span>
            <span v-if="v.group.entries.length" class="g-bk-gstat">
              {{ groupStat(v.group).count }}/{{ v.group.entries.length }}
              <template v-if="groupStat(v.group).size">
                · {{ formatBytes(groupStat(v.group).size) }}
              </template>
            </span>
          </div>
        </template>

        <div v-if="!v.group.entries.length" class="g-bk-empty">
          {{ v.group.emptyHint || '没有需要备份的内容' }}
        </div>
        <a-tree
          v-else
          class="g-bk-tree"
          checkable
          block-node
          :selectable="false"
          :disabled="disabled"
          :tree-data="v.tree"
          :field-names="{ title: 'name', key: 'key', children: 'children' }"
          :checked-keys="checkedOf(v)"
          :expanded-keys="expandedKeys"
          @check="(keys: unknown) => onCheck(v, keys)"
          @expand="onExpand"
        >
          <template #title="node">
            <span class="g-bk-node" @click="onTitleClick(node as TreeNode)">
              <GIcon
                :icon="node.children ? 'ant-design:folder-outlined' : 'ant-design:file-outlined'"
                :size="12"
                class="g-bk-nicon"
              />
              <span class="g-bk-nname">{{ node.name }}</span>
              <a-tag v-if="node.entry?.kind" :color="KIND_COLOR[node.entry.kind] ?? 'default'">
                {{ KIND_TEXT[node.entry.kind] ?? node.entry.kind }}
              </a-tag>
              <span class="g-bk-nsub">
                <template v-if="node.children">{{ node.leaves }} 项 · </template>
                {{ node.truncated ? '>' : '' }}{{ formatBytes(node.size) }} ·
                {{ node.files }} 个文件
              </span>
            </span>
          </template>
        </a-tree>
      </a-collapse-panel>
    </a-collapse>

    <a-empty v-if="!views.length" :image="false" description="没有匹配的条目" />
  </div>
</template>

<style scoped>
.g-bk-picker-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.g-bk-search {
  width: 220px;
}

.g-bk-picker-acts {
  display: flex;
  gap: 6px;
}

.g-bk-picker-sum {
  margin-left: auto;
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-bk-picker-warn {
  margin-bottom: 10px;
}

.g-bk-groups :deep(.ant-collapse-content-box) {
  padding: 4px 12px 8px !important;
}

.g-bk-ghead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.g-bk-gtitle {
  font-weight: 600;
}

/* 顶掉 ant tag 的默认外边距，让它占的位置跟勾选框差不多 */
.g-bk-gonly {
  margin: 0;
  font-size: 11px;
}

.g-bk-gmode {
  margin: 0;
  font-size: 11px;
}

.g-bk-showall {
  margin-left: 4px;
  font-size: 12px;
}

.g-bk-gsub,
.g-bk-gstat {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-gstat {
  margin-left: auto;
}

/* 条目多的组（Bot 本体上百条）滚动，别把页面顶老长 */
.g-bk-tree {
  max-height: 460px;
  overflow: auto;
  background: transparent;
}

/* block-node 下标题占满整行，右侧的体积才能对齐 */
.g-bk-node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.g-bk-nicon {
  flex: none;
  color: var(--g-text-dim);
}

.g-bk-nname {
  font-family: var(--g-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  word-break: break-all;
}

.g-bk-nsub {
  margin-left: auto;
  padding-left: 8px;
  flex: none;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-bk-empty {
  padding: 6px 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

@media (max-width: 768px) {
  .g-bk-search {
    width: 100%;
  }

  .g-bk-picker-sum {
    margin-left: 0;
  }

  .g-bk-gstat {
    margin-left: 0;
  }

  /* 手机上名字和体积挤同一行会把路径压成一列竖排的字，让体积整行换到下面 */
  .g-bk-node {
    flex-wrap: wrap;
  }

  .g-bk-nsub {
    width: 100%;
    margin-left: 0;
    padding-left: 18px;
  }

  .g-bk-tree {
    max-height: 360px;
  }

  /* 窄屏把左右内边距让给路径 */
  .g-bk-groups :deep(.ant-collapse-content-box) {
    padding: 4px 4px 8px !important;
  }
}
</style>
