<template>
  <section class="flex flex-col gap-4">
    <header>
      <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">网络代理</h2>
      <p class="text-[length:var(--ui-text-base)] text-muted-foreground">
        为后端 CLI（codex / claude）注入 HTTPS_PROXY 环境变量。 macOS
        系统代理不会自动传给命令行工具，需要在这里显式配置。
      </p>
    </header>

    <!-- 启用开关 -->
    <div class="flex items-center justify-between">
      <label class="text-[length:var(--ui-text-base)] font-medium">启用代理</label>
      <div class="flex items-center gap-2">
        <span
          :class="[
            'text-[length:var(--ui-text-d3)] font-medium',
            proxy.enabled ? 'text-success' : 'text-muted-foreground',
          ]"
        >
          {{ proxy.enabled ? '已开启' : '已关闭' }}
        </span>
        <button
          :class="[
            'relative w-11 h-6 rounded-full border-2 shadow-sm transition-colors cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            proxy.enabled ? 'border-success bg-success' : 'border-foreground/60 bg-muted',
          ]"
          type="button"
          role="switch"
          :aria-checked="proxy.enabled"
          aria-label="启用代理"
          @click="toggleEnabled"
        >
          <span
            :class="[
              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full shadow-md transition-transform',
              proxy.enabled ? 'translate-x-5 bg-primary-foreground' : 'bg-foreground',
            ]"
          />
        </button>
      </div>
    </div>

    <!-- 代理 URL -->
    <div class="flex items-center justify-between gap-3">
      <label class="text-[length:var(--ui-text-base)] font-medium whitespace-nowrap"
        >代理 URL</label
      >
      <Input
        :model-value="proxy.url ?? ''"
        placeholder="http://127.0.0.1:7890"
        :disabled="!proxy.enabled"
        class="flex-1"
        @update:model-value="(v: string | number) => updateField('url', String(v))"
      />
    </div>

    <!-- bypass -->
    <div class="flex items-center justify-between gap-3">
      <label class="text-[length:var(--ui-text-base)] font-medium whitespace-nowrap"
        >不走代理的域名</label
      >
      <Input
        :model-value="proxy.bypass ?? ''"
        placeholder="localhost,127.0.0.1,*.local"
        :disabled="!proxy.enabled"
        class="flex-1"
        @update:model-value="(v: string | number) => updateField('bypass', String(v))"
      />
    </div>

    <!-- 操作按钮 -->
    <div class="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" :disabled="detecting" @click="detectSystemProxy">
        {{ detecting ? '检测中...' : '一键检测系统代理' }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!proxy.enabled || !proxy.url || testing"
        @click="testProxy"
      >
        {{ testing ? '测试中...' : '测试连通性' }}
      </Button>
    </div>

    <!-- 检测结果 / 状态 -->
    <div
      v-if="statusMessage"
      :class="[
        'text-[length:var(--ui-text-d3)] px-3 py-2 rounded-md',
        statusKind === 'error'
          ? 'bg-destructive/5 text-destructive'
          : statusKind === 'success'
            ? 'bg-success/5 text-success'
            : 'bg-muted text-muted-foreground',
      ]"
    >
      {{ statusMessage }}
    </div>

    <!-- 重要提示 -->
    <div
      class="text-[length:var(--ui-text-d3)] text-muted-foreground space-y-1 px-3 py-2 bg-muted/30 rounded-md"
    >
      <p>⚠️ 改了代理设置后：</p>
      <ul class="list-disc ml-5 space-y-0.5">
        <li>新发起的 turn 会用新代理（claude 是 per-turn process，立即生效）</li>
        <li>codex 是 long-running 进程，需要切走 codex 再切回来（让它重新 spawn）</li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/stores/settings'
import type { HttpProxy } from '@shared/settings-schema'
import { computed, ref } from 'vue'

const settings = useSettingsStore()

const proxy = computed<HttpProxy>(
  () =>
    settings.settings?.httpProxy ?? {
      enabled: false,
      url: null,
      bypass: null,
    },
)

const detecting = ref(false)
const testing = ref(false)
const statusMessage = ref<string | null>(null)
const statusKind = ref<'info' | 'success' | 'error'>('info')

function setStatus(msg: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  statusMessage.value = msg
  statusKind.value = kind
}

async function toggleEnabled(): Promise<void> {
  const next: HttpProxy = { ...proxy.value, enabled: !proxy.value.enabled }
  await settings.update({ httpProxy: next })
  setStatus(next.enabled ? '代理已启用' : '代理已禁用', 'info')
}

async function updateField(field: 'url' | 'bypass', value: string): Promise<void> {
  const next: HttpProxy = {
    ...proxy.value,
    [field]: value || null, // 空字符串存为 null
  }
  await settings.update({ httpProxy: next })
}

async function detectSystemProxy(): Promise<void> {
  detecting.value = true
  setStatus('正在检测系统代理...', 'info')
  try {
    const detected = await window.api.system.detectProxy()
    if (!detected.enabled) {
      setStatus(
        '未检测到系统代理（macOS 用 scutil --proxy，Linux 看 env，Windows 看注册表）',
        'error',
      )
      return
    }
    // 把检测结果写入 settings
    const next: HttpProxy = {
      enabled: true,
      url: detected.url,
      bypass: detected.bypass,
    }
    await settings.update({ httpProxy: next })
    setStatus(`已检测到并应用（来源：${detected.source}）：${detected.url}`, 'success')
  } catch (e) {
    setStatus(`检测失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    detecting.value = false
  }
}

async function testProxy(): Promise<void> {
  testing.value = true
  setStatus('测试中（请求 https://api.openai.com，5 秒超时）...', 'info')
  try {
    // 用 fetch + AbortController 实现超时——走的是渲染层的代理（Electron session）
    // 注意：这个测试只能反映渲染层连通性，codex/claude 走的是子进程代理（HTTPS_PROXY env）
    // 但两者用同样的代理 URL，所以测试通过通常意味着子进程也能通。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const start = Date.now()
    try {
      const resp = await fetch('https://api.openai.com/v1/models', {
        signal: ctrl.signal,
        // 不带认证，期望 401（说明能连上）
      })
      clearTimeout(timer)
      const elapsed = Date.now() - start
      setStatus(`连通 ✓ HTTP ${resp.status}（${elapsed}ms）—— 401 表示能连上但需认证`, 'success')
    } catch (e) {
      clearTimeout(timer)
      const elapsed = Date.now() - start
      setStatus(`连通失败 ✗ ${e instanceof Error ? e.message : String(e)}（${elapsed}ms）`, 'error')
    }
  } finally {
    testing.value = false
  }
}
</script>
