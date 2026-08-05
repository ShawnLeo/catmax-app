<template>
  <!--
    两种形态共用同一棵结构：
    - docked（默认）：占据布局宽度，始终挂载，折叠时宽度收为 0 + overflow 隐藏内容，
      宽度变化走 CSS transition。不用 v-if 卸载——那样宽度无法过渡（元素瞬间消失），会显得生硬。
    - overlay：Sidebar Peek 的浮层形态，宽度固定为 sidebarWidth（不受折叠影响），
      由外层容器负责定位，自己只负责内容和右侧投影。
  -->
  <aside
    :class="[
      'flex flex-col overflow-hidden',
      isOverlay
        ? 'h-full shadow-lg bg-sidebar/80 backdrop-blur-sm'
        : [
            'shrink-0 bg-sidebar',
            // 拖拽 resize 期间禁用 transition（否则动画追赶鼠标造成卡顿）；
            // 仅折叠/展开切换时保留过渡动画。
            uiStore.panelDragging ? '' : 'transition-[width] duration-200 ease-in-out',
          ],
    ]"
    :style="{ width: outerWidth + 'px' }"
  >
    <!-- 内层固定宽度容器：折叠时外层宽度收 0 把它裁掉，内层保持原宽避免内容被挤压重排 -->
    <div class="flex flex-col h-full" :style="{ width: uiStore.sidebarWidth + 'px' }">
      <!-- 右侧内阴影只覆盖工作区 + 会话列表，不延伸到底部用户/设置栏。 -->
      <div
        class="sidebar-content flex min-h-0 flex-1 flex-col border-r border-sidebar-border"
        :class="{ 'is-floating': isOverlay }"
      >
        <!--
          顶部：工作区切换。两种 overlay 用法对它的需求不同：
          - peek（折叠态临时瞥看）：不渲染——浮层从顶栏下方开始（top-12），工作区位置
            已被 RuntimeConfigBar 的窗口控制按钮占用，重复划出一条会重叠。
          - expansion（窄窗口展开）：渲染——这是完整侧栏体验，需要窗口控制按钮
            （展开态 RuntimeConfigBar 不显示 TitleBarControls，否则窗口控制按钮丢失）。
          docked 始终渲染。
        -->
        <WorkspaceSwitcher v-if="showWorkspace" />

        <!-- 中部：会话列表（含 tab + 新建按钮，内部自己管滚动） -->
        <SessionList class="flex-1 overflow-hidden" />
      </div>

      <!-- 底部：用户信息 + 设置 -->
      <SidebarFooter />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useUiStore } from '@renderer/stores/ui'
import { computed } from 'vue'

import SessionList from './SessionList.vue'
import SidebarFooter from './SidebarFooter.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'

interface Props {
  /**
   * docked = 参与布局的常驻侧栏；
   * overlay = 浮层形态，外层容器负责定位，自己只负责内容和右侧投影。
   * overlay 形态分两种用法（用 showWorkspace 区分），见下方。
   */
  variant?: 'docked' | 'overlay'
  /**
   * overlay 形态下是否渲染顶栏工作区切换器。
   * - peek（折叠态临时瞥看）：false，浮层从顶栏下方开始，不重复划出工作区栏。
   * - expansion（窄窗口展开）：true，作为完整侧栏，需要保留窗口控制按钮入口。
   * docked 形态忽略此 prop（恒渲染）。
   */
  showWorkspace?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'docked',
  showWorkspace: false,
})

const uiStore = useUiStore()

const isOverlay = computed(() => props.variant === 'overlay')
const showWorkspace = computed(() => !isOverlay.value || props.showWorkspace)

// overlay 是折叠状态下才出现的浮层，宽度不能再跟着 sidebarCollapsed 收成 0。
const outerWidth = computed(() => {
  if (isOverlay.value) return uiStore.sidebarWidth
  return uiStore.sidebarCollapsed ? 0 : uiStore.sidebarWidth
})
</script>

<style scoped>
/* Panel Depth: 宽幅多段渐变模拟柔焦内阴影，避免分隔边缘出现突兀的黑线。
   仅停靠形态需要——它要在侧栏与聊天区的接缝处制造深度感。
   浮层/滑出形态（窄窗口）用较轻的 shadow-lg 外投影，内阴影在这里冗余，不显示。 */
.sidebar-content:not(.is-floating)::after {
  position: absolute;
  z-index: 20;
  top: 0;
  right: 0;
  bottom: 0;
  width: 32px;
  pointer-events: none;
  background: linear-gradient(
    to left,
    var(--panel-edge-shadow) 0,
    color-mix(in oklch, var(--panel-edge-shadow) 55%, transparent) 24%,
    color-mix(in oklch, var(--panel-edge-shadow) 18%, transparent) 58%,
    transparent 100%
  );
  content: '';
}

.sidebar-content {
  position: relative;
}
</style>
