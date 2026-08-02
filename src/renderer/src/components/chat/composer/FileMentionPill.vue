<template>
  <!--
    File Mention: 输入框上方的一条文件引用。

    蓝色描边呼应输入框里 `@路径` 的高亮——两者是同一个东西的两种展示，
    颜色对不上就看不出关联了。

    图标三态：图片显示缩略图，文件夹和普通文件都交给 FileTypeIcon（跟文件树同一套
    material 图标，文件夹按名字还能给出 src / docs / test 之类的专用图案）。
    元数据是异步来的，没到之前先按普通文件画，到了再换——占位尺寸一致，
    pill 宽度不会在加载完成的瞬间跳一下。
  -->
  <div
    class="group inline-flex items-center gap-1.5 pl-1 pr-1 py-0.5 rounded-md border border-primary/30 bg-primary/10 text-primary text-[length:var(--chat-text-d1)] max-w-full"
    :title="mention.path"
  >
    <img
      v-if="thumbnail"
      :src="thumbnail"
      alt=""
      class="w-4 h-4 flex-shrink-0 rounded-sm object-cover bg-background/40"
    />
    <!-- 文件夹图标画得比文件图标大一圈——引用一整个目录跟引用单个文件是两回事，
         尺寸差是最先被扫到的那个信号。 -->
    <FileTypeIcon
      v-else
      :name="name"
      :is-directory="isDirectory"
      :class="isDirectory ? 'w-[18px] h-[18px]' : 'w-4 h-4'"
      class="flex-shrink-0"
    />
    <span class="truncate max-w-[280px] font-mono">{{ name }}</span>
    <button
      type="button"
      class="flex-shrink-0 p-0.5 rounded hover:bg-primary/20 transition-colors cursor-pointer"
      title="移除引用"
      aria-label="移除引用"
      @click="emit('remove')"
    >
      <XIcon class="w-3 h-3" />
    </button>
  </div>
</template>

<script setup lang="ts">
import FileTypeIcon from '@renderer/components/panel/FileTypeIcon.vue'
import type { FileMention } from '@renderer/lib/file-mention'
import { readMentionPreview } from '@renderer/lib/mention-preview'
import { basename } from '@renderer/lib/path'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { XIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ mention: FileMention }>()
const emit = defineEmits<{ remove: [] }>()

const workspaceStore = useWorkspaceStore()
const thumbnail = ref<string | null>(null)
const isDirectory = ref(false)

const name = computed(() => basename(props.mention.path))

watch(
  () => [props.mention.path, workspaceStore.currentWorkspace?.id] as const,
  async ([path, workspaceId]) => {
    thumbnail.value = null
    isDirectory.value = false
    if (!workspaceId || !path) return
    const preview = await readMentionPreview(workspaceId, path)
    // 等待期间这条 pill 可能已经指向别的文件了——答案对不上当前路径就丢掉。
    if (props.mention.path !== path || !preview) return
    thumbnail.value = preview.thumbnail
    isDirectory.value = preview.isDirectory
  },
  { immediate: true },
)
</script>
