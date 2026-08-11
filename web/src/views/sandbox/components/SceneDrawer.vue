<script setup lang="ts">
import { computed } from 'vue'
import type { SandboxBot, SandboxScene } from '@/api'

const props = defineProps<{
  open: boolean
  scene: SandboxScene
  bots: SandboxBot[]
  /** 配置里的主人 QQ，用来判断「主人」开关是否可关 */
  masters: string[]
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'update:scene', value: SandboxScene): void
}>()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

/** 各字段独立回写，避免整对象替换导致输入光标跳动 */
function set<K extends keyof SandboxScene>(key: K, value: SandboxScene[K]) {
  emit('update:scene', { ...props.scene, [key]: value })
}

/**
 * 沙盒 QQ 号本身就在主人列表里时，Yunzai 会把 isMaster 判成 true，
 * 关掉开关也没用（loader 只会把它置 true）——这里如实告知，免得以为开关坏了。
 */
const forcedMaster = computed(() => props.masters.includes(String(props.scene.userId)))
</script>

<template>
  <a-drawer v-model:open="visible" title="场景配置" placement="right" :width="380">
    <a-form layout="vertical" class="g-scene-form">
      <a-form-item label="接收账号">
        <a-select
          :value="scene.selfId"
          placeholder="未检测到在线账号"
          :options="bots.map((b) => ({
            value: b.uin,
            label: b.nickname ? `${b.nickname}（${b.uin}）` : b.uin,
          }))"
          @update:value="(v: string) => set('selfId', v)"
        />
        <div class="g-form-tip">决定这条消息由哪个 Bot 账号接收，影响插件里读 e.self_id 的逻辑</div>
      </a-form-item>

      <a-form-item label="消息来源">
        <a-radio-group
          :value="scene.isGroup"
          button-style="solid"
          @update:value="(v: boolean) => set('isGroup', v)"
        >
          <a-radio-button :value="true">群聊</a-radio-button>
          <a-radio-button :value="false">私聊</a-radio-button>
        </a-radio-group>
      </a-form-item>

      <a-form-item label="发送者 QQ">
        <a-input
          :value="scene.userId"
          placeholder="80000000"
          @update:value="(v: string) => set('userId', v)"
        />
      </a-form-item>

      <a-form-item label="发送者昵称">
        <a-input
          :value="scene.nickname"
          placeholder="沙盒用户"
          @update:value="(v: string) => set('nickname', v)"
        />
      </a-form-item>

      <template v-if="scene.isGroup">
        <a-form-item label="群号">
          <a-input
            :value="scene.groupId"
            placeholder="100000000"
            @update:value="(v: string) => set('groupId', v)"
          />
        </a-form-item>

        <a-form-item label="群名称">
          <a-input
            :value="scene.groupName"
            placeholder="沙盒测试群"
            @update:value="(v: string) => set('groupName', v)"
          />
        </a-form-item>

        <a-form-item label="群名片">
          <a-input
            :value="scene.card"
            placeholder="留空则用昵称"
            @update:value="(v: string) => set('card', v)"
          />
        </a-form-item>
      </template>

      <a-form-item label="身份与行为">
        <div class="g-scene-switches">
          <div class="g-scene-switch">
            <a-switch
              :checked="scene.isMaster || forcedMaster"
              :disabled="forcedMaster"
              size="small"
              @update:checked="(v: boolean) => set('isMaster', v)"
            />
            <span>主人</span>
            <span v-if="forcedMaster" class="g-form-tip">该 QQ 已配置为主人，无法关闭</span>
          </div>

          <template v-if="scene.isGroup">
            <div class="g-scene-switch">
              <a-switch
                :checked="scene.isOwner"
                size="small"
                @update:checked="(v: boolean) => set('isOwner', v)"
              />
              <span>群主</span>
            </div>
            <div class="g-scene-switch">
              <a-switch
                :checked="scene.isAdmin"
                size="small"
                @update:checked="(v: boolean) => set('isAdmin', v)"
              />
              <span>群管理员</span>
            </div>
            <div class="g-scene-switch">
              <a-switch
                :checked="scene.atBot"
                size="small"
                @update:checked="(v: boolean) => set('atBot', v)"
              />
              <span>@机器人</span>
              <span class="g-form-tip">开启「只回复@」时必须勾选才会触发</span>
            </div>
          </template>
        </div>
      </a-form-item>
    </a-form>
  </a-drawer>
</template>

<style scoped>
.g-scene-form :deep(.ant-form-item) {
  margin-bottom: 18px;
}

.g-form-tip {
  margin-top: 4px;
  color: var(--g-text-dim);
  font-size: 12px;
  line-height: 1.5;
}

.g-scene-switches {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.g-scene-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.g-scene-switch .g-form-tip {
  margin-top: 0;
}
</style>
