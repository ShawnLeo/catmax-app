<template>
  <!-- Unified Skill Center: 一条技能。设置页和新建会话页的 popover 共用同一行，
       两处显示的"可见性/是否在统一目录"必须一模一样，抄两份迟早说法不一致。 -->
  <div class="flex items-start gap-3 rounded-md p-3 hover:bg-muted">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <span
          :class="[
            'font-medium text-[length:var(--ui-text-base)]',
            entry.enabled ? 'text-foreground' : 'text-muted-foreground line-through',
          ]"
        >
          {{ entry.name }}
        </span>

        <!-- 可见性：这是整个功能的核心信息——统一目录 codex 原生就读，claude 必须靠软链。 -->
        <span
          v-for="backend in BACKENDS"
          :key="backend"
          :class="[
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[length:var(--ui-text-d3)]',
            entry.visibleTo.includes(backend)
              ? 'bg-muted text-foreground/70'
              : 'bg-muted/50 text-muted-foreground/60 line-through',
          ]"
          :title="
            entry.visibleTo.includes(backend) ? `${backend} 能读到` : `${backend} 读不到这个技能`
          "
        >
          <BackendIcon :backend="backend" class="h-3 w-3" />
          {{ backend }}
        </span>

        <span
          v-if="readonly"
          class="rounded-full bg-muted/50 px-1.5 py-0.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          title="Codex 内置系统技能，只读"
        >
          系统
        </span>
        <span
          v-else-if="!entry.unified"
          class="rounded-full bg-muted/50 px-1.5 py-0.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          title="它住在某个后端自己的技能目录里，不是统一目录"
        >
          未统一
        </span>
        <span
          v-else-if="mirrored"
          class="rounded-full bg-muted/50 px-1.5 py-0.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          title="统一目录里的真目录 + 后端目录里的软链"
        >
          已镜像
        </span>
      </div>

      <p
        v-if="entry.description"
        class="mt-1 line-clamp-2 text-[length:var(--ui-text-d3)] text-muted-foreground"
      >
        {{ entry.description }}
      </p>

      <div class="mt-1 flex items-center gap-2">
        <span
          class="truncate font-mono text-[length:var(--ui-text-d3)] text-muted-foreground"
          :title="entry.primary.path"
        >
          {{ entry.primary.path }}
        </span>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="sm" :disabled="busy" @click="emit('open', entry)">
          在编辑器中打开
        </Button>
        <Button variant="ghost" size="sm" :disabled="busy" @click="emit('reveal', entry)">
          {{ revealLabel }}
        </Button>
        <Button
          v-if="!readonly && entry.unified && entry.visibleTo.length < 2"
          variant="ghost"
          size="sm"
          :disabled="busy"
          @click="emit('mirror', entry)"
        >
          修复可见性
        </Button>
        <Button
          v-if="!readonly && !entry.unified"
          variant="ghost"
          size="sm"
          :disabled="busy"
          @click="emit('migrate', entry)"
        >
          迁移到统一目录
        </Button>
        <Button
          v-if="!readonly && entry.scope === 'project'"
          variant="ghost"
          size="sm"
          class="text-destructive"
          :disabled="busy"
          @click="emit('remove', entry)"
        >
          删除
        </Button>
      </div>
    </div>

    <button
      v-if="!readonly"
      :class="[
        'relative mt-1 h-6 w-11 shrink-0 rounded-full border-2 shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        busy ? 'cursor-wait opacity-60' : 'cursor-pointer',
        entry.enabled ? 'border-success bg-success' : 'border-foreground/60 bg-muted',
      ]"
      type="button"
      role="switch"
      :aria-checked="entry.enabled"
      :aria-label="`启用技能 ${entry.name}`"
      :disabled="busy"
      @click="emit('toggle', entry, !entry.enabled)"
    >
      <span
        :class="[
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full shadow-md transition-transform',
          entry.enabled ? 'translate-x-5 bg-primary-foreground' : 'bg-foreground',
        ]"
      />
    </button>
  </div>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { Button } from '@renderer/components/ui/button'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import type { SkillEntry } from '@shared/skills/types'
import { computed } from 'vue'

const props = defineProps<{
  entry: SkillEntry
  busy: boolean
  platform: string
  /** 系统技能保留查看/定位操作，但隐藏开关、同步、迁移和删除。 */
  readonly?: boolean
}>()

const emit = defineEmits<{
  toggle: [entry: SkillEntry, enabled: boolean]
  open: [entry: SkillEntry]
  reveal: [entry: SkillEntry]
  mirror: [entry: SkillEntry]
  migrate: [entry: SkillEntry]
  remove: [entry: SkillEntry]
}>()

const BACKENDS = BACKEND_IDS as readonly BackendId[]

const revealLabel = computed(() =>
  props.platform === 'darwin' ? '在访达中显示' : '在文件管理器中显示',
)

/** 统一目录里有真目录、后端目录里有软链 = 已经镜像过了。 */
const mirrored = computed(() => props.entry.locations.some((l) => l.symlink))
</script>
