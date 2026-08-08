<template>
  <!--
    About Section: 关于页。

    - Logo 用 plain 变体，跟随主题前景色（日间黑猫 / 夜间白猫），跟主聊天页/欢迎页一致，
      不再用 badge 变体的深色方块。
    - 版本号优先取热更新 store 的 currentVersion（形如 `0.1.0 (h3)`，含热更新序号）；
      dev 模式下热更新关闭（supported=false）则回退到 appVersion。
  -->
  <section class="flex flex-col items-center gap-8 py-4">
    <!-- 品牌：居中 Logo + 应用名 -->
    <div class="about-logo-glow flex flex-col items-center gap-3">
      <CatmaxLogo variant="plain" class="w-20 h-20" />
      <div class="text-center">
        <h2 class="text-[length:var(--ui-text-display)] font-bold text-foreground">Catmax</h2>
        <p class="mt-1 text-[length:var(--ui-text-base)] text-muted-foreground">
          {{ tagline }}
        </p>
      </div>
    </div>

    <!-- 信息卡片：版本 / 运行环境。三行结构相同，直接铺开避免为三行抽组件。 -->
    <div class="about-info-card w-full max-w-md rounded-lg border border-border bg-card/60">
      <!-- 版本 -->
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class="shrink-0 text-muted-foreground text-[length:var(--ui-text-base)]">版本</span>
        <span
          class="min-w-0 text-right font-mono tabular-nums text-[length:var(--ui-text-d2)] text-foreground"
        >
          <span class="truncate">{{ versionLabel }}</span>
          <span
            v-if="hotVersionHint"
            class="ml-2 font-sans text-[length:var(--ui-text-d4)] text-muted-foreground"
            >{{ hotVersionHint }}</span
          >
        </span>
      </div>

      <div class="h-px bg-border/70" />

      <!-- Electron -->
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class="shrink-0 text-muted-foreground text-[length:var(--ui-text-base)]"
          >Electron</span
        >
        <span
          class="min-w-0 truncate text-right font-mono tabular-nums text-[length:var(--ui-text-d2)] text-foreground"
        >
          {{ platformInfo?.electronVersion ?? '—' }}
        </span>
      </div>

      <div class="h-px bg-border/70" />

      <!-- 系统 -->
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class="shrink-0 text-muted-foreground text-[length:var(--ui-text-base)]">系统</span>
        <span
          class="min-w-0 truncate text-right font-mono tabular-nums text-[length:var(--ui-text-d2)] text-foreground"
        >
          {{ osLabel }}
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import CatmaxLogo from '@renderer/components/icons/CatmaxLogo.vue'
import { useUpdateStore } from '@renderer/stores/update'
import type { PlatformInfo } from '@shared/ipc/system'
import { computed, ref } from 'vue'

const platformInfo = ref<PlatformInfo | null>(null)
const updateStore = useUpdateStore()

async function loadPlatformInfo(): Promise<void> {
  platformInfo.value = await window.api.system.platformInfo()
}
void loadPlatformInfo()

const tagline = '本地优先的 AI 编程伙伴'

/** 优先用热更新版本（含 hN 序号），不可用时回退到宿主 appVersion。 */
const versionLabel = computed(() => {
  const hot = updateStore.status.currentVersion
  if (hot) return hot
  return platformInfo.value?.appVersion ?? '—'
})

/** 热更新不可用（dev 模式）时给个小提示，避免用户困惑为什么没有 hN。 */
const hotVersionHint = computed(() =>
  updateStore.status.supported ? undefined : '开发模式（热更新未启用）',
)

const osLabel = computed(() => {
  const info = platformInfo.value
  if (!info) return '—'
  const platformName =
    info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : 'Linux'
  const archName = info.arch === 'arm64' ? 'ARM64' : 'x64'
  return `${platformName} · ${archName} · ${info.osVersion}`
})
</script>

<style scoped>
/* About Ambience: 与欢迎页空状态一致的低对比径向光晕，不形成可见边界。 */
.about-logo-glow {
  position: relative;
  isolation: isolate;
}

.about-logo-glow::before {
  position: absolute;
  z-index: -1;
  top: 40%;
  left: 50%;
  width: 300px;
  height: 300px;
  border-radius: 9999px;
  content: '';
  pointer-events: none;
  background: radial-gradient(
    circle,
    color-mix(in oklch, var(--foreground) 5%, transparent) 0,
    color-mix(in oklch, var(--foreground) 2%, transparent) 43%,
    transparent 72%
  );
  transform: translate(-50%, -50%);
}
</style>
