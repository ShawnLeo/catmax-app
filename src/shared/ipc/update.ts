/**
 * Hot Update IPC 契约（设计文档 §5.6、§5.7）。
 *
 * renderer 只消费结论，不参与任何决策：验签、版本守门、"能不能重启"全部在 main 侧
 * 判定完再下发。这条边界的实际意义是**门禁只有一份实现**——若 renderer 自己去判断
 * 有没有活跃 turn，两边的规则迟早分叉，而分叉的后果是用户在有会话运行时点了重启，
 * 那些 turn 被 `recoverInterrupted()` 不可逆地标成 interrupted。
 */

export type HotUpdateState = 'idle' | 'checking' | 'downloading' | 'staged' | 'error'

export interface HotUpdateStatus {
  /**
   * 热更新是否可用。dev 模式下 bootstrap 没参与启动，整个功能关闭——
   * renderer 据此完全隐藏更新入口，而不是显示一个永远点不动的按钮。
   */
  supported: boolean
  state: HotUpdateState
  /** 当前运行的版本，形如 `0.1.0 (h3)`；无热更新时就是宿主版本 */
  currentVersion: string
  /** 已下载待生效的版本，仅 state === 'staged' 时有值 */
  stagedVersion?: string
  releaseNotes?: string
  /** 仅手动检查失败时有值（自动检查失败不打扰用户） */
  error?: string
  lastCheckAt?: number
  /**
   * 未结算的 turn 数量。大于 0 时不能重启（§5.7）。
   *
   * 下发数量而不是布尔，是因为 UI 要说清"还有 N 个会话正在运行"——把按钮置灰
   * 却不说为什么，用户只会以为坏了。而这里绝不能改成弹一个"确定要中断吗"：
   * 用户在这个场景下几乎总会误点，代价是那些 turn 被不可逆地标成 interrupted。
   */
  activeTurns: number
}

export type UpdatePushEvents = {
  /** 状态每次变化都全量下发，renderer 直接替换即可——状态很小，增量不值得 */
  'update:statusChanged': HotUpdateStatus
}

export type UpdateHandlers = {
  'update.getStatus': () => Promise<HotUpdateStatus>
  /** 手动检查。与自动检查的唯一区别是失败会回传 error 供 UI 展示 */
  'update.check': () => Promise<HotUpdateStatus>
  /** 重启以应用更新。有活跃 turn 时 main 会拒绝并回传原因 */
  'update.apply': () => Promise<{ ok: boolean; reason?: string }>
}
