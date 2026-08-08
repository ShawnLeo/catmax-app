<template>
  <div class="h-full flex">
    <button
      v-if="mobileMenuOpen"
      type="button"
      class="settings-menu-backdrop"
      aria-label="关闭设置菜单"
      @click="mobileMenuOpen = false"
    />

    <!-- 左侧导航从窗口顶部贯通到底部，结构与会话列表侧栏一致。 -->
    <aside
      :class="[
        'settings-sidebar w-52 shrink-0 border-r border-panel-divider bg-sidebar flex min-h-0 flex-col',
        mobileMenuOpen ? 'settings-sidebar--open' : '',
      ]"
    >
      <!-- 顶部：窗口控制按钮 + 返回。与会话侧栏顶部共用 h-12，不加横向分隔线。 -->
      <div class="settings-sidebar-header h-12 shrink-0 flex items-center gap-2 px-3 titlebar">
        <TitleBarControls />
        <button
          type="button"
          class="interactive flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--ui-text-base)] font-medium text-foreground transition-colors hover:bg-sidebar-hover cursor-pointer"
          title="返回"
          aria-label="返回上一级"
          @click="goBack"
        >
          <ArrowLeftIcon class="h-4 w-4 shrink-0" />
          <span>返回</span>
        </button>
      </div>

      <nav id="settings-navigation" class="flex min-h-0 flex-1 flex-col gap-1 p-3">
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="[
            'flex items-center gap-2.5 px-3 py-2 rounded-md text-[length:var(--ui-text-base)] text-left transition-colors interactive cursor-pointer',
            activeSection === item.id
              ? 'bg-sidebar-hover text-foreground font-medium'
              : 'text-muted-foreground hover:bg-sidebar-hover hover:text-foreground',
          ]"
          @click="selectSection(item.id)"
        >
          <component :is="item.icon" class="w-4 h-4 shrink-0" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
    </aside>

    <!-- 右侧设置区域保持主面板背景；顶部不再与内容之间画边框。 -->
    <div class="flex min-w-0 flex-1 flex-col bg-background">
      <div class="h-12 shrink-0 flex items-center gap-2 px-4 titlebar">
        <TitleBarControls class="settings-main-window-controls" />
        <button
          type="button"
          class="settings-back-button interactive h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="返回"
          aria-label="返回上一级"
          @click="goBack"
        >
          <ArrowLeftIcon class="h-4 w-4" />
        </button>
        <h1
          class="flex items-center gap-1.5 text-[length:var(--ui-text-base)] font-medium text-foreground"
        >
          <span>设置</span>
          <span class="text-muted-foreground">/</span>
          <span>{{ activeSectionLabel }}</span>
        </h1>
        <div class="flex-1" />
        <button
          type="button"
          class="settings-menu-button interactive grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          :title="mobileMenuOpen ? '关闭设置菜单' : '打开设置菜单'"
          :aria-expanded="mobileMenuOpen"
          aria-controls="settings-navigation"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          <XIcon v-if="mobileMenuOpen" class="h-4 w-4" />
          <MenuIcon v-else class="h-4 w-4" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="settings-content max-w-2xl mx-auto p-8 flex flex-col gap-8">
          <ThemeSection v-show="activeSection === 'theme'" />
          <BackendSection v-show="activeSection === 'backend'" />
          <!-- v-if 而不是 v-show：SkillsSection 挂载时会扫盘，藏着也扫等于每次开设置页
               都白扫一遍全部技能目录。 -->
          <SkillsSection v-if="activeSection === 'skills'" />
          <!-- 同样用 v-if：McpSection 挂载时会读 5 类配置文件（其中 ~/.claude.json
               可能上百 KB），藏着也扫等于每次开设置页都白读一遍。 -->
          <McpSection v-if="activeSection === 'mcp'" />
          <WorkspaceSection v-show="activeSection === 'workspace'" />
          <ProxySection v-show="activeSection === 'proxy'" />
          <AboutSection v-show="activeSection === 'about'" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AboutSection from '@renderer/components/settings/AboutSection.vue'
