<template>
  <!--
    Claude Settings Profiles: catmax 覆盖配置的档位选择条。
    只管"选哪一档"——档内容仍由外层的编辑器读写（同一个稳定 id，主进程按当前档解析路径），
    所以每次切换/新建/删除后都要 emit change，让外层重新拉 baseline。
  -->
  <div class="flex flex-col gap-2 p-3 rounded-md border border-sidebar-border bg-muted/20">
    <div class="flex items-center gap-1.5">
      <span class="text-[length:var(--ui-text-d3)] font-medium text-foreground">配置档案</span>
      <HelpTooltip>
        可以存多份覆盖配置（比如不同的中转站、不同的模型映射），只有选中的那份会生效。 切换后下一个
        turn 就会用新配置——claude 每个 turn 由 SDK 新起进程。
      </HelpTooltip>
      <span class="text-[length:var(--ui-text-d5)] text-muted-foreground ml-auto">
        {{ snapshot.profiles.length }} / {{ MAX_CLAUDE_SETTINGS_PROFILES }}
      </span>
    </div>

    <!-- 档位胶囊。第一个恒定是「不启用」——原先"文件不存在=完全走本地配置"的语义
         必须留一个显式出口，否则多档之后用户再也回不到"catmax 不做任何覆盖"。 -->
    <div class="flex flex-wrap gap-1.5">
      <button
        type="button"
        :class="pillClass(snapshot.currentId === NO_CLAUDE_SETTINGS_PROFILE)"
        :disabled="busy"
        title="catmax 不做任何覆盖，完全走 ~/.claude 的本地配置"
        @click="select(NO_CLAUDE_SETTINGS_PROFILE)"
      >
        不启用
      </button>

      <template v-for="profile in snapshot.profiles" :key="profile.id">
        <!-- 重命名走 inline input：Electron 里没有可用的 window.prompt -->
        <Input
          v-if="renamingId === profile.id"
          :ref="bindRenameInput"
          v-model="nameDraft"
          :maxlength="CLAUDE_SETTINGS_PROFILE_NAME_MAX"
          class="h-7 w-40 text-[length:var(--ui-text-d3)]"
          @keydown.enter.prevent="commitRename()"
          @keydown.esc.prevent="cancelRename()"
          @blur="commitRename()"
        />
        <button
          v-else
          type="button"
          :class="pillClass(snapshot.currentId === profile.id)"
          :disabled="busy"
          :title="profile.path"
          @click="select(profile.id)"
        >
          <span class="truncate max-w-[10rem]">{{ profile.name }}</span>
          <!-- managed = 内测登录自动维护的那一档，改名/删除会让登录态和档对不上 -->
          <LockIcon v-if="profile.managed" class="w-3 h-3 opacity-60" />
          <span v-if="!profile.exists" class="text-[length:var(--ui-text-d5)] opacity-60">
            未创建
          </span>
        </button>
      </template>

      <!-- 新建同样是 inline input，默认名让用户直接回车即可 -->
      <Input
        v-if="creating"
        ref="createInput"
        v-model="nameDraft"
        :maxlength="CLAUDE_SETTINGS_PROFILE_NAME_MAX"
        class="h-7 w-40 text-[length:var(--ui-text-d3)]"
        placeholder="配置名称"
        @keydown.enter.prevent="commitCreate()"
        @keydown.esc.prevent="cancelCreate()"
        @blur="commitCreate()"
      />
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size="sm" :disabled="busy || atLimit" @click="startCreate(false)">
        <PlusIcon class="w-3.5 h-3.5" />
        新建
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="busy || atLimit || !currentProfile"
        title="复制当前档的内容新建一份"
        @click="startCreate(true)"
      >
        <CopyIcon class="w-3.5 h-3.5" />
        另存为
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="busy || !currentProfile || currentProfile.managed"
        @click="startRename()"
      >
        <PencilIcon class="w-3.5 h-3.5" />
        重命名
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class="text-destructive hover:text-destructive"
        :disabled="busy || !currentProfile || currentProfile.managed"
        @click="remove()"
      >
        <Trash2Icon class="w-3.5 h-3.5" />
        {{ confirmingDelete ? '确认删除？' : '删除' }}
      </Button>
      <span v-if="error" class="text-[length:var(--ui-text-d3)] text-destructive ml-auto">
        {{ error }}
      </span>
    </div>

    <p
      v-if="snapshot.currentId === NO_CLAUDE_SETTINGS_PROFILE"
      class="text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      当前不启用任何覆盖配置，catmax 内的 claude 会话完全按 <code>~/.claude</code> 的本地配置运行。
    </p>
    <p
      v-else-if="currentProfile?.managed"
      class="text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      这一档由内测登录自动生成和清理，不能改名或删除——退出登录时会连同其中的密钥一起删掉。
    </p>
  </div>
</template>

