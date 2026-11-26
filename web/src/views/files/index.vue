<script setup lang="ts">
/**
 * 文件管理入口。
 *
 * 逻辑全在 useFileManager；PC 和手机是两个独立视图组件，这里只挑一个渲染，
 * 再把共用的弹窗与上传 input 挂上。
 *
 * 文件夹的大小和下载都要走完整棵子树，所以都是**点了才做**：列目录时不顺手算大小
 * （`node_modules` 一层就十万个 inode，进目录就卡死），下载则由后端边打包边发。
 */
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import FilesPcView from './components/FilesPcView.vue'
import FilesMobileView from './components/FilesMobileView.vue'
import FilesDialogs from './components/FilesDialogs.vue'
import { useFileManager } from './useFileManager'

const appStore = useAppStore()
const isMobile = computed(() => appStore.isMobile)

const { vm, uploadEl, uploadDirEl } = useFileManager()
</script>

<template>
  <div class="g-page g-files">
    <div class="g-page-head">
      <h2 class="g-page-title">文件管理</h2>
      <p class="g-page-desc">
        设置并通过二级密码后，可修改 <b>云崽根目录</b>下的文件；未设置时，仅允许写入指定目录。
        单击文件可预览，文本编辑限 2 MB，二进制文件只能下载。
        文件夹的大小要点「计算」才算，下载文件夹会打包成 zip。
      </p>
    </div>

    <FilesPcView
      v-if="!isMobile"
      :vm="vm"
      @pick-upload="uploadEl?.click()"
      @pick-upload-dir="uploadDirEl?.click()"
    />
    <FilesMobileView
      v-else
      :vm="vm"
      @pick-upload="uploadEl?.click()"
      @pick-upload-dir="uploadDirEl?.click()"
    />

    <!-- 上传 input 只有一份：两个视图都通过事件回到这里触发，避免各存一份 ref -->
    <input ref="uploadEl" type="file" multiple hidden @change="vm.onUploadChange" />
    <input
      ref="uploadDirEl"
      type="file"
      multiple
      webkitdirectory
      directory
      hidden
      @change="vm.onDirChange"
    />

    <FilesDialogs :vm="vm" />
  </div>
</template>
