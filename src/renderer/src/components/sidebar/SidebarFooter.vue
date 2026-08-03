<template>
  <!--
    Sidebar Footer: 侧栏底部的用户区。
    内测登录态接入后：点击头像弹出菜单（设置 / 退出登录），
    登录方式（密钥登录）作为账号标签展示在头像右侧。
  -->
  <div ref="rootRef" class="sidebar-footer relative p-2 border-t border-sidebar-border bg-sidebar">
    <div class="flex items-center gap-1">
      <!-- 用户头像按钮：点击弹出设置/退出菜单 -->
      <button
        class="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-sidebar-accent text-left cursor-pointer"
        :title="accountLabel"
        :aria-expanded="menuOpen"
        aria-haspopup="menu"
        @click="toggleMenu"
      >
        <!-- 头像：登录后用品牌色，未登录用中性灰 -->
        <div
          class="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
          :class="authStore.loggedIn ? 'bg-primary/15' : 'bg-sidebar-accent'"
        >
          <UserIcon
            class="w-3.5 h-3.5"
            :class="authStore.loggedIn ? 'text-primary' : 'text-muted-foreground'"
          />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[length:var(--ui-text-d3)] text-foreground truncate">
            {{ accountLabel }}
          </div>
        </div>
      </button>
    </div>

    <!-- 账号菜单：向上弹出（footer 贴近窗口底部），点击外部 / Esc 关闭 -->
    <div
      v-if="menuOpen"
      class="absolute bottom-full left-2 right-2 mb-2 z-50 rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="menu"
      aria-label="账号"
    >
      <button
        type="button"
        role="menuitem"
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--ui-text-d3)] text-foreground hover:bg-accent cursor-pointer"
        @click="onOpenSettings"
      >
        <SettingsIcon class="w-4 h-4" />
        <span>设置</span>
      </button>
      <button
        type="button"
        role="menuitem"
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--ui-text-d3)] text-foreground hover:bg-accent cursor-pointer"
        @click="onLogout"
      >
        <LogOutIcon class="w-4 h-4" />
        <span>退出登录</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '@renderer/stores/auth'
import { LogOutIcon, SettingsIcon, UserIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const authStore = useAuthStore()

const menuOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)

// 账号标签：登录后展示登录方式，未登录兜底（守卫保证聊天页内一定已登录）
const accountLabel = computed(() => {
  if (!authStore.loggedIn) return '未登录'
  return authStore.loginMethod === 'secret-key' ? '通过密钥登录' : '已登录'
})

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}

function closeMenu(): void {
  menuOpen.value = false
}

function onOpenSettings(): void {
  closeMenu()
  router.push('/settings')
}

async function onLogout(): Promise<void> {
  closeMenu()
  // 退出登录前确认，避免误点（参考截图的确认交互）
  if (!window.confirm('确定退出登录吗？退出后需要重新输入密钥才能使用。')) return
  await authStore.logout()
  // logout 后 loggedIn=false，路由守卫会自动重定向到 /login
}

// 点击外部 / Esc 关闭菜单（inline popover 惯例，见 ProjectSkillsPopover）
function onDocumentPointerDown(event: PointerEvent): void {
  if (!menuOpen.value) return
  if (rootRef.value?.contains(event.target as Node)) return
  closeMenu()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<style scoped>
/* Panel Depth: 底部操作栏轻微浮在会话列表之上，阴影向上柔和发散。 */
.sidebar-footer {
  position: relative;
  z-index: 10;
  box-shadow: 0 -8px 20px -14px var(--panel-edge-shadow);
}
</style>
