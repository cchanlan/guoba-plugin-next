<script setup lang="ts">
/**
 * 图标组件。
 *
 * 三种来源，按优先级：
 *  1. src —— 后端给的图片地址（如插件自带 icon）；
 *  2. icon —— iconify 图标名。面板自身用到的 `ant-design:*` 全部已内置
 *     （见 components/icons/offline.ts），不联网；
 *     插件在 guoba.support.js 里声明的其他名称（如 `mdi:stove`）才会走
 *     iconify 公共 API，离线环境拉不到就显示 fallback；
 *  3. fallback —— 兜底图标，必须是已内置的名称。
 */
import { computed } from 'vue'
import { Icon, iconExists } from '@iconify/vue'
import { withMountPrefix } from '@/utils/env'

const props = withDefaults(
  defineProps<{
    /** iconify 图标名 */
    icon?: string
    /** 图片地址（优先级高于 icon） */
    src?: string
    size?: number | string
    color?: string
    /** 拉不到图标时的兜底 */
    fallback?: string
  }>(),
  { size: 16, fallback: 'ant-design:api-outlined' },
)

const sizeStyle = (val: number | string) => (typeof val === 'number' ? `${val}px` : val)

/** 已内置的图标同步渲染；未内置的由 iconify 运行时拉取，期间/失败时走插槽兜底 */
const isBundled = computed(() => (props.icon ? iconExists(props.icon) : false))

/**
 * iconify 图标名一律是 `集合:名称`。不含冒号的按文本渲染 ——
 * 插件的自定义页面可以直接拿 emoji 当图标（见 docs/custom-page.md）。
 */
const isTextIcon = computed(() => !!props.icon && !props.icon.includes(':'))
</script>

<template>
  <img
    v-if="props.src"
    class="g-icon-img"
    :src="withMountPrefix(props.src)"
    :style="{ width: sizeStyle(props.size), height: sizeStyle(props.size) }"
    alt=""
  />
  <span
    v-else-if="isTextIcon"
    class="g-icon-text"
    :style="{ fontSize: sizeStyle(props.size), lineHeight: sizeStyle(props.size) }"
  >{{ props.icon }}</span>
  <Icon
    v-else-if="props.icon"
    class="g-icon-svg"
    :icon="props.icon"
    :style="{
      fontSize: sizeStyle(props.size),
      color: props.color,
      width: sizeStyle(props.size),
      height: sizeStyle(props.size),
    }"
  >
    <Icon
      v-if="!isBundled"
      :icon="props.fallback"
      :style="{ fontSize: sizeStyle(props.size), color: props.color, opacity: 0.45 }"
    />
  </Icon>
</template>

<style scoped>
/* 图标在 flex 容器里（按钮、菜单项等）不允许被压扁 */
.g-icon-img,
.g-icon-svg,
.g-icon-text {
  flex: none;
}

/* emoji 图标，宽度对齐 svg 图标免得菜单文字参差不齐 */
.g-icon-text {
  display: inline-block;
  width: 1em;
  text-align: center;
  font-style: normal;
}

.g-icon-img {
  object-fit: contain;
  border-radius: 4px;
  vertical-align: -0.125em;
}

/**
 * 兜底：部分图标集（含从 iconify API 拉到的）路径不写 fill，
 * SVG 默认填黑，图标就不会跟随 color 变化（菜单选中态最明显）。
 * 写在 svg 上而不是 path 上 —— path 自带的 fill 是表现属性，
 * 但同为元素级样式时权重更高，彩色图标（twemoji 等）不受影响。
 */
.g-icon-svg {
  fill: currentColor;
}
</style>
