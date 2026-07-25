<template>
  <component :is="component" v-if="component" :data="block.data" />
</template>

<script setup lang="ts">
import { contextTagRegistry } from '@renderer/lib/context-tag-registry'
import type { ContextContentBlock } from '@shared/backend/blocks'
import { computed } from 'vue'

const props = defineProps<{ block: ContextContentBlock }>()
const component = computed(() => contextTagRegistry.get(props.block.tag)?.component)
</script>
