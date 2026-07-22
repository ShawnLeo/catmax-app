<template>
  <!--
    底部终端面板——始终挂载，折叠时高度收为 0 + overflow 隐藏，走 CSS transition 过渡。
    外层高度由 bottomPanelHeight / 0 驱动，内层固定高度 = bottomPanelHeight，
    避免 xterm 在高度变化时内容被挤压重排（只被外层 overflow 裁掉）。
    复用 TerminalPanel（tab 切换 + xterm 挂载 + 新建按钮）。
  -->
  <div
    :class="[
      'shrink-0 overflow-hidden border-t border-border bg-card',
      // 拖拽 resize 期间禁用 transition（否则动画追赶鼠标造成卡顿）；
      // 仅折叠/展开切换时保留过渡动画。
      uiStore.panelDragging ? '' : 'transition-[height] duration-200 ease-in-out',
    ]"
    :style="{ height: uiStore.bottomPanelVisible ? uiStore.bottomPanelHeight + 'px' : '0px' }"
  >
    <div class="h-full flex flex-col" :style="{ height: uiStore.bottomPanelHeight + 'px' }">
      <TerminalPanel />
    </div>
  </div>
</template>

<script setup lang="ts">
import TerminalPanel from '@renderer/components/panel/TerminalPanel.vue'
import { useUiStore } from '@renderer/stores/ui'

const uiStore = useUiStore()
</script>
