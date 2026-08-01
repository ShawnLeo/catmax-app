import type { NormalizedMessage, ToolEditInfo } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

import { buildReviewFilesFromMessages, sumReviewStats } from './review'

let seq = 0

/** 构造一条只带一个 tool_call 块的 assistant 消息 */
function toolMessage(
  edit: ToolEditInfo | undefined,
  status: 'running' | 'completed' | 'failed' = 'completed',
  turnId = 't1',
): NormalizedMessage {
  seq += 1
  return {
    id: `m${seq}`,
    role: 'assistant',
    turnId,
    createdAt: seq,
    blocks: [
      {
        id: `b${seq}`,
        type: 'tool_call',
        status,
        info: {
          kind: 'file_edit',
          title: edit?.filePath ?? '',
          ...(edit ? { edit } : {}),
        },
      },
    ],
  } as NormalizedMessage
}

const CWD = '/Users/shawn/proj'

describe('buildReviewFilesFromMessages', () => {
  test('绝对路径相对 cwd 化', () => {
    const files = buildReviewFilesFromMessages(
      [
        toolMessage({
          type: 'string_replace',
          filePath: `${CWD}/src/a.ts`,
          oldString: 'a',
          newString: 'b',
        }),
      ],
      CWD,
    )
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('src/a.ts')
  })

  test('工作区外的文件保留绝对路径', () => {
    const files = buildReviewFilesFromMessages(
      [toolMessage({ type: 'full_content', filePath: '/tmp/x.ts', content: 'a\n' })],
      CWD,
    )
    expect(files[0]!.path).toBe('/tmp/x.ts')
  })

  test('同一文件多次编辑合并成一条，stats 累加、edits 保序', () => {
    const files = buildReviewFilesFromMessages(
      [
        toolMessage({
          type: 'string_replace',
          filePath: `${CWD}/a.ts`,
          oldString: 'x',
          newString: 'y',
        }),
        toolMessage({
          type: 'string_replace',
          filePath: `${CWD}/a.ts`,
          oldString: 'p\nq',
          newString: 'p\nq\nr',
        }),
      ],
      CWD,
    )
    expect(files).toHaveLength(1)
    expect(files[0]!.stats).toEqual({ additions: 2, deletions: 1 })
    expect(files[0]!.edits).toHaveLength(2)
    expect(files[0]!.edits![1]!.newString).toBe('p\nq\nr')
  })

  test('Write 让该文件算作新增', () => {
    const files = buildReviewFilesFromMessages(
      [toolMessage({ type: 'full_content', filePath: `${CWD}/new.ts`, content: 'a\nb\n' })],
      CWD,
    )
    expect(files[0]!.kind).toBe('add')
    expect(files[0]!.stats).toEqual({ additions: 2, deletions: 0 })
  })

  test('running / failed 的调用不计入——还没改成的东西不该出现在审查清单里', () => {
    const edit: ToolEditInfo = {
      type: 'string_replace',
      filePath: `${CWD}/a.ts`,
      oldString: 'x',
      newString: 'y',
    }
    expect(buildReviewFilesFromMessages([toolMessage(edit, 'running')], CWD)).toHaveLength(0)
    expect(buildReviewFilesFromMessages([toolMessage(edit, 'failed')], CWD)).toHaveLength(0)
  })

  test('非编辑工具（无 edit）被忽略', () => {
    expect(buildReviewFilesFromMessages([toolMessage(undefined)], CWD)).toHaveLength(0)
  })
})

describe('sumReviewStats', () => {
  test('合计多个文件', () => {
    expect(
      sumReviewStats([
        { path: 'a', kind: 'update', stats: { additions: 2, deletions: 1 } },
        { path: 'b', kind: 'add', stats: { additions: 5, deletions: 0 } },
      ]),
    ).toEqual({ additions: 7, deletions: 1 })
  })
})
