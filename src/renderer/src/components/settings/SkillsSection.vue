<template>
  <section class="flex flex-col gap-4">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">技能</h2>
        <p class="text-[length:var(--ui-text-base)] text-muted-foreground">
          统一管理多个后端的技能。统一目录是
          <code class="font-mono">~/.agents/skills</code>——codex 原生就读它，其他后端靠软链接过去。
        </p>
      </div>
      <Button size="sm" variant="ghost" :disabled="store.loading" @click="store.refresh()">
        {{ store.loading ? '扫描中…' : '重新扫描' }}
      </Button>
    </header>

    <!-- 关技能的影响范围两边不一样，这条必须一直摆在明面上，不能藏进 tooltip：
         用户以为只在 catmax 里关掉了，结果终端里的 codex 也没了，是很难自己想通的。 -->
    <p
      class="rounded-md border border-border bg-muted/40 p-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      关闭技能对两个后端的影响范围不同：codex 写的是你自己的
      <code class="font-mono">~/.codex/config.toml</code>，<strong>终端里的 codex 也会跟着关</strong
      >；claude 那条只在 catmax 内生效。
    </p>

    <p
      v-if="!store.snapshot.unifiedRoot.writable"
      class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[length:var(--ui-text-d3)] text-foreground"
    >
      统一目录
      <code class="font-mono">{{ store.snapshot.unifiedRoot.path }}</code>
      当前不可写，建软链、迁移和删除都会失败。它可能属于别的用户（有些技能安装器会用 root
      创建这个目录）。可以在终端里执行
      <code class="font-mono">sudo chown -R $USER ~/.agents</code> 后再回来。
    </p>

    <div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-3">
      <Input
        v-model="searchQuery"
        class="min-w-[14rem] flex-1"
        placeholder="搜索技能名称、描述或路径"
        aria-label="搜索技能"
      />
      <DropdownMenu
        v-model="backendFilter"
        :options="backendFilterOptions"
        :trigger-width="148"
        title="按后端可见性筛选"
      />
      <DropdownMenu
        v-model="unifiedFilter"
        :options="unifiedFilterOptions"
        :trigger-width="148"
        title="按统一状态筛选"
      />
      <DropdownMenu
        v-model="syncFilter"
        :options="syncFilterOptions"
        :trigger-width="148"
        title="按同步状态筛选"
      />
      <DropdownMenu
        v-model="enabledFilter"
        :options="enabledFilterOptions"
        :trigger-width="148"
        title="按启用状态筛选"
      />
      <span class="text-[length:var(--ui-text-d3)] text-muted-foreground">
        显示 {{ filteredEntries.length }} / {{ store.entries.length }}
      </span>
    </div>

    <!-- 一键同步串行执行，避免每次 mirror 重写镜像清单时互相覆盖。未统一技能需要迁移，
         这是磁盘移动操作，因此先明确告知用户并要求确认。 -->
    <div
      v-if="pendingSyncEntries.length > 0"
      class="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3 text-[length:var(--ui-text-d3)] text-foreground"
    >
      <span>
        有 {{ pendingSyncEntries.length }} 个技能需要同步（其中
        {{ pendingSyncEntries.filter((entry) => !entry.unified).length }} 个未统一）。
      </span>
      <Button size="sm" variant="ghost" :disabled="syncing" @click="syncAll">
        {{ syncing ? `同步中 ${synced}/${syncTotal}` : '一键全部同步' }}
      </Button>
    </div>

    <p
      v-if="store.lastMessage"
      class="flex items-start justify-between gap-3 rounded-md border border-border bg-muted p-3 text-[length:var(--ui-text-d3)] text-foreground"
    >
      <span>{{ store.lastMessage }}</span>
      <button type="button" class="shrink-0 text-muted-foreground" @click="store.clearMessage()">
        知道了
      </button>
    </p>

    <div class="flex flex-col gap-2">
      <div
        class="grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-1"
        role="tablist"
        aria-label="技能类型"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'system'"
          :class="tabClass(activeTab === 'system')"
          @click="activeTab = 'system'"
        >
          系统技能（全局）
          <span class="opacity-70">{{ filteredGroups.global.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'user'"
          :class="tabClass(activeTab === 'user')"
          @click="activeTab = 'user'"
        >
          用户技能（当前项目）
          <span class="opacity-70">{{ filteredGroups.project.length }}</span>
        </button>
      </div>

      <div role="tabpanel" :aria-label="activeLabel">
        <h3
          class="flex items-center gap-2 px-1 text-[length:var(--ui-text-d3)] font-medium text-muted-foreground"
        >
          {{ activeLabel }}
          <span class="text-muted-foreground/60">{{ activeItems.length }}</span>
        </h3>
        <SkillRow
          v-for="entry in activeItems"
          :key="entry.id"
          :entry="entry"
          :busy="store.busyId === entry.id"
          :platform="platform"
          @toggle="onToggle"
          @open="store.openInEditor"
          @reveal="store.reveal"
          @mirror="store.mirror"
          @migrate="store.migrate"
          @remove="onRemove"
        />
        <p
          v-if="activeItems.length === 0"
          class="px-1 py-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
        >
          {{ activeEmpty }}
        </p>
      </div>
    </div>

    <!-- 读不动的目录要摊出来。当成"没有技能"处理会让用户以为技能丢了。 -->
    <div v-if="store.snapshot.issues.length > 0" class="flex flex-col gap-1">
      <h3 class="px-1 text-[length:var(--ui-text-d3)] font-medium text-muted-foreground">
        扫描时跳过的路径
      </h3>
      <p
        v-for="issue in store.snapshot.issues"
        :key="issue.path"
        class="px-1 font-mono text-[length:var(--ui-text-d3)] text-muted-foreground"
      >
        {{ issue.path }} — {{ issue.message }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import SkillRow from '@renderer/components/skills/SkillRow.vue'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { useSkillsStore } from '@renderer/stores/skills'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import type { SkillEntry } from '@shared/skills/types'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const store = useSkillsStore()
const platform = ref('')
const searchQuery = ref('')
const activeTab = ref<'system' | 'user'>('system')
type BackendFilter = 'all' | BackendId | 'both'
type UnifiedFilter = 'all' | 'unified' | 'not-unified'
type SyncFilter = 'all' | 'synced' | 'needs-sync'
type EnabledFilter = 'all' | 'enabled' | 'disabled'
const backendFilter = ref<BackendFilter>('all')
const unifiedFilter = ref<UnifiedFilter>('all')
const syncFilter = ref<SyncFilter>('all')
const enabledFilter = ref<EnabledFilter>('all')
const syncing = ref(false)
const synced = ref(0)
const syncTotal = ref(0)
const backendFilterOptions: DropdownOption<BackendFilter>[] = [
  { value: 'all', label: '全部后端' },
  { value: 'codex', label: 'Codex 可见' },
  { value: 'claude', label: 'Claude 可见' },
  { value: 'both', label: '两个后端都可见' },
]
const unifiedFilterOptions: DropdownOption<UnifiedFilter>[] = [
  { value: 'all', label: '全部统一状态' },
  { value: 'unified', label: '已统一' },
  { value: 'not-unified', label: '未统一' },
]
const syncFilterOptions: DropdownOption<SyncFilter>[] = [
  { value: 'all', label: '全部同步状态' },
  { value: 'synced', label: '已同步' },
  { value: 'needs-sync', label: '待同步' },
]
const enabledFilterOptions: DropdownOption<EnabledFilter>[] = [
  { value: 'all', label: '全部启用状态' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已关闭' },
]
let releaseFocusRefresh: (() => void) | null = null

onMounted(async () => {
  // 这一页常常是"切出去装个技能再切回来"的用法，不跟着窗口聚焦重扫的话，
  // 用户会对着一份过期列表点「修复」。
  releaseFocusRefresh = store.retainFocusRefresh()
  store.subscribeToBackendChanges()
  platform.value = (await window.api.system.platformInfo()).platform
  await store.refresh()
})

onBeforeUnmount(() => {
  releaseFocusRefresh?.()
  releaseFocusRefresh = null
})

const pendingSyncEntries = computed(() =>
  store.entries.filter((entry) => !entry.unified || entry.visibleTo.length < BACKEND_IDS.length),
)

const filteredEntries = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  return store.entries.filter((entry) => {
    const text = `${entry.name} ${entry.description} ${entry.primary.path}`.toLocaleLowerCase()
    const backendMatch =
      backendFilter.value === 'all' ||
      (backendFilter.value === 'both'
        ? entry.visibleTo.length === BACKEND_IDS.length
        : entry.visibleTo.includes(backendFilter.value))
    const unifiedMatch =
      unifiedFilter.value === 'all' ||
      (unifiedFilter.value === 'unified' ? entry.unified : !entry.unified)
    const syncMatch =
      syncFilter.value === 'all' ||
      (syncFilter.value === 'needs-sync'
        ? !entry.unified || entry.visibleTo.length < BACKEND_IDS.length
        : entry.unified && entry.visibleTo.length === BACKEND_IDS.length)
    const enabledMatch =
      enabledFilter.value === 'all' ||
      (enabledFilter.value === 'enabled' ? entry.enabled : !entry.enabled)
    return (
      (!query || text.includes(query)) && backendMatch && unifiedMatch && syncMatch && enabledMatch
    )
  })
})

const filteredGroups = computed(() => ({
  global: filteredEntries.value.filter((entry) => entry.scope === 'global'),
  project: filteredEntries.value.filter((entry) => entry.scope === 'project'),
}))

const activeItems = computed(() =>
  activeTab.value === 'system' ? filteredGroups.value.global : filteredGroups.value.project,
)
const activeLabel = computed(() =>
  activeTab.value === 'system' ? '系统技能（全局）' : '用户技能（当前项目）',
)
const activeEmpty = computed(() =>
  activeTab.value === 'system'
    ? '~/.agents/skills、~/.codex/skills、~/.claude/skills 下都没有技能'
    : '当前工作区的 .agents/skills、.codex/skills、.claude/skills 下都没有技能',
)

function tabClass(active: boolean): string {
  return [
    'rounded px-2 py-1.5 text-[length:var(--ui-text-d3)] transition-colors',
    active
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  ].join(' ')
}

async function onToggle(entry: SkillEntry, enabled: boolean): Promise<void> {
  await store.setEnabled(entry, enabled)
}

/**
 * 逐条串行，不并发。
 *
 * 每次 mirror 都会重扫并写一次镜像清单，并发跑会互相覆盖清单——清单丢了就等于
 * catmax 认不出自己建的链，以后再也不敢删它们。慢一点换一个不会错的清单。
 * 中途失败不中断：剩下的可能是好的，攒到最后统一报。
 */
async function syncAll(): Promise<void> {
  const entries = [...pendingSyncEntries.value]
  const hasMigration = entries.some((entry) => !entry.unified)
  const message = hasMigration
    ? `将同步 ${entries.length} 个技能，其中未统一的技能会迁移到统一目录并在原位置保留软链。是否继续？`
    : `将为 ${entries.length} 个技能补齐后端可见性。是否继续？`
  if (!window.confirm(message)) return

  syncing.value = true
  synced.value = 0
  syncTotal.value = entries.length
  const failures: string[] = []
  try {
    for (const original of entries) {
      let entry = store.entries.find((candidate) => candidate.id === original.id)
      if (!entry) {
        failures.push(original.name)
        continue
      }
      if (!entry.unified && !(await store.migrate(entry))) {
        failures.push(entry.name)
        continue
      }
      entry = store.entries.find((candidate) => candidate.id === original.id)
      if (entry && entry.visibleTo.length < BACKEND_IDS.length && !(await store.mirror(entry))) {
        failures.push(entry.name)
        continue
      }
      synced.value += 1
    }
  } finally {
    syncing.value = false
  }
  if (failures.length > 0) {
    store.lastMessage = `同步部分完成：${synced.value} 个已处理，${failures.length} 个失败（${failures.join('、')}）`
  } else {
    store.lastMessage = `技能同步完成：${synced.value} 个已处理`
  }
}

async function onRemove(entry: SkillEntry): Promise<void> {
  // 删的是磁盘上的目录，不是一条数据库记录——必须确认，而且要把路径念给用户听。
  if (!window.confirm(`确认删除技能「${entry.name}」？将删除 ${entry.primary.dir}`)) return
  await store.remove(entry)
}
</script>
