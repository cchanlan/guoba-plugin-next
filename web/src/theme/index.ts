import { theme as antdTheme } from 'ant-design-vue'
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'

/** 锅巴品牌色（取自插件 icon 的暖金色） */
export const BRAND = '#d19f56'
export const BRAND_HOVER = '#e0b674'
export const BRAND_ACTIVE = '#b8873f'

const sharedToken = {
  colorPrimary: BRAND,
  colorInfo: BRAND,
  colorSuccess: '#4ca97a',
  colorWarning: '#d99b3d',
  colorError: '#d9614c',
  borderRadius: 10,
  borderRadiusLG: 14,
  fontSize: 14,
  wireframe: false,
}

/** 深色主题：偏冷的墨蓝底 + 暖金强调色 */
export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...sharedToken,
    colorBgBase: '#10131a',
    colorBgContainer: '#181c25',
    colorBgElevated: '#1e2430',
    colorBgLayout: '#0d1017',
    colorBorder: '#2a3140',
    colorBorderSecondary: '#222833',
    colorText: 'rgba(255, 255, 255, 0.88)',
    colorTextSecondary: 'rgba(255, 255, 255, 0.62)',
    colorTextTertiary: 'rgba(255, 255, 255, 0.42)',
  },
  components: {
    // 注意：ant-design-vue 4.2.6 的组件级 token 沿用的是 v5-alpha 命名
    // （colorBgHeader / colorItemBg 等），不是 React antd 后来的 headerBg / itemBg
    Layout: {
      colorBgBody: '#0d1017',
      colorBgHeader: '#12161f',
      colorBgTrigger: '#1e2430',
    },
    Menu: {
      colorItemBg: 'transparent',
      colorSubItemBg: 'transparent',
      colorItemBgSelected: 'rgba(209, 159, 86, 0.16)',
      colorItemTextSelected: BRAND_HOVER,
      colorItemBgHover: 'rgba(255, 255, 255, 0.06)',
      radiusItem: 8,
      itemMarginInline: 8,
    },
    Card: {
      colorBgContainer: '#181c25',
    },
  },
}

/** 浅色主题：白底细边框，低饱和 */
export const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...sharedToken,
    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f4f6fa',
    colorBorder: '#e2e6ee',
    colorBorderSecondary: '#eef1f6',
  },
  components: {
    Layout: {
      colorBgBody: '#f4f6fa',
      colorBgHeader: '#ffffff',
      colorBgTrigger: '#f0f2f7',
    },
    Menu: {
      colorItemBg: 'transparent',
      colorSubItemBg: 'transparent',
      colorItemBgSelected: 'rgba(209, 159, 86, 0.14)',
      colorItemTextSelected: BRAND_ACTIVE,
      colorItemBgHover: 'rgba(0, 0, 0, 0.04)',
      radiusItem: 8,
      itemMarginInline: 8,
    },
  },
}

export function useThemeConfig(isDark: boolean): ThemeConfig {
  return isDark ? darkTheme : lightTheme
}