<script setup lang="ts">
import HelpTooltip from '@renderer/components/settings/HelpTooltip.vue'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useAuthStore } from '@renderer/stores/auth'
import {
  CLAUDE_SETTINGS_PROFILE_NAME_MAX,
  MAX_CLAUDE_SETTINGS_PROFILES,
  NO_CLAUDE_SETTINGS_PROFILE,
  type ClaudeSettingsProfilesSnapshot,
} from '@shared/backend/claude-settings-profiles'
import { CopyIcon, LockIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-vue-next'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

/**
 * 每次快照变化（含首次加载）都推给外层：换档就是换文件，外层手上的 mtime 基线
 * 属于上一档，必须重新读。外层据此判断 path 有没有变，所以重复 emit 是幂等的。
 */
const emit = defineEmits<{ update: [snapshot: ClaudeSettingsProfilesSnapshot] }>()

const snapshot = ref<ClaudeSettingsProfilesSnapshot>({
  currentId: NO_CLAUDE_SETTINGS_PROFILE,
  profiles: [],
})
const busy = ref(false)
const error = ref<string | null>(null)

const creating = ref(false)
const renamingId = ref<string | null>(null)
const nameDraft = ref('')
/** 删除是两段式：第一次点变成「确认删除？」，第二次才真删——没有原生 confirm 可用 */
const confirmingDelete = ref(false)

const currentProfile = computed(
  () => snapshot.value.profiles.find((p) => p.id === snapshot.value.currentId) ?? null,
)
const atLimit = computed(() => snapshot.value.profiles.length >= MAX_CLAUDE_SETTINGS_PROFILES)

function pillClass(active: boolean): string[] {
  return [
    'flex items-center gap-1.5 px-2.5 h-7 rounded-md border text-[length:var(--ui-text-d3)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
    active
      ? 'border-foreground bg-foreground text-background'
      : 'border-sidebar-border text-muted-foreground hover:text-foreground hover:bg-muted',
  ]
}

/** 所有写操作走同一条路：拿返回的完整快照替换本地状态，不自己拼增量 */
async function run(action: () => Promise<ClaudeSettingsProfilesSnapshot>): Promise<void> {
  busy.value = true
  error.value = null
  confirmingDelete.value = false
  try {
    snapshot.value = await action()
    emit('update', snapshot.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function refresh(): Promise<void> {
  try {
    snapshot.value = await window.api.backend.listClaudeProfiles()
    emit('update', snapshot.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function select(id: string): Promise<void> {
  if (snapshot.value.currentId === id) return
  await run(async () => window.api.backend.selectClaudeProfile({ id }))
}

// —— 新建 / 另存为 ——

/** 另存为时记住源档：input 期间用户可能已经看不到当前档了 */
const copyFromId = ref<string | null>(null)

function startCreate(copyCurrent: boolean): void {
  copyFromId.value = copyCurrent ? snapshot.value.currentId : null
  nameDraft.value = copyCurrent
    ? `${currentProfile.value?.name ?? '配置'} 副本`
    : `配置 ${snapshot.value.profiles.length + 1}`
  creating.value = true
  renamingId.value = null
  void nextTick(() => createInput.value?.$el?.focus?.())
}

function cancelCreate(): void {
  creating.value = false
  copyFromId.value = null
}

async function commitCreate(): Promise<void> {
  if (!creating.value) return
  const name = nameDraft.value
  const from = copyFromId.value
  cancelCreate()
  await run(async () =>
    window.api.backend.createClaudeProfile({
      name,
      // exactOptionalPropertyTypes：没有源档时整个字段不带，不能显式传 undefined
      ...(from ? { copyFromId: from } : {}),
    }),
  )
}

// —— 重命名 ——

function startRename(): void {
  const profile = currentProfile.value
  if (!profile || profile.managed) return
  nameDraft.value = profile.name
  renamingId.value = profile.id
  creating.value = false
  // 不用 nextTick 定位：这个 input 在 v-for 里，模板 ref 会被收集成数组，
  // 直接在挂载回调里 focus 更省事（见 bindRenameInput）
}

function cancelRename(): void {
  renamingId.value = null
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  if (!id) return
  const name = nameDraft.value
  cancelRename()
  const profile = snapshot.value.profiles.find((p) => p.id === id)
  if (!profile || name.trim() === profile.name) return
  await run(async () => window.api.backend.renameClaudeProfile({ id, name }))
}

// —— 删除 ——

async function remove(): Promise<void> {
  const profile = currentProfile.value
  if (!profile || profile.managed) return
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  await run(async () => window.api.backend.deleteClaudeProfile({ id: profile.id }))
}

// Input 是 shadcn-vue 风格的组件封装（根元素就是原生 input），focus 要穿透到 $el
type InputRef = { $el?: HTMLInputElement } | null
const createInput = ref<InputRef>(null)

/** 重命名的 input 在 v-for 里，模板 ref 会被收集成数组——用函数 ref 在挂载那一刻直接 focus */
function bindRenameInput(el: unknown): void {
  const input = (el as { $el?: HTMLInputElement } | null)?.$el
  if (input) {
    input.focus()
    input.select()
  }
}

/*
 * Internal Beta Login: 登录/登出会由 main 直接增删「catmax 内测」那一档并切过去。
 *
 * 这条链路和桥的 provider 不对称，所以必须显式跟：桥的 provider 存在 settings.json，
 * 由 renderer 经 settings.update 写，settings store 是响应式的，那一节会自己刷新；
 * 而档的元数据在 main 的 index.json 里（档内容含明文密钥，只能 main 写），
 * renderer 这边没有任何东西会通知我们。不跟的话，设置页开着时登录，
 * 档位条会一直停在登录前的列表，而编辑器已经在编辑内测档了。
 */
const auth = useAuthStore()
watch(
  () => auth.loggedIn,
  () => void refresh(),
)

onMounted(() => void refresh())
defineExpose({ refresh })
</script>
