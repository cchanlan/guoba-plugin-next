<script setup lang="ts">
/**
 * 消息统计：收发量卡片 + 近 7 天趋势图 + Bot 账号表格。
 *
 * 数据由父组件传入，这里负责渲染与 ECharts 配置。
 */
import { computed } from 'vue'
import { Card, Col, Row, Skeleton, Statistic, Tag } from 'ant-design-vue'
import GChart from '@/components/GChart.vue'
import { formatNumber } from '@/utils/format'
import type { MsgStat } from '@/types'

const props = defineProps<{
  stat: MsgStat | null
  loading: boolean
}>()

const trendOption = computed(() => {
  const s = props.stat
  if (!s) return {}
  const dates = s.trend.map((t) => t.date)
  const recv = s.trend.map((t) => t.receive)
  const send = s.trend.map((t) => t.send)
  return {
    grid: { left: 42, right: 16, top: 32, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const items = params.map(
          (p: any) => `<span style="color:${p.color}">${p.seriesName}: ${formatNumber(p.value)}</span>`,
        )
        return `${params[0].axisValue}<br/>${items.join('<br/>')}`
      },
    },
    legend: { top: 4, right: 16, icon: 'circle', itemWidth: 8 },
    xAxis: { type: 'category', data: dates, boundaryGap: false },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v) } },
    series: [
      { name: '收到', type: 'line', smooth: true, data: recv, lineStyle: { width: 2 }, itemStyle: { color: '#4c8dff' } },
      { name: '发送', type: 'line', smooth: true, data: send, lineStyle: { width: 2 }, itemStyle: { color: '#3cc2a0' } },
    ],
  }
})

const hasBot = computed(() => (props.stat?.bots?.length ?? 0) > 0)
</script>

<template>
  <Card :bordered="false" class="g-msg">
    <template #title>
      <span class="g-msg-title">消息统计</span>
    </template>

    <Skeleton v-if="loading && !stat" :paragraph="{ rows: 3 }" active />
    <div v-else>
      <Row :gutter="[16, 16]" class="g-msg-summary">
        <Col :xs="12" :sm="12" :md="6">
          <Statistic title="今日收到" :value="stat?.receive.today ?? 0" :valueStyle="{ color: '#4c8dff' }" />
        </Col>
        <Col :xs="12" :sm="12" :md="6">
          <Statistic title="今日发送" :value="stat?.send.today ?? 0" :valueStyle="{ color: '#3cc2a0' }" />
        </Col>
        <Col :xs="12" :sm="12" :md="6">
          <Statistic title="累计收到" :value="formatNumber(stat?.receive.total ?? 0)" />
        </Col>
        <Col :xs="12" :sm="12" :md="6">
          <Statistic title="累计发送" :value="formatNumber(stat?.send.total ?? 0)" />
        </Col>
      </Row>

      <h4 class="g-msg-subtitle">近 7 天趋势</h4>
      <GChart :option="trendOption" :height="200" />

      <template v-if="hasBot">
        <h4 class="g-msg-subtitle">Bot 账号</h4>
        <div class="g-bot-list">
          <div v-for="bot in stat?.bots" :key="bot.uin" class="g-bot-item">
            <div class="g-bot-head">
              <span class="g-bot-name">{{ bot.nickname || bot.uin }}</span>
              <span class="g-bot-uin">{{ bot.uin }}</span>
            </div>
            <div v-if="bot.adapter" class="g-bot-tags">
              <Tag>{{ bot.adapter }}</Tag>
            </div>
            <div class="g-bot-stat">
              <span>今日：收 {{ formatNumber(bot.today.receive) }} · 发 {{ formatNumber(bot.today.send) }}</span>
              <span>累计：收 {{ formatNumber(bot.total.receive) }} · 发 {{ formatNumber(bot.total.send) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </Card>
</template>

<style scoped>
.g-msg {
  margin-bottom: 16px;
}

.g-msg-title {
  font-size: 15px;
  font-weight: 600;
}

.g-msg-summary {
  margin-bottom: 20px;
}

.g-msg-subtitle {
  margin: 16px 0 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--g-text);
}

.g-bot-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.g-bot-item {
  padding: 12px 14px;
  background: var(--g-bg-soft);
  border-radius: 8px;
  border: 1px solid var(--g-border);
}

.g-bot-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.g-bot-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--g-text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-bot-uin {
  font-size: 12px;
  color: var(--g-text-dim);
  flex-shrink: 0;
}

.g-bot-tags {
  margin-bottom: 6px;
}

.g-bot-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--g-text-sub);
}

@media (max-width: 768px) {
  .g-bot-list {
    grid-template-columns: 1fr;
  }
}
</style>
