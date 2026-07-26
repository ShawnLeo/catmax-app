import { parseUnifiedDiffHunks, v4PatchToCodexFileChanges } from '@shared/backend/v4-patch'
import { describe, expect, it } from 'vitest'

/**
 * v4PatchToCodexFileChanges 单测：把 V4 patch input 转成 CodexFileChange[]。
 * 重点验证：每文件 diff 是该文件的 V4 子段（含头行），stats 按 +/- 行计数。
 */
describe('v4PatchToCodexFileChanges', () => {
  it('非 V4 格式返回空数组', () => {
    expect(v4PatchToCodexFileChanges('standard unified diff')).toEqual([])
    expect(v4PatchToCodexFileChanges('')).toEqual([])
  })

  it('Add File：diff 含头行 + + 行，stats 全是 additions', () => {
    const input = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+import foo',
      '+export const bar = 1',
      '*** End Patch',
    ].join('\n')
    const changes = v4PatchToCodexFileChanges(input)
    expect(changes).toHaveLength(1)
    const c = changes[0]!
    expect(c.path).toBe('src/new.ts')
    expect(c.kind).toBe('add')
    expect(c.stats).toEqual({ additions: 2, deletions: 0 })
    // diff 是该文件的 V4 子段（头行 + body）
    expect(c.diff).toBe('*** Add File: src/new.ts\n+import foo\n+export const bar = 1')
  })

  it('Update File：stats 正确切分 additions/deletions', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@',
      ' keep',
      '-old',
      '+new',
      '@@',
      ' keep2',
      '+added2',
      '*** End Patch',
    ].join('\n')
    const changes = v4PatchToCodexFileChanges(input)
    expect(changes).toHaveLength(1)
    const c = changes[0]!
    expect(c.kind).toBe('update')
    expect(c.stats).toEqual({ additions: 2, deletions: 1 })
    // diff 包含头行、@@、所有 body 行
    expect(c.diff).toContain('*** Update File: src/main.ts')
    expect(c.diff).toContain('@@')
    expect(c.diff).toContain('-old')
    expect(c.diff).toContain('+new')
  })

  it('Delete File：stats 全是 deletions', () => {
    const input = [
      '*** Begin Patch',
      '*** Delete File: src/old.ts',
      ' line1',
      ' line2',
      '*** End Patch',
    ].join('\n')
    const changes = v4PatchToCodexFileChanges(input)
    // Delete File 的行是空格开头（上下文），不计入 +/-，stats 为 0/0
    expect(changes[0]?.kind).toBe('delete')
    expect(changes[0]?.stats).toEqual({ additions: 0, deletions: 0 })
  })

  it('多文件 patch：每个文件独立一个 CodexFileChange', () => {
    const input = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+a1',
      '*** Update File: b.ts',
      '@@',
      ' ctx',
      '-old',
      '+new',
      '*** Delete File: c.ts',
      ' c1',
      '*** End Patch',
    ].join('\n')
    const changes = v4PatchToCodexFileChanges(input)
    expect(changes.map((c) => c.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(changes.map((c) => c.kind)).toEqual(['add', 'update', 'delete'])
    // 每个文件的 diff 只含自己的子段，不含其他文件
    expect(changes[0]?.diff).toBe('*** Add File: a.ts\n+a1')
    expect(changes[1]?.diff).toBe('*** Update File: b.ts\n@@\n ctx\n-old\n+new')
    expect(changes[1]?.stats).toEqual({ additions: 1, deletions: 1 })
  })

  it('每个文件的 diff 不含 Begin/End Patch 标记', () => {
    const input = ['*** Begin Patch', '*** Add File: a.ts', '+x', '*** End Patch'].join('\n')
    const diff = v4PatchToCodexFileChanges(input)[0]!.diff
    expect(diff).not.toContain('*** Begin Patch')
    expect(diff).not.toContain('*** End Patch')
  })

  it('真实样本：用本机 codex 会话的 V4 patch 结构能正确解析', () => {
    // 模拟实测的 codex apply_patch input 结构
    const input = [
      '*** Begin Patch',
      '*** Update File: /abs/path/src/foo.ts',
      '@@',
      ' import { a } from "a"',
      ' ',
      '-import { b } from "b"',
      '+import { c } from "c"',
      '@@',
      ' export function foo() {',
      '+  return c',
      ' }',
      '*** End Patch',
    ].join('\n')
    const changes = v4PatchToCodexFileChanges(input)
    expect(changes).toHaveLength(1)
    const c = changes[0]!
    expect(c.path).toBe('/abs/path/src/foo.ts')
    expect(c.kind).toBe('update')
    expect(c.stats).toEqual({ additions: 2, deletions: 1 })
    // diff 能被渲染器 extractFileFromV4Patch 重新解析（路径归一化匹配）
  })
})

