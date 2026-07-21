/**
 * 评估命令/操作的风险等级——给 approval UI 决定默认按钮焦点 + destructive 视觉用。
 *
 * 抽出来 shared 是因为 codex 和 claude 都要用：
 * - codex: shell_command / file_edit / mcp 都从这里评估
 * - claude: 同样评估（claude adapter 的 claudePermissionToApprovalRequest 调用）
 */
import type { ApprovalRequest } from '@shared/backend/types'

export function assessRisk(
  kind: ApprovalRequest['kind'],
  detail: string,
): 'low' | 'medium' | 'high' {
  if (kind === 'shell_command') {
    if (
      /^(git status|git log|git diff|git branch|ls|ll|cat|pwd|echo|grep|find|rg|fd|head|tail|wc|which)\b/.test(
        detail,
      )
    ) {
      return 'low'
    }
    if (
      /\b(rm|git push --force|git push -f|git reset --hard|npm publish|sudo|chmod|chown|dd|mkfs|curl|wget)\b/.test(
        detail,
      )
    ) {
      return 'high'
    }
    return 'medium'
  }
  if (kind === 'file_edit') return 'medium'
  if (kind === 'mcp') return 'medium'
  return 'medium'
}
