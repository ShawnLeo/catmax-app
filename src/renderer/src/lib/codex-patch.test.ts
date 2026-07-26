import { describe, expect, it } from 'vitest'

import { extractFileFromV4Patch, parseV4Patch } from './codex-patch'

describe('parseV4Patch', () => {
  it('非 V4 格式（无 *** Begin Patch）返回空数组', () => {
    expect(parseV4Patch('diff --git a/foo b/foo\n@@ -1,3 +1,3 @@')).toEqual([])
    expect(parseV4Patch('')).toEqual([])
  })

  it('Add File：newContent 为 + 行，oldContent 为空', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+import foo',
      '+',
      '+export const bar = 1',
      '*** End Patch',
    ].join('\n')
    const files = parseV4Patch(patch)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual({
      path: 'src/new.ts',
      kind: 'add',
      oldContent: '',
      newContent: 'import foo\n\nexport const bar = 1',
    })
  })

  it('Delete File：oldContent 为原文，newContent 为空', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: src/old.ts',
      ' import foo',
      ' export const bar = 1',
      '*** End Patch',
    ].join('\n')
    const files = parseV4Patch(patch)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual({
      path: 'src/old.ts',
      kind: 'delete',
      oldContent: 'import foo\nexport const bar = 1',
      newContent: '',
    })
  })

  it('Update File：context/+/- 正确切分到 old 和 new', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@',
      ' keep line',
      '-old line',
      '+new line',
      '*** End Patch',
    ].join('\n')
    const files = parseV4Patch(patch)
    expect(files).toHaveLength(1)
    const f = files[0]!
    expect(f.kind).toBe('update')
    // context + 删除 → old；context + 新增 → new
    expect(f.oldContent).toBe('keep line\nold line')
    expect(f.newContent).toBe('keep line\nnew line')
  })

  it('Update File：多个 @@ 段按顺序拼成完整内容', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      ' line1',
      '-old2',
      '+new2',
      '@@',
      ' line3',
      '+new4',
      '*** End Patch',
    ].join('\n')
    const files = parseV4Patch(patch)
    const f = files[0]!
    expect(f.oldContent).toBe('line1\nold2\nline3')
    expect(f.newContent).toBe('line1\nnew2\nline3\nnew4')
  })

  it('多文件 patch：每个文件独立切分', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+a content',
      '*** Update File: b.ts',
      '@@',
      ' ctx',
      '-old',
      '+new',
      '*** Delete File: c.ts',
      ' c content',
      '*** End Patch',
    ].join('\n')
    const files = parseV4Patch(patch)
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(files.map((f) => f.kind)).toEqual(['add', 'update', 'delete'])
  })

  it('Add File 里单独的 + 表示空行', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+line1',
      '+',
      '+line3',
      '*** End Patch',
    ].join('\n')
    expect(parseV4Patch(patch)[0]?.newContent).toBe('line1\n\nline3')
  })

  it('Update File 里空行（真·空字符串）按上下文处理', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      ' line1',
      '',
      ' line3',
      '*** End Patch',
    ].join('\n')
    const f = parseV4Patch(patch)[0]!
    // 空行（非空格前缀）兜底当上下文：old/new 都有
    expect(f.oldContent).toBe('line1\n\nline3')
    expect(f.newContent).toBe('line1\n\nline3')
  })

  it('缺少 End Patch 也能解析（到文件尾）', () => {
    const patch = ['*** Begin Patch', '*** Add File: a.ts', '+x'].join('\n')
    expect(parseV4Patch(patch)).toHaveLength(1)
  })
})

describe('extractFileFromV4Patch', () => {
  it('按 path 从多文件 patch 提取对应文件', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+a',
      '*** Update File: b.ts',
      '@@',
      ' ctx',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
    const b = extractFileFromV4Patch(patch, 'b.ts')
    expect(b).toEqual({ oldContent: 'ctx\nold', newContent: 'ctx\nnew' })
  })

  it('找不到对应文件返回 null', () => {
    const patch = ['*** Begin Patch', '*** Add File: a.ts', '+a', '*** End Patch'].join('\n')
    expect(extractFileFromV4Patch(patch, 'zzz.ts')).toBeNull()
  })

  it('绝对路径与相对路径能匹配', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /abs/path/src/foo.ts',
      '@@',
      ' ctx',
      '+added',
      '*** End Patch',
    ].join('\n')
    // UI 传相对路径 src/foo.ts，应能匹配到绝对路径的那段
    expect(extractFileFromV4Patch(patch, 'src/foo.ts')).not.toBeNull()
  })

  it('非 V4 格式返回 null', () => {
    expect(extractFileFromV4Patch('standard unified diff', 'foo.ts')).toBeNull()
  })
})
