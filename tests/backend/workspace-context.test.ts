import {
  buildWorkspaceInstructions,
  secondaryWorkspacePaths,
} from '@main/backend/workspace-context'
import { describe, expect, test } from 'vitest'

const folders = [
  { id: 'p', path: '/code/app', alias: 'app', role: 'primary' as const },
  { id: 's', path: '/code/docs', alias: 'docs', role: 'secondary' as const },
]

describe('multi-root workspace backend context', () => {
  test('生成共享目录说明且不要求全量扫描', () => {
    const instructions = buildWorkspaceInstructions(folders)
    expect(instructions).toContain('Primary [app]: /code/app')
    expect(instructions).toContain('Secondary [docs]: /code/docs')
    expect(instructions).toContain('Do not scan every folder eagerly')
  })

  test('只把次文件夹加入额外授权路径', () => {
    expect(secondaryWorkspacePaths(folders)).toEqual(['/code/docs'])
  })
})
