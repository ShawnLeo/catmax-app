/**
 * PoC #3：验证 SDK canUseTool 回调 options 携带的"富信息"。
 * （这是"透传 SDK 权限富信息 + 修复 approve_always"改动的依据）
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 结论（2026-07 实测）：canUseTool 的 options 参数带丰富信息：         │
 * │   - displayName:    "Write"（友好动作名）                            │
 * │   - description:    "/tmp/x.txt"（目标）                             │
 * │   - decisionReason: "Path is outside allowed working directories"    │
 * │   - title:          "Claude wants to ..."（bridge 整句）              │
 * │   - suggestions:    PermissionUpdate[]（approve_always 时应原样作为   │
 * │                      updatedPermissions 回传，让"本会话都允许"真生效）│
 * │                                                                     │
 * │ 意义：之前 app 只用了 toolName+input，丢掉了这些。透传后权限面板能   │
 * │ 显示 SDK 原生友好文案，且 approve_always 真正持久化（回传 suggestions）│
 * │ 生产实现见 mapping.ts 的 claudePermissionToApprovalRequest(meta)     │
 * │ 和 adapter.ts 的 canUseTool。                                        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 运行：node poc/03-canusetool-rich-info.mjs
 *
 * 前置：需已 claude 登录。会真实创建 /tmp/test-canusetool.txt（可事后删）。
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

let n = 0
const q = query({
  prompt: '读一下 package.json 的第一行，然后创建一个 /tmp/test-canusetool.txt 文件，内容随便',
  options: {
    permissionMode: 'default',
    includePartialMessages: true,
    canUseTool: async (toolName, input, options) => {
      n++
      console.log(`\n--- canUseTool 调用 #${n} ---`)
      console.log(`  toolName: ${toolName}`)
      console.log(`  title: "${options.title || '(无)'}"`)
      console.log(`  displayName: "${options.displayName || '(无)'}"`)
      console.log(`  description: "${options.description || '(无)'}"`)
      console.log(`  decisionReason: "${options.decisionReason || '(无)'}"`)
      console.log(`  blockedPath: "${options.blockedPath || '(无)'}"`)
      console.log(`  toolUseID: ${options.toolUseID}`)
      console.log(`  matchedAskRule: ${JSON.stringify(options.matchedAskRule) || '(无)'}`)
      console.log(
        `  suggestions: ${options.suggestions ? JSON.stringify(options.suggestions).slice(0, 120) : '(无)'}`,
      )
      console.log(`  input: ${JSON.stringify(input).slice(0, 120)}`)
      // 全部放行（PoC 只观察 options 内容）
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

for await (const m of q) {
  if (m.type === 'result') {
    console.log(`\n[result] ${m.subtype}`)
    break
  }
}
console.log(`总共 canUseTool 调用: ${n}`)
console.log('\n观察重点：suggestions 字段 —— 这就是 approve_always 该回传的 updatedPermissions')
