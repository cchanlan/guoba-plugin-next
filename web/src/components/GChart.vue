<script setup lang="ts">
/**
 * ECharts 容器。
 *
 * 按需引入而不是 `import * as echarts`：全量包 gzip 后有 300KB 上下，
 * 这里只用到环形图（Pie）和趋势图（Line），装配后不到三分之一。
 *
 * 组件只管渲染与尺寸/主题跟随，option 由调用方给全。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { init, use } from 'echarts/core'
import type { ECharts } from 'echarts/core'
import { LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useAppStore } from '@/stores/app'

// TitleComponent 别漏：环形图靠 title 在圆心写百分比，不注册的话 ECharts 会静默不画它 ——
// 环画出来了、中间是空的，看着像后端没给数据
use([PieChart, LineChart, GridComponent, TitleComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = withDefaults(
  defineProps<{
    /** echarts option，浅比较后整体 setOption */
    option: Record<string, any>
    height?: number | string
  }>(),
  { height: 200 },
)

const appStore = useAppStore()
const elRef = ref<HTMLElement>()
// shallowRef：echarts 实例内部结构庞大，深响应式会带来无意义的开销
const chart = shallowRef<ECharts>()
let observer: ResizeObserver | undefined

const sizeStyle = (val: number | string) => (typeof val === 'number' ? `${val}px` : val)

function render() {
  if (!chart.value) return
  // notMerge：轮询时数据长度可能变化，合并会残留旧 series。
  // 也因此透明背景必须每次带上，否则会被覆盖回 dark 主题自带的深蓝底
  chart.value.setOption({ backgroundColor: 'transparent', ...props.option }, true)
}

function create() {
  if (!elRef.value) return
  chart.value?.dispose()
  chart.value = init(elRef.value, appStore.isDark ? 'dark' : undefined, {
    renderer: 'canvas',
  })
  render()
}

onMounted(() => {
  create()
  // 侧边栏收起/展开不触发 window.resize，只能观察容器本身
  observer = new ResizeObserver(() => chart.value?.resize())
  if (elRef.value) observer.observe(elRef.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  chart.value?.dispose()
  chart.value = undefined
})

watch(() => props.option, render, { deep: true })
// 主题是初始化参数，切换只能整个重建
watch(() => appStore.isDark, create)
</script>

<template>
  <div ref="elRef" class="g-chart" :style="{ height: sizeStyle(props.height) }" />
</template>

<style scoped>
.g-chart {
  width: 100%;
}
</style>
