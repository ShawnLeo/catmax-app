/**
 * Hot Update: 渲染层状态。
 *
 * 这个 store 只做一件事——把 main 推来的状态原样存下来。它**不判断**能不能更新、
 * 能不能重启：验签、版本守门、活跃 turn 门禁全在 main（`service/hot-update.ts`），
 * renderer 拿到的是结论。理由是门禁只能有一份实现，两边各写一套迟早分叉，
 * 而分叉的代价是用户在有会话运行时重启，那些 turn 不可逆地变成 interrupted。
 */
import type { HotUpdateStatus } from '@shared/ipc/update'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useUpdateStore = defineStore('update', () => {
  const status = ref<HotUpdateStatus>({
    supported: false,
    state: 'idle',
    currentVersion: '',
    activeTurns: 0,
  })
  const applying = ref(false)

  let unsubscribe: (() => void) | null = null

  /** 卡片只在"已下载待重启"时出现——其余状态（检查中/下载中）对用户没有价值，
   *  静默进行才符合 §5.6 的"整个过程对用户静默，只有到达 staged 才提示一次"。 */
  const showCard = computed(() => status.value.supported && status.value.state === 'staged')

  async function init(): Promise<void> {
    status.value = await window.api.update.getStatus()
    unsubscribe?.()
    unsubscribe = window.api.update.onStatusChanged((next) => {
      status.value = next
    })
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  async function check(): Promise<void> {
    status.value = await window.api.update.check()
  }

  /**
   * 触发重启。成功时进程会直接退出，所以 `applying` 不需要复位——
   * 只有被 main 拒绝（有活跃 turn）时才会走到后面的分支。
   */
  async function apply(): Promise<{ ok: boolean; reason?: string }> {
    applying.value = true
    const result = await window.api.update.apply()
    if (!result.ok) applying.value = false
    return result
  }

  return { status, applying, showCard, init, dispose, check, apply }
})
