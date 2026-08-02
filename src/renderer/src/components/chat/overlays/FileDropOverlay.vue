<template>
  <!--
    File Mention: 拖拽文件时盖在主聊天列上的投放区。

    盖住整列（含消息流和输入框）而不只是输入框——用户不该为了引用一个文件去
    瞄准一个 100px 高的目标。虚线框圈出的范围就是能松手的范围，见 useChatFileDrop
    里「生效边界 = 视觉边界」的说明。

    自身必须吃指针事件（不能 pointer-events-none）——drop 事件要落在这一层上。

    z-30 压住聊天区内的一切，但低于侧栏/右栏浮层的 z-40：窄窗口下从浮着的文件树
    往外拖时，遮罩不该把拖拽的起点盖掉。
  -->
  <Transition name="file-drop">
    <div
      v-if="active"
      class="absolute inset-0 z-30 flex items-center justify-center p-4 bg-background/80 backdrop-blur-[2px]"
      @dragover.prevent
      @drop="emit('drop', $event)"
    >
      <div
        class="w-full h-full rounded-2xl border-2 border-dashed border-primary/60 bg-primary/5 flex flex-col items-center justify-center gap-3 text-center px-6"
      >
        <FilePlusIcon class="w-9 h-9 text-primary" />
        <p class="text-[length:var(--ui-text-u2)] font-medium text-foreground">拖拽文件到会话中</p>
        <p class="max-w-sm text-[length:var(--ui-text-d2)] text-muted-foreground leading-relaxed">
          松开后会以 <span class="font-mono text-primary">@路径</span> 的形式加进输入框
        </p>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { FilePlusIcon } from 'lucide-vue-next'

defineProps<{ active: boolean }>()
const emit = defineEmits<{ drop: [event: DragEvent] }>()
</script>

<style scoped>
/* 淡入即可——拖拽中的遮罩做位移动画会让人误以为投放目标在动。 */
.file-drop-enter-active,
.file-drop-leave-active {
  transition: opacity 120ms ease-out;
}
.file-drop-enter-from,
.file-drop-leave-to {
  opacity: 0;
}
</style>
