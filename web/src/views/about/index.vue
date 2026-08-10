<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Button,
  Card,
  Col,
  Descriptions,
  DescriptionsItem,
  Modal,
  Row,
  Space,
  Tag,
} from 'ant-design-vue'
import GIcon from '@/components/GIcon.vue'
import { apiRestartBot, apiRestartGuoba } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { API_PREFIX, GUOBA_VERSION, ICP_NO, IS_V2, YUNZAI_VERSION } from '@/utils/env'

const auth = useAuthStore()

const restarting = ref('')

const links = [
  {
    title: '锅巴插件仓库',
    desc: 'Guoba-Plugin 源码与 issue',
    url: 'https://gitee.com/guoba-yunzai/guoba-plugin',
    icon: 'ant-design:code-outlined',
  },
  {
    title: '插件索引',
    desc: 'Yunzai 插件收录列表',
    url: 'https://gitee.com/guoba-yunzai/yunzai-plugins-index',
    icon: 'ant-design:appstore-outlined',
  },
  {
    title: 'Miao-Yunzai',
    desc: '喵版 Yunzai 本体',
    url: 'https://gitee.com/yoimiya-kokomi/Miao-Yunzai',
    icon: 'ant-design:github-outlined',
  },
]

const envInfo = computed(() => [
  { label: '锅巴版本', value: `v${GUOBA_VERSION}` },
  { label: 'Yunzai 版本', value: YUNZAI_VERSION },
  { label: '接口版本', value: API_PREFIX },
  { label: '登录账号', value: String(auth.user?.username ?? '-') },
  { label: 'Bot 昵称', value: auth.user?.realName || '-' },
  { label: 'UA', value: navigator.userAgent, span: 2 },
])

function open(url: string) {
  window.open(url, '_blank', 'noopener')
}

function confirmRestart(type: 'guoba' | 'bot') {
  const isBot = type === 'bot'
  Modal.confirm({
    title: isBot ? '重启 Bot？' : '重启锅巴服务？',
    content: isBot
      ? '重启期间 Bot 会短暂离线，正在进行的任务会中断。'
      : '只重启锅巴后台服务，Bot 本体不受影响。',
    okText: '重启',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      restarting.value = type
      try {
        await (isBot ? apiRestartBot() : apiRestartGuoba())
      } finally {
        restarting.value = ''
      }
    },
  })
}
</script>

<template>
  <div class="g-page">
    <div class="g-page-head">
      <h2 class="g-page-title">关于</h2>
      <p class="g-page-desc">锅巴是 Yunzai-Bot 的可视化管理面板。</p>
    </div>

    <Card :bordered="false" class="g-about-hero">
      <div class="g-about-top">
        <img src="/logo.png" alt="Guoba" class="g-about-logo" />
        <div>
          <h3 class="g-about-name">
            锅巴插件
            <Tag color="gold">v{{ GUOBA_VERSION }}</Tag>
            <Tag v-if="IS_V2" color="orange">V2 兼容模式</Tag>
          </h3>
          <p class="g-about-desc">
            兼容 Miao-Yunzai（V3、V4）与 TRSS-Yunzai，为 Yunzai 及其插件提供网页端配置能力。
          </p>
        </div>
      </div>
    </Card>

    <Row :gutter="[16, 16]">
      <Col :xs="24" :lg="14">
        <Card :bordered="false" title="运行环境">
          <Descriptions :column="{ xs: 1, sm: 2 }" size="small" bordered>
            <DescriptionsItem
              v-for="item in envInfo"
              :key="item.label"
              :label="item.label"
              :span="item.span"
            >
              <span class="g-about-val">{{ item.value }}</span>
            </DescriptionsItem>
          </Descriptions>
        </Card>
      </Col>

      <Col :xs="24" :lg="10">
        <Card :bordered="false" title="相关链接" class="g-about-links">
          <div v-for="link in links" :key="link.url" class="g-link-row" @click="open(link.url)">
            <GIcon :icon="link.icon" :size="18" class="g-link-icon" />
            <div class="g-link-text">
              <div class="g-link-title">{{ link.title }}</div>
              <div class="g-link-desc">{{ link.desc }}</div>
            </div>
            <GIcon icon="ant-design:right-outlined" :size="12" class="g-link-arrow" />
          </div>
        </Card>

        <Card :bordered="false" title="维护操作" class="g-about-ops">
          <p class="g-ops-tip">改完配置若未生效，可尝试重启对应服务。</p>
          <Space>
            <Button :loading="restarting === 'guoba'" @click="confirmRestart('guoba')">
              <GIcon icon="ant-design:sync-outlined" :size="13" />
              <span class="g-btn-text">重启锅巴</span>
            </Button>
            <Button danger :loading="restarting === 'bot'" @click="confirmRestart('bot')">
              <GIcon icon="ant-design:poweroff-outlined" :size="13" />
              <span class="g-btn-text">重启 Bot</span>
            </Button>
          </Space>
        </Card>
      </Col>
    </Row>

    <p v-if="ICP_NO" class="g-about-icp">{{ ICP_NO }}</p>
  </div>
</template>

<style scoped>
.g-page-head {
  margin-bottom: 14px;
}

.g-about-hero {
  margin-bottom: 16px;
  background:
    radial-gradient(circle at 90% 10%, rgba(209, 159, 86, 0.2), transparent 46%),
    var(--g-bg-card);
}

.g-about-top {
  display: flex;
  align-items: center;
  gap: 16px;
}

.g-about-logo {
  width: 56px;
  height: 56px;
  flex-shrink: 0;
}

.g-about-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--g-text);
}

.g-about-desc {
  margin: 0;
  font-size: 13px;
  color: var(--g-text-sub);
}

.g-about-val {
  word-break: break-all;
}

.g-about-links {
  margin-bottom: 16px;
}

.g-link-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.g-link-row:hover {
  background: var(--g-bg-soft);
}

.g-link-icon {
  color: var(--g-brand);
}

.g-link-text {
  flex: 1;
  min-width: 0;
}

.g-link-title {
  font-size: 13px;
  color: var(--g-text);
}

.g-link-desc {
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-link-arrow {
  color: var(--g-text-dim);
}

.g-ops-tip {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--g-text-dim);
}

.g-btn-text {
  margin-left: 5px;
}

.g-about-icp {
  margin-top: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--g-text-dim);
}
</style>
