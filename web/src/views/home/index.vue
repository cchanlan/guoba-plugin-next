<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Card, Col, Modal, Row, Select, Skeleton, Statistic, Tag, message } from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import SystemStatusCard from './components/SystemStatus.vue'
import MsgStatCard from './components/MsgStatCard.vue'
import {
  apiGetCity,
  apiGetCityOptions,
  apiGetCityWeather,
  apiGetHomeData,
  apiGetMsgStat,
  apiGetPlugins,
  apiGetSystemStatus,
  apiSetCity,
  homeRandomImageUrl,
} from '@/api'
import { useAuthStore } from '@/stores/auth'
import { GUOBA_VERSION, IS_V2, YUNZAI_VERSION } from '@/utils/env'
import type { HomeData, MsgStat, SystemStatus } from '@/types'

/** 状态轮询间隔；消息统计变化慢，按 6 倍间隔刷 */
const POLL_INTERVAL = 5000
const MSG_POLL_EVERY = 6

const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const home = ref<HomeData>({})
const weather = ref('')
const pluginCount = ref<number | null>(null)
const heroImg = ref('')
const heroFailed = ref(false)

const status = ref<SystemStatus | null>(null)
const statusLoading = ref(true)
const msgStat = ref<MsgStat | null>(null)
const msgLoading = ref(true)

let timer: number | undefined
let tick = 0
/** 上一轮还没回来就跳过这一轮，避免请求堆积 */
let fetching = false

async function fetchStatus() {
  if (fetching) return
  fetching = true
  try {
    status.value = await apiGetSystemStatus()
  } catch {
    // 轮询失败保留上一次的数据，不清空
  } finally {
    statusLoading.value = false
    fetching = false
  }
}

async function fetchMsgStat() {
  try {
    msgStat.value = await apiGetMsgStat(7)
  } catch {
    // 同上
  } finally {
    msgLoading.value = false
  }
}

function startPolling() {
  stopPolling()
  timer = window.setInterval(() => {
    // 页面不可见时不请求，回到前台由 visibilitychange 补一次
    if (document.hidden) return
    fetchStatus()
    if (++tick % MSG_POLL_EVERY === 0) fetchMsgStat()
  }, POLL_INTERVAL)
}

