<script setup lang="ts">
/**
 * 系统状态：负载 / CPU / 内存 / 磁盘 四个环形图。
 *
 * 数据由父组件轮询后传入，这里只负责渲染。
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

  items.push({
    key: 'cpu',
    title: 'CPU',
    percent: s.cpu.percent,
    caption: `${s.cpu.count} 核`,
    tip: s.cpu.model || undefined,
  })

  items.push({
    key: 'memory',
    title: '内存',
    percent: s.memory.percent,
    caption: `${formatBytes(s.memory.used)} / ${formatBytes(s.memory.total)}`,
  })

  if (s.disk) {
    items.push({
      key: 'disk',
      title: s.disk.name,
      percent: s.disk.percent,
      caption: `${formatBytes(s.disk.used)} / ${formatBytes(s.disk.total)}`,
    })
  }

  return items
})

/** 环形图：一段占用 + 一段留白，中心用 title 显示百分比 */
function ringOption(item: RingItem) {
  const percent = Math.min(100, Math.max(0, item.percent))
  const color = colorOf(percent)
  return {
    animationDuration: 300,
    title: {
      text: `${formatPercent(percent)}%`,
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
    <Row v-else :gutter="[8, 16]">
      <Col v-for="item in rings" :key="item.key" :xs="12" :sm="6" :md="6">
        <Tooltip :title="item.tip">
          <div class="g-ring">
            <GChart :option="ringOption(item)" :height="92" />
            <div class="g-ring-name">{{ item.title }}</div>
            <div class="g-ring-caption">{{ item.caption }}</div>
          </div>
        </Tooltip>
      </Col>
    </Row>
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

.g-ring-caption {
  margin-top: 2px;
  font-size: 12px;
  color: var(--g-text-dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@media (max-width: 768px) {
  /* 窄屏两列，运行时长挪到标题下会挤，直接隐藏 */
  .g-status-uptime {
    display: none;
  }
}
</style>
