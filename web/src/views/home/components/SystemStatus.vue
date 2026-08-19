<script setup lang="ts">
/**
 * 系统状态：负载 / CPU / 内存 / SWAP / GPU 环形图 + 全部磁盘。
 *
 * 数据由父组件轮询后传入，这里只负责渲染。装了 systeminformation 才有 CPU 型号、内存频率、
 * SWAP、显卡和温度（`status.extended`）；没有的话这些项自动不出现，剩下的照常显示。
 */
import { computed } from 'vue'
import { Card, Skeleton, Tooltip } from 'ant-design-vue'
import GChart from '@/components/GChart.vue'
import { formatBytes, formatDuration, formatPercent } from '@/utils/format'
import type { SystemStatus } from '@/types'

const props = defineProps<{
  status: SystemStatus | null
  loading: boolean
}>()

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
    // 型号可能很长（`12th Gen Intel(R) Core(TM) i5-12600KF`），放第三行让它有整行宽度
    detail: [s.cpu.model, s.cpu.temp ? `${s.cpu.temp}℃` : ''].filter(Boolean).join(' · '),
    tip: [s.cpu.model, s.cpu.physicalCores ? `${s.cpu.physicalCores} 物理核心` : '']
      .filter(Boolean).join(' · ') || undefined,
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

/**
 * 环形图：一段占用 + 一段留白。
 *
 * 中间那个百分比不画在 canvas 里 —— 62px 的画布上 echarts 算出来的 title 位置会明显偏左，
 * 而且 canvas 里的文字取不到 CSS 变量、换主题得自己给死值。用一层绝对定位的 HTML 更准。
 */
function ringOption(item: RingItem) {
  const percent = Math.min(100, Math.max(0, item.percent))
  const color = colorOf(percent)
  return {
    animationDuration: 300,
    series: [
      {
        type: 'pie',
        // 环细一点，62px 的圆里才留得下中间那个百分比
        radius: ['76%', '92%'],
        center: ['50%', '50%'],
        silent: true,
        label: { show: false },
        labelLine: { show: false },
        data: [
          { value: percent, itemStyle: { color, borderRadius: 6 } },
          // 0.18 那档在暗色卡片上几乎融进背景，占用低时环看着像个残缺的月牙
          { value: 100 - percent, itemStyle: { color: 'rgba(128,138,160,0.3)' } },
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
      <div class="g-metrics">
        <Tooltip v-for="item in rings" :key="item.key" :title="item.tip">
          <div class="g-metric">
            <div class="g-metric-ring">
              <GChart :option="ringOption(item)" :height="62" />
              <span class="g-metric-pct">{{ formatPercent(item.percent, 0) }}%</span>
            </div>
            <div class="g-metric-body">
              <div class="g-metric-name">{{ item.title }}</div>
              <div class="g-metric-value">{{ item.caption }}</div>
              <div v-if="item.detail" class="g-metric-detail">{{ item.detail }}</div>
            </div>
          </div>
        </Tooltip>
      </div>

      <div v-if="disks.length" class="g-disks">
        <div v-for="d in disks" :key="d.name" class="g-disk">
          <div class="g-disk-head">
            <span class="g-disk-name" :title="d.name">{{ d.name }}</span>
            <span class="g-disk-num" :style="{ color: colorOf(d.percent) }">
              {{ formatPercent(d.percent, 0) }}%
            </span>
          </div>
          <span class="g-disk-bar">
            <span
              class="g-disk-fill"
              :style="{ width: `${Math.min(100, d.percent)}%`, background: colorOf(d.percent) }"
            />
          </span>
          <div class="g-disk-foot">
            <span class="g-disk-size">{{ formatBytes(d.used) }} / {{ formatBytes(d.total) }}</span>
            <span v-if="d.fs" class="g-disk-fs">{{ d.fs }}</span>
          </div>
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

/**
 * 指标卡：环在左、文字在右。
 *
 * 之前是环在上、文字竖着排在下面 —— 宽屏上每项只占窄窄一列，右边空一大片，而
 * `Celeron® N5105 · 48℃` 这种型号又比环宽、只能截断。横过来两边都解决了。
 */
.g-metrics,
.g-disks {
  display: grid;
  gap: 10px;
}

.g-metrics {
  /* auto-fit + 1fr：几项都能把整行铺满，不会在右边留空 */
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}

.g-metric {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--g-bg-soft);
  min-width: 0;
}

.g-metric-ring {
  position: relative;
  flex: 0 0 62px;
  width: 62px;
}

/* 压在环中心的百分比，见 ringOption 的说明 */
.g-metric-pct {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text);
  pointer-events: none;
}

.g-metric-body {
  /* min-width: 0 —— 少了它，长型号会把 flex 容器撑破而不是省略 */
  min-width: 0;
  line-height: 1.45;
}

.g-metric-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--g-text);
}

.g-metric-value,
.g-metric-detail {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-metric-value {
  font-size: 12px;
  color: var(--g-text-sub);
}

.g-metric-detail {
  font-size: 11px;
  color: var(--g-text-dim);
}

.g-disks {
  /* 跟指标卡同一套卡片样式，靠一条分隔线区分，不然两组方块连成一片分不清 */
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--g-border);
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}

.g-disk {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--g-bg-soft);
  min-width: 0;
}

.g-disk-head,
.g-disk-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.g-disk-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: var(--g-text);
}

.g-disk-num {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
}

.g-disk-bar {
  display: block;
  margin: 6px 0 5px;
  height: 6px;
  border-radius: 3px;
  background: rgba(128, 138, 160, 0.3);
  overflow: hidden;
}

.g-disk-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}

.g-disk-size,
.g-disk-fs {
  font-size: 11px;
  color: var(--g-text-dim);
}

.g-disk-size {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.g-disk-fs {
  flex: 0 0 auto;
}

@media (max-width: 768px) {
  /* 窄屏两列，运行时长挪到标题下会挤，直接隐藏 */
  .g-status-uptime {
    display: none;
  }

  .g-metrics,
  .g-disks {
    /* 手机上一行两个仍看得清，环 62px + 两行小字塞得下 */
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }

  .g-metric {
    padding: 8px;
    gap: 8px;
  }
}
</style>
