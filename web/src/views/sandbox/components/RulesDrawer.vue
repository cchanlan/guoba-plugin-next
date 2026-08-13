<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GIcon from '@/components/GIcon.vue'
import {
  apiSandboxMatch,
  apiSandboxRules,
  type SandboxMatch,
  type SandboxPlugin,
} from '@/api'

const props = defineProps<{
  open: boolean
  /** 输入框里的当前文本，打开抽屉时直接拿它做匹配预览 */
  text: string
  isGroup: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const loading = ref(false)
const plugins = ref<SandboxPlugin[]>([])
const keyword = ref('')

const testText = ref('')
const matching = ref(false)
/** null 表示还没试过，与「试过但没命中」区分开 */
const matched = ref<SandboxMatch[] | null>(null)
const dealtMsg = ref('')

async function load() {
  loading.value = true
  try {
    plugins.value = await apiSandboxRules()
  } finally {
    loading.value = false
  }
}

async function doMatch() {
  const text = testText.value
  if (!text.trim()) {
    matched.value = null
    dealtMsg.value = ''
    return
  }
  matching.value = true
  try {
    const res = await apiSandboxMatch(text, props.isGroup)
    matched.value = res.matched
    dealtMsg.value = res.msg
  } finally {
    matching.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (!plugins.value.length) load()
    testText.value = props.text
    if (props.text.trim()) doMatch()
  },
)

/** 命中的 key 集合，列表里据此高亮 */
const hitKeys = computed(() => new Set((matched.value ?? []).map((m) => m.key)))

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = plugins.value.filter((p) => p.rules.length)
  if (!kw) return list
  return list
    .map((p) => {
      // 插件名命中就整个留下，否则只留匹配的规则
      if (p.name.toLowerCase().includes(kw) || p.key.toLowerCase().includes(kw)) return p
      const rules = p.rules.filter(
        (r) => r.reg.toLowerCase().includes(kw) || r.fnc.toLowerCase().includes(kw),
      )
      return rules.length ? { ...p, rules } : null
    })
    .filter((p): p is SandboxPlugin => p !== null)
})

const ruleCount = computed(() =>
  plugins.value.reduce((sum, p) => sum + p.rules.length, 0),
)

const permText: Record<string, string> = {
  all: '',
  master: '主人',
  owner: '群主',
  admin: '管理',
  'admin.group': '管理',
  'owner.group': '群主',
}
</script>

<template>
  <a-drawer v-model:open="visible" title="插件规则" placement="right" :width="520">
    <div class="g-rules">
      <div class="g-rules-test">
        <a-input-search
          v-model:value="testText"
          placeholder="输入指令测试匹配，如 #帮助"
          :loading="matching"
          enter-button="匹配"
          @search="doMatch"
        />
        <div v-if="matched" class="g-rules-result">
          <template v-if="matched.length">
            <GIcon icon="ant-design:aim-outlined" :size="13" />
            命中 {{ matched.length }} 项，优先级最高的是
            <b>{{ matched[0].name }}({{ matched[0].fnc }})</b>
          </template>
          <template v-else>
            <GIcon icon="ant-design:info-circle-outlined" :size="13" />
            没有插件匹配这句话
          </template>
        </div>
        <div v-if="dealtMsg && dealtMsg !== testText" class="g-rules-dealt">
          预处理后：<code>{{ dealtMsg }}</code>
        </div>
      </div>

      <a-input
        v-model:value="keyword"
        placeholder="搜索插件名、方法名或正则"
        allow-clear
        class="g-rules-search"
      />

      <div class="g-rules-count">
        共 {{ plugins.length }} 个插件 · {{ ruleCount }} 条规则，顺序即匹配优先级
      </div>

      <div class="g-rules-list">
        <div
          v-for="p in filtered"
          :key="p.key"
          class="g-rules-item"
          :class="{ 'is-hit': hitKeys.has(p.key) }"
        >
          <div class="g-rules-head">
            <span class="g-rules-name">{{ p.name || p.key }}</span>
            <a-tag v-if="hitKeys.has(p.key)" color="green">命中</a-tag>
            <span class="g-rules-priority">优先级 {{ p.priority }}</span>
          </div>
          <div v-if="p.dsc && p.dsc !== p.name" class="g-rules-dsc">{{ p.dsc }}</div>
          <div v-for="(r, i) in p.rules" :key="i" class="g-rules-rule">
            <code>{{ r.reg || '(空)' }}</code>
            <span class="g-rules-fnc">{{ r.fnc }}</span>
            <a-tag v-if="permText[r.permission]" color="orange">
              {{ permText[r.permission] }}
            </a-tag>
          </div>
        </div>
        <a-empty v-if="!loading && !filtered.length" description="没有匹配的规则" />
      </div>
    </div>
  </a-drawer>
</template>

<style scoped>
.g-rules-test {
  margin-bottom: 12px;
}

.g-rules-result {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-rules-dealt {
  margin-top: 4px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-rules-search {
  margin-bottom: 8px;
}

.g-rules-count {
  margin-bottom: 10px;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-rules-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.g-rules-item {
  padding: 10px 12px;
  border: 1px solid var(--g-border);
  border-radius: 8px;
}

.g-rules-item.is-hit {
  border-color: var(--g-brand);
  background: var(--g-brand-soft);
}

.g-rules-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.g-rules-name {
  font-weight: 500;
}

.g-rules-priority {
  margin-left: auto;
  color: var(--g-text-dim);
  font-size: 12px;
}

.g-rules-dsc {
  margin-top: 2px;
  color: var(--g-text-sub);
  font-size: 12px;
}

.g-rules-rule {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
}

.g-rules-rule code {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  background: var(--g-bg-soft);
  border-radius: 4px;
  word-break: break-all;
}

.g-rules-fnc {
  flex: none;
  color: var(--g-text-sub);
}
</style>