import BackendSection from '@renderer/components/settings/BackendSection.vue'
import McpSection from '@renderer/components/settings/McpSection.vue'
import ProxySection from '@renderer/components/settings/ProxySection.vue'
import SkillsSection from '@renderer/components/settings/SkillsSection.vue'
import ThemeSection from '@renderer/components/settings/ThemeSection.vue'
import WorkspaceSection from '@renderer/components/settings/WorkspaceSection.vue'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import {
  PaletteIcon,
  CpuIcon,
  FolderIcon,
  GlobeIcon,
  InfoIcon,
  ArrowLeftIcon,
  MenuIcon,
  SparklesIcon,
  PlugIcon,
  XIcon,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

type SectionId = 'theme' | 'backend' | 'skills' | 'mcp' | 'workspace' | 'proxy' | 'about'

interface NavItem {
  id: SectionId
  label: string
  icon: Component
}

const navItems: NavItem[] = [
  { id: 'theme', label: '外观', icon: PaletteIcon },
  { id: 'backend', label: '后端', icon: CpuIcon },
  { id: 'skills', label: '技能', icon: SparklesIcon },
  { id: 'mcp', label: 'MCP', icon: PlugIcon },
  { id: 'workspace', label: '工作区', icon: FolderIcon },
  { id: 'proxy', label: '网络', icon: GlobeIcon },
  { id: 'about', label: '关于', icon: InfoIcon },
]

const activeSection = ref<SectionId>('theme')
const activeSectionLabel = computed(
  () => navItems.find((item) => item.id === activeSection.value)?.label ?? '',
)
const mobileMenuOpen = ref(false)

const router = useRouter()

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') mobileMenuOpen.value = false
}

function selectSection(section: SectionId): void {
  activeSection.value = section
  mobileMenuOpen.value = false
}

/**
 * 返回上一页——优先用浏览器历史（router.back），
 * 这样从哪进来就回哪去（chat → settings → chat；welcome → settings → welcome）。
 *
 * 兜底：如果用户直接刷新 settings 页（没有历史记录，back 无效），
 * 按 workspace 状态决定去 chat（选过 workspace）还是 welcome（没选过）。
 */
function goBack(): void {
  mobileMenuOpen.value = false
  // router.back() 内部判断 history.length，没有可回退的会 no-op
  // 通过 history.state 判断有没有上一页可回（vue-router 在 history.state 上挂了 back 字段）
  if (window.history.length > 1) {
    router.back()
    return
  }
  // 直接刷新进 settings 的情况——按 workspace 选过与否决定去向
  const lastWorkspaceId = localStorage.getItem('last_workspace_id')
  if (lastWorkspaceId) {
    router.push('/chat')
  } else {
    router.push('/')
  }
}
</script>

<style scoped>
.titlebar {
  -webkit-app-region: drag;
}

.interactive {
  -webkit-app-region: no-drag;
}

.settings-menu-button,
.settings-back-button,
.settings-menu-backdrop,
.settings-main-window-controls {
  display: none;
}

/* Panel Depth: 与主聊天侧栏共用柔焦内阴影，让两种双栏布局保持一致。 */
.settings-sidebar {
  position: relative;
  overflow: hidden;
}

.settings-sidebar::after {
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

@media (max-width: 720px) {
  .settings-sidebar-header {
    display: none;
  }

  .settings-main-window-controls {
    display: flex;
  }

  .settings-menu-button {
    display: grid;
  }

  .settings-back-button {
    display: grid;
  }

  .settings-menu-backdrop {
    position: fixed;
    z-index: 30;
    top: 48px;
    right: 0;
    bottom: 0;
    left: 0;
    display: block;
    border: 0;
    background: color-mix(in oklch, var(--background) 68%, transparent);
    backdrop-filter: blur(3px);
  }

  .settings-sidebar {
    position: fixed;
    z-index: 40;
    top: 48px;
    bottom: 0;
    left: 0;
    width: min(260px, 82vw);
    box-shadow: 18px 0 45px -28px var(--panel-edge-shadow);
    transform: translateX(-100%);
    transition: transform 220ms ease-out;
  }

  .settings-sidebar--open {
    transform: translateX(0);
  }

  .settings-content {
    padding: 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-sidebar {
    transition: none;
  }
}
</style>
