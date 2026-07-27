<template>
  <CompactHistoryEntry :summary="block.summary" />
</template>

<script setup lang="ts">
import type { CompactDividerContentBlock } from '@shared/backend/blocks'

import CompactHistoryEntry from '../../messages/CompactHistoryEntry.vue'

defineProps<{ block: CompactDividerContentBlock }>()
</script>
