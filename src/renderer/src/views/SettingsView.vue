<template>
  <div class="h-full flex flex-col">
    <!-- 顶部标题栏：窗口控制按钮 + 可拖拽区域 + 标题 + 返回。
         sticky 固定在顶部，滚动内容时始终可见。 -->
    <div
      class="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-border bg-background titlebar"
    >
      <TitleBarControls />
      <button
        type="button"
        class="settings-back-button interactive h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="返回"
        aria-label="返回上一级"
        @click="goBack"
      >
        <ArrowLeftIcon class="h-4 w-4" />
      </button>
      <h1 class="text-[length:var(--ui-text-base)] font-medium text-foreground">设置</h1>
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

    <button
      v-if="mobileMenuOpen"
      type="button"
      class="settings-menu-backdrop"
      aria-label="关闭设置菜单"
      @click="mobileMenuOpen = false"
    />

    <!-- 主体：左侧导航 + 右侧内容 -->
    <div class="flex-1 flex min-h-0">
      <!-- 左侧导航：复用 sidebar token（bg-sidebar / sidebar-accent / sidebar-border），
           跟主会话侧栏共享配色，保持两种布局下"侧栏"视觉一致。右侧内容区沿用 bg-background。 -->
      <nav
        id="settings-navigation"
        :class="[
          'settings-sidebar w-52 shrink-0 border-r border-sidebar-border bg-sidebar p-3 flex flex-col gap-1',
          mobileMenuOpen ? 'settings-sidebar--open' : '',
        ]"
      >
        <!-- 返回按钮：放在外观导航项之上，样式对齐工作区切换按钮
             （hover:bg-sidebar-accent + rounded-md），与下方导航项同间距。 -->
        <button
          class="flex items-center gap-2.5 px-3 py-2 rounded-md text-[length:var(--ui-text-base)] font-medium text-left transition-colors text-muted-foreground hover:bg-sidebar-accent hover:text-foreground interactive cursor-pointer mb-1"
          @click="goBack"
        >
          <ArrowLeftIcon class="w-4 h-4 shrink-0" />
          <span>返回</span>
        </button>
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="[
            'flex items-center gap-2.5 px-3 py-2 rounded-md text-[length:var(--ui-text-base)] text-left transition-colors interactive cursor-pointer',
            activeSection === item.id
              ? 'bg-sidebar-accent text-foreground font-medium'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
          ]"
          @click="selectSection(item.id)"
        >
          <component :is="item.icon" class="w-4 h-4 shrink-0" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <!-- 右侧内容（可滚动） -->
      <div class="flex-1 min-w-0 overflow-y-auto">
        <div class="settings-content max-w-2xl mx-auto p-8 flex flex-col gap-8">
          <ThemeSection v-show="activeSection === 'theme'" />
          <BackendSection v-show="activeSection === 'backend'" />
          <WorkspaceSection v-show="activeSection === 'workspace'" />
          <ProxySection v-show="activeSection === 'proxy'" />

          <section v-show="activeSection === 'about'" class="flex flex-col gap-4">
            <header>
              <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">关于</h2>
            </header>
            <div class="flex items-center gap-3">
              <CatmaxLogo variant="badge" class="w-12 h-12 rounded-[22%]" />
              <div class="text-[length:var(--ui-text-base)] text-muted-foreground space-y-1">
                <div class="text-foreground font-medium">Catmax</div>
                <div>v{{ platformInfo?.appVersion ?? '...' }}</div>
                <div>Electron v{{ platformInfo?.electronVersion ?? '...' }}</div>
                <div>{{ platformInfo?.platform ?? '...' }} {{ platformInfo?.arch ?? '' }}</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import CatmaxLogo from '@renderer/components/icons/CatmaxLogo.vue'
import BackendSection from '@renderer/components/settings/BackendSection.vue'
import ProxySection from '@renderer/components/settings/ProxySection.vue'
import ThemeSection from '@renderer/components/settings/ThemeSection.vue'
import WorkspaceSection from '@renderer/components/settings/WorkspaceSection.vue'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import type { PlatformInfo } from '@shared/ipc/system'
import {
  PaletteIcon,
  CpuIcon,
  FolderIcon,
  GlobeIcon,
  InfoIcon,
  ArrowLeftIcon,
  MenuIcon,
  XIcon,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

type SectionId = 'theme' | 'backend' | 'workspace' | 'proxy' | 'about'

interface NavItem {
  id: SectionId
  label: string
  icon: Component
}

const navItems: NavItem[] = [
  { id: 'theme', label: '外观', icon: PaletteIcon },
  { id: 'backend', label: '后端', icon: CpuIcon },
  { id: 'workspace', label: '工作区', icon: FolderIcon },
  { id: 'proxy', label: '网络', icon: GlobeIcon },
  { id: 'about', label: '关于', icon: InfoIcon },
]

const activeSection = ref<SectionId>('theme')
const mobileMenuOpen = ref(false)

const router = useRouter()
const platformInfo = ref<PlatformInfo | null>(null)

onMounted(async () => {
  platformInfo.value = await window.api.system.platformInfo()
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
.settings-menu-backdrop {
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
    border-top: 1px solid var(--sidebar-border);
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