function stopPolling() {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

function onVisibilityChange() {
  if (!document.hidden) {
    fetchStatus()
    fetchMsgStat()
  }
}

/* ---------------- 天气城市 ---------------- */

const cityModalOpen = ref(false)
const cityOptions = ref<{ value: string; label: string }[]>([])
const cityLoading = ref(false)
const citySaving = ref(false)
const selectedCity = ref<string>()

function loadWeather() {
  apiGetCityWeather()
    .then((res) => {
      // 后端返回的是一句现成的中文描述
      weather.value = typeof res?.weather === 'string' ? res.weather : ''
    })
    .catch(() => {
      weather.value = ''
    })
}

async function openCityModal() {
  cityModalOpen.value = true
  // 两千多个城市，只在首次打开时拉一次
  if (cityOptions.value.length === 0) {
    cityLoading.value = true
    try {
      const [list, current] = await Promise.all([apiGetCityOptions(), apiGetCity()])
      cityOptions.value = (list ?? []).map((name) => ({ value: name, label: name }))
      selectedCity.value = current?.city
    } catch {
      // 拉不到就让用户重开一次，不留半截状态
      cityOptions.value = []
    } finally {
      cityLoading.value = false
    }
  }
}

async function confirmCity() {
  if (!selectedCity.value) {
    cityModalOpen.value = false
    return
  }
  citySaving.value = true
  try {
    await apiSetCity(selectedCity.value)
    cityModalOpen.value = false
    message.success(`天气城市已切换为 ${selectedCity.value}`)
    // 缓存 key 带城市名，换城市即换 key，直接重新拉就是新数据
    loadWeather()
  } finally {
    citySaving.value = false
  }
}

/** 按城市名做子串匹配 */
function filterCity(input: string, option?: { label?: string }) {
  return option?.label?.includes(input.trim()) ?? false
}

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

const botName = computed(() => auth.user?.realName || String(auth.user?.username ?? '主人'))

const stats = computed(() => [
  {
    key: 'friend',
    title: '好友数量',
    value: home.value.friendCount ?? 0,
    icon: 'ant-design:user-outlined',
    color: '#4c8dff',
  },
  {
    key: 'group',
    title: '群聊数量',
    value: home.value.groupCount ?? 0,
    icon: 'ant-design:team-outlined',
    color: '#3cc2a0',
  },
  {
    key: 'cookie',
    title: '公共 Cookie',
    value: home.value.cookieCount ?? 0,
    icon: 'ant-design:key-outlined',
    color: '#d19f56',
  },
  {
    key: 'plugin',
    title: '已装插件',
    value: pluginCount.value ?? 0,
    icon: 'ant-design:appstore-outlined',
    color: '#b57bd8',
  },
])

const shortcuts = [
  { title: '配置管理', desc: '改 Yunzai 的各项设置', path: '/config', icon: 'ant-design:setting-outlined' },
  { title: '插件管理', desc: '安装、卸载、配置插件', path: '/plugins', icon: 'ant-design:appstore-add-outlined' },
  { title: '账号管理', desc: '好友与群聊列表', path: '/account', icon: 'ant-design:contacts-outlined' },
  { title: '关于锅巴', desc: '版本与项目信息', path: '/about', icon: 'ant-design:info-circle-outlined' },
]

onMounted(async () => {
  heroImg.value = homeRandomImageUrl(auth.token, Date.now())

  // 首页数据是主内容，插件数与天气都属于点缀，失败不影响页面
  try {
    home.value = await apiGetHomeData()
  } finally {
    loading.value = false
  }

  apiGetPlugins()
    .then((list) => {
      pluginCount.value = Array.isArray(list) ? list.filter((p) => p.installed).length : 0
    })
    .catch(() => {
      pluginCount.value = null
    })

  loadWeather()

  fetchStatus()
  fetchMsgStat()
  startPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="g-page">
    <Card :bordered="false" class="g-hero">
      <div class="g-hero-inner">
        <div class="g-hero-text">
          <h2 class="g-hero-title">{{ greeting }}，{{ botName }}</h2>
          <p class="g-hero-desc">
            欢迎回到锅巴面板，这里可以管理 Yunzai 的配置、插件与账号。
          </p>
          <div class="g-hero-tags">
            <Tag color="gold">锅巴 v{{ GUOBA_VERSION }}</Tag>
            <Tag>Yunzai {{ YUNZAI_VERSION }}</Tag>
            <Tag v-if="IS_V2" color="orange">V2 兼容模式</Tag>
            <Tag color="blue" class="g-weather-tag" @click="openCityModal">
              <GIcon icon="ant-design:cloud-outlined" :size="12" />
              <span class="g-tag-text">{{ weather || '点击设置天气城市' }}</span>
            </Tag>
          </div>
        </div>

        <img
          v-if="heroImg && !heroFailed"
          :src="heroImg"
          alt=""
          class="g-hero-img"
          @error="heroFailed = true"
        />
      </div>
    </Card>

    <Row :gutter="[16, 16]" class="g-stat-row">
      <Col v-for="item in stats" :key="item.key" :xs="12" :sm="12" :md="6">
        <Card :bordered="false" class="g-stat-card">
          <Skeleton v-if="loading" :paragraph="{ rows: 1 }" active />
          <div v-else class="g-stat-inner">
            <span class="g-stat-icon" :style="{ color: item.color, background: `${item.color}1f` }">
              <GIcon :icon="item.icon" :size="20" />
            </span>
            <Statistic :title="item.title" :value="item.value" />
          </div>
        </Card>
      </Col>
    </Row>

    <SystemStatusCard :status="status" :loading="statusLoading" />

    <MsgStatCard :stat="msgStat" :loading="msgLoading" />

    <h3 class="g-section-title">快捷入口</h3>
    <Row :gutter="[16, 16]">
      <Col v-for="item in shortcuts" :key="item.path" :xs="12" :sm="12" :md="6">
        <Card
          :bordered="false"
          hoverable
          class="g-shortcut"
          @click="router.push(item.path)"
        >
          <GIcon :icon="item.icon" :size="22" class="g-shortcut-icon" />
          <div class="g-shortcut-title">{{ item.title }}</div>
          <div class="g-shortcut-desc">{{ item.desc }}</div>
        </Card>
      </Col>
    </Row>

    <Modal
      v-model:open="cityModalOpen"
      title="设置天气城市"
      ok-text="保存"
      cancel-text="取消"
      :confirm-loading="citySaving"
      @ok="confirmCity"
    >
      <Select
        v-model:value="selectedCity"
        class="g-city-select"
        placeholder="输入城市名搜索，如 广州"
        show-search
        :loading="cityLoading"
        :options="cityOptions"
        :filter-option="filterCity"
      />
      <p class="g-city-tip">数据来自中国天气网，仅支持国内城市。</p>
    </Modal>
  </div>
</template>

<style scoped>
.g-hero {
  margin-bottom: 16px;
  background:
    radial-gradient(circle at 88% 12%, rgba(209, 159, 86, 0.22), transparent 45%),
    var(--g-bg-card);
  overflow: hidden;
}

.g-hero-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

/* flex 子项默认 min-width:auto，窄屏会拒绝收缩把文字挤成竖排 */
.g-hero-text {
  min-width: 0;
}

.g-hero-title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 600;
  color: var(--g-text);
}

.g-hero-desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 4px;
  align-items: center;
}

.g-tag-text {
  margin-left: 4px;
}

.g-weather-tag {
  cursor: pointer;
}

.g-city-select {
  width: 100%;
}

.g-city-tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--g-text-dim);
}

/**
 * 后端已用 sharp trim 裁掉素材四周的空白边并限高 400px，这里只锁高度、
 * 宽度随图片自身比例，于是既不裁切主体也不出现白边。
 * max-width 兜住极端宽图（裁完最宽约 2.2:1），不让它把左边文字挤没。
 */
.g-hero-img {
  height: 132px;
  width: auto;
  max-width: 320px;
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 12px;
}

.g-stat-row {
  margin-bottom: 16px;
}

.g-stat-inner {
  display: flex;
  align-items: center;
  gap: 14px;
}

.g-stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: 11px;
}

.g-section-title {
  margin: 20px 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--g-text);
}

.g-shortcut {
  cursor: pointer;
  transition: transform 0.18s ease;
}

.g-shortcut:hover {
  transform: translateY(-2px);
}

.g-shortcut-icon {
  color: var(--g-brand);
}

.g-shortcut-title {
  margin-top: 10px;
  font-size: 14px;
  font-weight: 500;
  color: var(--g-text);
}

.g-shortcut-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--g-text-dim);
}

@media (max-width: 768px) {
  .g-hero-title {
    font-size: 18px;
  }

  .g-hero-img {
    height: 88px;
    max-width: 40vw;
    align-self: flex-start;
  }

  /* 统计卡在窄屏改上下排：图标 + 数字横排会把标题挤成竖排单字 */
  .g-stat-inner {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .g-stat-icon {
    width: 34px;
    height: 34px;
    border-radius: 9px;
  }

  .g-shortcut-desc {
    display: none;
  }
}

@media (max-width: 480px) {
  .g-hero-img {
    display: none;
  }
}
</style>
