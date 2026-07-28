import type { BackendCapabilities } from './types'

export const CODEX_CAPABILITIES: BackendCapabilities = {
  supportsInterrupt: true,
  supportsApproval: true,
  supportsSteer: true,
  supportsThreadFork: true,
  supportsModelSelection: true,
  supportsEffort: true,
  supportsPermissionMode: true,
  supportedPermissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
  supportedEfforts: ['low', 'medium', 'high'],
  supportsHotSwap: false,
  chat: {
    subAgents: false,
    compact: true,
    planMode: true,
    webTools: true,
    blockTypes: [
      'text',
      'reasoning',
      'tool_call',
      'context',
      'compact_divider',
      'plan',
      'codex_user_input',
      'codex_activity',
    ],
  },
}

export const CLAUDE_CAPABILITIES: BackendCapabilities = {
  supportsInterrupt: true,
  supportsApproval: true,
  supportsSteer: true,
  supportsThreadFork: false,
  supportsModelSelection: true,
  supportsEffort: true,
  supportsPermissionMode: true,
  supportedPermissionModes: [
    'default',
    'acceptEdits',
    'auto',
    'plan',
    'dontAsk',
    'bypassPermissions',
  ],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsHotSwap: true,
  chat: {
    subAgents: true,
    compact: true,
    planMode: true,
    webTools: true,
    blockTypes: ['text', 'reasoning', 'tool_call', 'context', 'compact_divider'],
  },
}