/**
 * parseUnifiedDiffHunks 单测：解析无文件头的标准 unified diff（codex patch_apply_end 格式）。
 * 直接以 `@@ -a,b +c,d @@` 开头，缺 `---`/`+++` 文件头。
 */
describe('parseUnifiedDiffHunks', () => {
  it('无 @@ hunk 头返回 null', () => {
    expect(parseUnifiedDiffHunks('just text\nno hunk')).toBeNull()
    expect(parseUnifiedDiffHunks('')).toBeNull()
  })

  it('单个 hunk：context/+/- 正确切分到 old/new', () => {
    // 模拟 codex patch_apply_end 的 unified_diff（无文件头）
    const diff = ['@@ -8,2 +8,19 @@', ' context line', '-removed', '+added', ' tail'].join('\n')
    const r = parseUnifiedDiffHunks(diff)
    expect(r).not.toBeNull()
    // context + 删除 → old；context + 新增 → new
    expect(r!.oldContent).toBe('context line\nremoved\ntail')
    expect(r!.newContent).toBe('context line\nadded\ntail')
  })

  it('多个 hunk 按顺序拼成完整 old/new', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,1 +10,1 @@', ' c', '-d', '+D'].join(
      '\n',
    )
    const r = parseUnifiedDiffHunks(diff)!
    expect(r.oldContent).toBe('a\nb\nc\nd')
    expect(r.newContent).toBe('a\nB\nc\nD')
  })

  it('纯新增 hunk（全是 + 行）old 为空', () => {
    const diff = ['@@ -1,0 +1,3 @@', '+x', '+y', '+z'].join('\n')
    const r = parseUnifiedDiffHunks(diff)!
    expect(r.oldContent).toBe('')
    expect(r.newContent).toBe('x\ny\nz')
  })

  it('忽略 \\ No newline 标记', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n')
    const r = parseUnifiedDiffHunks(diff)!
    expect(r.oldContent).toBe('old')
    expect(r.newContent).toBe('new')
  })

  it('带文件头（--- / +++）也能解析：hunk 头之前的内容忽略', () => {
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')
    const r = parseUnifiedDiffHunks(diff)!
    expect(r.oldContent).toBe('a')
    expect(r.newContent).toBe('b')
  })

  it('真实样本：codex patch_apply_end 格式（@@ -166,6 +166,49 @@）能解析', () => {
    const diff = [
      '@@ -166,6 +166,49 @@',
      ' ',
      '-const userMessageItemSchema = z.object({',
      "-  type: z.literal('user_message'),",
      '+const textElementSchema = z',
      '+  .object({',
      '+    byteRange: z.object({ start: z.number(), end: z.number() }),',
      '   id: z.string(),',
    ].join('\n')
    const r = parseUnifiedDiffHunks(diff)!
    // 删除的 2 行进 old，新增的 3 行进 new，上下文 2 行进两边
    expect(r.oldContent).toContain('const userMessageItemSchema')
    expect(r.oldContent).toContain('id: z.string(),')
    expect(r.newContent).toContain('const textElementSchema')
    expect(r.newContent).toContain('id: z.string(),')
  })
})
