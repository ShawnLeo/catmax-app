import type { ToolEditInfo } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

import { countLineDiffStats, countUnifiedDiffStats, editDiffStats } from './diff-stats'

describe('countUnifiedDiffStats', () => {
  test('数 +/- 行，跳过 ---/+++ 文件头', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-old one',
      '-old two',
      '+new one',
      '+new two',
      '+new three',
    ].join('\n')
    expect(countUnifiedDiffStats(diff)).toEqual({ additions: 3, deletions: 2 })
  })

  test('codex V4 patch 的标记行不计入', () => {
    const diff = ['*** Update File: src/foo.ts', '@@', '-old', '+new'].join('\n')
    expect(countUnifiedDiffStats(diff)).toEqual({ additions: 1, deletions: 1 })
  })
})

describe('countLineDiffStats', () => {
  test('内容相同为 0', () => {
    expect(countLineDiffStats('a\nb\n', 'a\nb\n')).toEqual({ additions: 0, deletions: 0 })
  })

  test('结尾换行不算多出来的一行', () => {
    expect(countLineDiffStats('', 'a\n')).toEqual({ additions: 1, deletions: 0 })
    expect(countLineDiffStats('', 'a')).toEqual({ additions: 1, deletions: 0 })
  })

  test('纯新增 / 纯删除', () => {
    expect(countLineDiffStats('a\n', 'a\nb\nc\n')).toEqual({ additions: 2, deletions: 0 })
    expect(countLineDiffStats('a\nb\nc\n', 'a\n')).toEqual({ additions: 0, deletions: 2 })
  })

  test('中间夹着未改动行的多处替换靠 LCS 分开算，不整段算全改', () => {
    const before = 'keep1\nold\nkeep2\nkeep3\nold2\nkeep4\n'
    const after = 'keep1\nnew\nkeep2\nkeep3\nnew2\nkeep4\n'
    // 掐掉公共首尾后中间还剩 keep2/keep3 是相同的——不做 LCS 会算成 +4/-4
    expect(countLineDiffStats(before, after)).toEqual({ additions: 2, deletions: 2 })
  })

  test('CRLF 与 LF 混用时不把整段判成全改', () => {
    expect(countLineDiffStats('a\r\nb\r\n', 'a\nb\nc\n')).toEqual({ additions: 1, deletions: 0 })
  })
})

describe('editDiffStats', () => {
  test('unified_diff 直接数 diff 文本', () => {
    const edit: ToolEditInfo = {
      type: 'unified_diff',
      filePath: 'a.ts',
      diff: '@@ -1 +1,2 @@\n-a\n+b\n+c\n',
    }
    expect(editDiffStats(edit)).toEqual({ additions: 2, deletions: 1 })
  })

  test('full_content 只算新增（拿不到旧内容）', () => {
    const edit: ToolEditInfo = { type: 'full_content', filePath: 'a.ts', content: 'a\nb\nc\n' }
    expect(editDiffStats(edit)).toEqual({ additions: 3, deletions: 0 })
  })

  test('MultiEdit 累加每一组替换', () => {
    const edit: ToolEditInfo = {
      type: 'string_replace',
      filePath: 'a.ts',
      oldString: 'x',
      newString: 'y',
      edits: [
        { oldString: 'x', newString: 'y' },
        { oldString: 'p\nq', newString: 'p\nq\nr\ns' },
      ],
    }
    expect(editDiffStats(edit)).toEqual({ additions: 3, deletions: 1 })
  })

  test('数据残缺返回 null，让调用方不渲染徽标', () => {
    expect(editDiffStats({ type: 'unified_diff', filePath: 'a.ts' })).toBeNull()
    expect(editDiffStats({ type: 'full_content', filePath: 'a.ts', content: '' })).toBeNull()
  })
})
