<template>
  <div class="h-full flex flex-col">
    <!-- 顶部标题栏：窗口控制按钮 + 可拖拽区域。
         与 WelcomeView/SettingsView 一致（h-12），保证登录页拖拽行为统一。 -->
    <div
      class="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-border bg-background titlebar"
    >
      <TitleBarControls />
    </div>

    <!-- 主体：居中登录卡片 -->
    <div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
      <div class="login-logo-glow flex flex-col items-center gap-4">
        <CatmaxLogo variant="plain" class="w-20 h-20" />
        <div class="text-center">
          <h1 class="text-[length:var(--ui-text-display)] font-bold text-foreground">Catmax</h1>
          <p class="mt-2 text-muted-foreground">输入密钥以进入内测版</p>
        </div>
      </div>

      <!-- 登录表单：Enter 提交，密钥为空时禁用按钮。 -->
      <form class="w-full max-w-sm flex flex-col gap-3" @submit.prevent="onSubmit">
        <Input
          v-model="secretKey"
          type="password"
          :placeholder="'Catmax 密钥'"
          autocomplete="current-password"
          :disabled="submitting"
          :autofocus="!autoFocused"
          aria-label="Catmax 密钥"
          ref="inputRef"
        />
        <p v-if="errorMsg" class="text-[length:var(--ui-text-d3)] text-destructive" role="alert">
          {{ errorMsg }}
        </p>
        <Button type="submit" size="lg" :disabled="!canSubmit">
          {{ submitting ? '登录中…' : '登录' }}
        </Button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import CatmaxLogo from '@renderer/components/icons/CatmaxLogo.vue'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAuthStore } from '@renderer/stores/auth'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const authStore = useAuthStore()

const secretKey = ref('')
const submitting = ref(false)
const errorMsg = ref('')
const inputRef = ref<{ $el?: HTMLInputElement } | null>(null)
const autoFocused = ref(false)

const canSubmit = computed(() => secretKey.value.trim().length > 0 && !submitting.value)

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  errorMsg.value = ''
  try {
    const status = await authStore.login(secretKey.value)
    if (status.loggedIn) {
      // 登录成功后回到欢迎页；路由守卫此时已放行。
      router.push('/')
    } else {
      errorMsg.value = '登录失败，请检查密钥'
    }
  } catch {
    errorMsg.value = '登录失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  // 自动聚焦输入框，方便直接输入密钥。
  await nextTick()
  const el = (inputRef.value?.$el ?? null) as HTMLInputElement | null
  el?.focus()
  autoFocused.value = true
})
</script>

<style scoped>
.titlebar {
  -webkit-app-region: drag;
}

/* Login Ambience: 复用 WelcomeView 的低对比径向光晕，保持视觉一致。 */
.login-logo-glow {
  position: relative;
  isolation: isolate;
}

.login-logo-glow::before {
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
