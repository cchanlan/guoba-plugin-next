<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Alert, Result, Skeleton, Space, Tag } from 'ant-design-vue'
import HelpCfgPanel from './components/HelpCfgPanel.vue'
import HelpListPanel from './components/HelpListPanel.vue'
import ThemePanel from './components/ThemePanel.vue'
import BackupPanel from './components/BackupPanel.vue'
import { apiGetMiaoHelpCfg, apiSaveMiaoHelpCfg } from '@/api'
import type { MiaoHelpCfgBody, MiaoHelpGroup } from '@/types'

/**
 * 喵喵帮助配置页。
 *
 * 保存时后端要求：
 *   helpCfg  → JSON 字符串（会被 JSON.parse）
 *   helpList → JS 字面量源码（会被拼进 `export const helpList = ${helpList}`）
 *   icon     → FormData 里的文件，可选
 * 所以整页共用一次提交，四个面板的保存按钮都走 save()。
 */
const loading = ref(true)
/** 路由存在但接口 404，说明没装 miao-plugin */
const notInstalled = ref(false)
const loadError = ref('')
const saving = ref(false)

const helpCfg = ref<MiaoHelpCfgBody>({})
const helpList = ref<MiaoHelpGroup[]>([])
const themeNames = ref<string[]>([])
const miaoVersion = ref('')
const yunzaiVersion = ref('')

const iconFile = ref<File | null>(null)

const itemCount = computed(() =>
  helpList.value.reduce((sum, g) => sum + (Array.isArray(g.list) ? g.list.length : 0), 0),
)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await apiGetMiaoHelpCfg()
    helpCfg.value = data?.helpCfg ?? {}
    helpList.value = Array.isArray(data?.helpList) ? data.helpList : []
    themeNames.value = Array.isArray(data?.themeNames) ? data.themeNames : []
    miaoVersion.value = data?.miaoVersion ?? ''
    yunzaiVersion.value = data?.yunzaiVersion ?? ''
  } catch (e: any) {
    // 未安装喵喵插件时这些路由压根没注册，拿到的是 404
    if (e?.status === 404 || e?.response?.status === 404) {
      notInstalled.value = true
    } else {
      loadError.value = e?.message || '喵喵帮助配置加载失败'
    }
  } finally {
    loading.value = false
  }
}

/** 清掉列表里的空项，避免写出脏配置 */
function cleanList(list: MiaoHelpGroup[]): MiaoHelpGroup[] {
  return list
    .map((group) => ({
      ...group,
      group: group.group ?? '',
      list: (Array.isArray(group.list) ? group.list : []).filter(
        (item) => (item.title ?? '').trim() || (item.desc ?? '').trim(),
      ),
    }))
    .filter((group) => (group.group ?? '').trim() || group.list.length)
}

async function save() {
  saving.value = true
  try {
    const fd = new FormData()
    fd.append('helpCfg', JSON.stringify(helpCfg.value))
    // JSON 本身就是合法的 JS 字面量，直接当源码用
    fd.append('helpList', JSON.stringify(cleanList(helpList.value), null, 2))
    if (iconFile.value) {
      fd.append('icon', iconFile.value, iconFile.value.name)
    }
    await apiSaveMiaoHelpCfg(fd)
    iconFile.value = null
    await load()
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">喵喵帮助</h2>
      <p class="g-page-desc">自定义 #帮助 图片的样式、命令列表与皮肤。</p>
    </div>

    <Skeleton v-if="loading" active :paragraph="{ rows: 10 }" />

    <Result
      v-else-if="notInstalled"
      status="info"
      title="未检测到 miao-plugin"
      sub-title="安装喵喵插件并重启后即可在这里配置帮助图。"
    />

    <Alert v-else-if="loadError" type="error" show-icon :message="loadError" />

    <template v-else>
      <Space class="g-miao-meta" :size="6" wrap>
        <Tag v-if="miaoVersion" color="#d19f56">喵喵 {{ miaoVersion }}</Tag>
        <Tag v-if="yunzaiVersion">Yunzai {{ yunzaiVersion }}</Tag>
        <Tag>{{ helpList.length }} 个分组 / {{ itemCount }} 条命令</Tag>
      </Space>

      <HelpCfgPanel
        :cfg="helpCfg"
        :theme-names="themeNames"
        :saving="saving"
        @save="save"
        @update:icon="iconFile = $event"
      />

      <HelpListPanel
        :list="helpList"
        :saving="saving"
        @save="save"
        @update:list="helpList = $event"
      />

      <ThemePanel @changed="load" />

      <BackupPanel @restored="load" />
    </template>
  </div>
</template>

<style scoped>
.g-miao-meta {
  margin-bottom: 14px;
}
</style>
