import { claudePermissionToApprovalRequest } from '@main/backend/claude/mapping'
import { describe, expect, test } from 'vitest'

describe('claudePermissionToApprovalRequest', () => {
  test('ExitPlanMode exposes markdown plan without leaking raw input JSON', () => {
    const request = claudePermissionToApprovalRequest('ExitPlanMode', {
      plan: '# 实施计划\n\n1. 修改代码',
      planFilePath: '/tmp/plan.md',
    })

    expect(request).toMatchObject({
      kind: 'mcp',
      title: '计划已准备好',
      detail: '',
      riskLevel: 'low',
      plan: '# 实施计划\n\n1. 修改代码',
    })
    expect(request.detail).not.toContain('planFilePath')
  })
})
