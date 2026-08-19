<script setup lang="ts">
/**
 * 系统状态：负载 / CPU / 内存 / SWAP / GPU 环形图 + 全部磁盘。
 *
 * 数据由父组件轮询后传入，这里只负责渲染。装了 systeminformation 才有 CPU 型号、内存频率、
 * SWAP、显卡和温度（`status.extended`）；没有的话这些项自动不出现，剩下的照常显示。
 */
import { computed } from 'vue'
import { Card, Col, Row, Skeleton, Tooltip } from 'ant-design-vue'
import GChart from '@/components/GChart.vue'
import { useAppStore } from '@/stores/app'
import { formatBytes, formatDuration, formatPercent } from '@/utils/format'
import type { SystemStatus } from '@/types'

const props = defineProps<{
  status: SystemStatus | null
  loading: boolean
}>()

const appStore = useAppStore()

// canvas 里画的文字拿不到 CSS 变量，只能按主题给死值
const textColor = computed(() => (appStore.isDark ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.85)'))

/** 占用越高越警示：正常金色 → 偏高橙 → 危险红 */
function colorOf(percent: number) {
  if (percent >= 90) return '#e05c5c'
  if (percent >= 70) return '#e0954a'
  return '#d19f56'
}

interface RingItem {
  key: string
  title: string
  percent: number
  /** 环下方的说明，如 `7.67 GB / 11.53 GB` */
  caption: string
  /** 说明下面那行更小的字：型号、频率、温度 */
  detail?: string
  tip?: string
}

const rings = computed<RingItem[]>(() => {
  const s = props.status
  if (!s) return []
  const items: RingItem[] = []

  if (s.load?.supported) {
    items.push({
      key: 'load',
      title: '负载',
      percent: s.load.percent,
      caption: `${s.load.avg1.toFixed(2)} / ${s.load.cpuCount} 核`,
      tip: `1 / 5 / 15 分钟：${s.load.avg1.toFixed(2)} / ${s.load.avg5.toFixed(2)} / ${s.load.avg15.toFixed(2)}`,
    })
  }

  // CPU 说明行：`Intel 16 核 3.7GHz`，缺的部分自动省略
  const cpuBits = [
    s.cpu.manufacturer,
    `${s.cpu.count} 核`,
    s.cpu.speed ? `${s.cpu.speed}GHz` : '',
  ].filter(Boolean)
  items.push({
    key: 'cpu',
    title: 'CPU',
    percent: s.cpu.percent,
    caption: cpuBits.join(' '),
    detail: [s.cpu.model, s.cpu.temp ? `${s.cpu.temp}℃` : ''].filter(Boolean).join(' · '),
    tip: s.cpu.model || undefined,
  })

  items.push({
    key: 'memory',
    title: '内存',
    percent: s.memory.percent,
    caption: `${formatBytes(s.memory.used)} / ${formatBytes(s.memory.total)}`,
    detail: [
      s.memClock ? `${s.memClock}MHz` : '',
      s.memType,
      s.memory.buffcache ? `缓存 ${formatBytes(s.memory.buffcache)}` : '',
    ].filter(Boolean).join(' · '),
    tip: s.memory.buffcache
      ? `缓冲/缓存 ${formatBytes(s.memory.buffcache)} 不计入已用`
      : undefined,
  })

  if (s.swap && s.swap.total > 0) {
    items.push({
      key: 'swap',
      title: 'SWAP',
      percent: s.swap.percent,
      caption: `${formatBytes(s.swap.used)} / ${formatBytes(s.swap.total)}`,
      detail: `可用 ${formatBytes(s.swap.free)}`,
    })
  }

  // 核显给不出占用（percent 为 null），画个恒 0 的环没意义，只在 tip 里报型号
  if (s.gpu && typeof s.gpu.percent === 'number') {
    items.push({
      key: 'gpu',
      title: 'GPU',
      percent: s.gpu.percent,
      caption: s.gpu.memTotal
        ? `${formatBytes(s.gpu.memUsed ?? 0)} / ${formatBytes(s.gpu.memTotal)}`
        : s.gpu.model,
      detail: [s.gpu.model, s.gpu.temp ? `${s.gpu.temp}℃` : ''].filter(Boolean).join(' · '),
      tip: `${s.gpu.vendor} ${s.gpu.model}`.trim(),
    })
  }

  return items
})

/** 磁盘：一块盘一条横向进度条。只有一块时也列出来，跟环形图区分开 */
const disks = computed(() => props.status?.disks ?? [])

/** 环形图：一段占用 + 一段留白，中心用 title 显示百分比 */
function ringOption(item: RingItem) {
  const percent = Math.min(100, Math.max(0, item.percent))
  const color = colorOf(percent)
  return {
    animationDuration: 300,
    title: {
      // 环只有 92px 高，`100.00%` 会顶到两边的圆弧上，整数够用了
      text: `${formatPercent(percent, 0)}%`,
      left: 'center',
      top: '38%',
      textStyle: {
        fontSize: 15,
        fontWeight: 600,
        color: textColor.value,
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['72%', '90%'],
        center: ['50%', '50%'],
        silent: true,
        label: { show: false },
        labelLine: { show: false },
        data: [
          { value: percent, itemStyle: { color, borderRadius: 6 } },
          { value: 100 - percent, itemStyle: { color: 'rgba(128,138,160,0.18)' } },
        ],
      },
    ],
  }
}

const uptimeText = computed(() => {
  const s = props.status
  if (!s) return ''
  return `Bot 已运行 ${formatDuration(s.uptime.process)} · 系统 ${formatDuration(s.uptime.system)}`
})

const envText = computed(() => {
  const s = props.status
  if (!s) return ''
  return `${s.platform} · ${s.arch} · Node ${s.nodeVersion}`
})
</script>

<template>
  <Card :bordered="false" class="g-status">
    <template #title>
      <span class="g-status-title">状态</span>
    </template>
    <template v-if="status" #extra>
      <Tooltip :title="envText">
        <span class="g-status-uptime">{{ uptimeText }}</span>
      </Tooltip>
    </template>

    <Skeleton v-if="loading && !status" :paragraph="{ rows: 3 }" active />
    <template v-else>
      <Row :gutter="[8, 16]">
        <Col v-for="item in rings" :key="item.key" :xs="12" :sm="8" :md="6" :xl="4">
          <Tooltip :title="item.tip">
            <div class="g-ring">
              <GChart :option="ringOption(item)" :height="92" />
              <div class="g-ring-name">{{ item.title }}</div>
              <div class="g-ring-caption">{{ item.caption }}</div>
              <div v-if="item.detail" class="g-ring-detail">{{ item.detail }}</div>
            </div>
          </Tooltip>
        </Col>
      </Row>

      <div v-if="disks.length" class="g-disks">
        <div v-for="d in disks" :key="d.name" class="g-disk">
          <span class="g-disk-name" :title="d.name">{{ d.name }}</span>
          <span class="g-disk-bar">
            <span
              class="g-disk-fill"
              :style="{ width: `${Math.min(100, d.percent)}%`, background: colorOf(d.percent) }"
            />
          </span>
          <span class="g-disk-num">{{ formatPercent(d.percent, 0) }}%</span>
          <span class="g-disk-size">
            {{ formatBytes(d.used) }} / {{ formatBytes(d.total) }}
            <template v-if="d.fs"> · {{ d.fs }}</template>
          </span>
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.g-status {
  margin-bottom: 16px;
}

.g-status-title {
  font-size: 15px;
  font-weight: 600;
}

.g-status-uptime {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-ring {
  text-align: center;
}

.g-ring-name {
  margin-top: 2px;
  font-size: 13px;
  color: var(--g-text);
}

.g-ring-caption,
.g-ring-detail {
  margin-top: 2px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-ring-caption {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-ring-detail {
  font-size: 11px;
  color: var(--g-text-dim);
  opacity: 0.75;
}

.g-disks {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--g-border, rgba(128, 138, 160, 0.18));
  display: grid;
  /* 一行放不下「盘名 + 进度条 + 百分比 + 容量」就换列 */
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 6px 20px;
}

.g-disk {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}

.g-disk-name {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--g-text);
}

.g-disk-bar {
  flex: 1 1 60px;
  min-width: 40px;
  height: 6px;
  border-radius: 3px;
  background: rgba(128, 138, 160, 0.18);
  overflow: hidden;
}

.g-disk-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}

.g-disk-num {
  flex: 0 0 auto;
  min-width: 30px;
  text-align: right;
  color: var(--g-text);
}

.g-disk-size {
  /* 这行最长，列窄时先压它并省略，别把整行顶出去 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--g-text-dim);
}

@media (max-width: 768px) {
  /* 窄屏两列，运行时长挪到标题下会挤，直接隐藏 */
  .g-status-uptime {
    display: none;
  }

  .g-disks {
    grid-template-columns: 1fr;
  }

  /* 容量文字最长，窄屏让它整行换下去，进度条才有地方 */
  .g-disk {
    flex-wrap: wrap;
  }

  .g-disk-size {
    flex: 0 0 100%;
    padding-left: 0;
  }
}
</style>
