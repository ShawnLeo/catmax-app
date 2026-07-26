import type { CodexFileChange } from '@shared/backend/blocks'
import { describe, expect, it } from 'vitest'

import { buildReviewTree, collectReviewDirPaths } from './review-tree'

/** 构造最小可用的 CodexFileChange（只关心 path/stats，diff 可选） */
function fc(path: string, additions = 0, deletions = 0, diff?: string): CodexFileChange {
  return {
    id: path,
    type: 'codex_user_input',
    kind: 'image',
    path,
    stats: { additions, deletions },
    ...(diff !== undefined ? { diff } : {}),
  } as unknown as CodexFileChange
}

describe('buildReviewTree', () => {
  it('顶层文件直接作为根节点（无目录）', () => {
    const tree = buildReviewTree([fc('README.md', 3, 1), fc('package.json', 10, 2)])
    expect(tree).toHaveLength(2)
    expect(tree.every((n) => !n.dir && n.children.length === 0)).toBe(true)
    // 文件按名字升序：package.json < README.md（localeCompare 大小写差异）
    expect(tree.map((n) => n.name)).toEqual(['package.json', 'README.md'])
  })

  it('共享前缀的文件归到同一目录节点', () => {
    const tree = buildReviewTree([fc('src/a.ts', 1, 0), fc('src/b.ts', 0, 1)])
    expect(tree).toHaveLength(1)
    const src = tree[0]
    expect(src?.dir).toBe(true)
    expect(src?.name).toBe('src')
    expect(src?.path).toBe('src')
    expect(src?.children).toHaveLength(2)
    expect(src?.children.every((c) => !c.dir)).toBe(true)
  })

  it('目录排在文件前面（类 IDE 排序）', () => {
    const tree = buildReviewTree([fc('z-file.ts'), fc('src/a.ts'), fc('README.md')])
    // 期望顺序：src(目录) → README.md → z-file.ts
    expect(tree.map((n) => n.name)).toEqual(['src', 'README.md', 'z-file.ts'])
    expect(tree[0]?.dir).toBe(true)
    expect(tree[1]?.dir).toBe(false)
  })

  it('多层嵌套目录正确建树', () => {
    const tree = buildReviewTree([fc('src/main/backend/foo.ts', 5, 5)])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.name).toBe('src')
    expect(tree[0]?.children[0]?.name).toBe('main')
    expect(tree[0]?.children[0]?.children[0]?.name).toBe('backend')
    // 最深层是文件节点，带 change
    const leaf = tree[0]?.children[0]?.children[0]?.children[0]
    expect(leaf?.dir).toBe(false)
    expect(leaf?.change?.path).toBe('src/main/backend/foo.ts')
    expect(leaf?.change?.stats.additions).toBe(5)
  })

  it('不同分支的文件不混入同一目录', () => {
    const tree = buildReviewTree([fc('src/a.ts'), fc('test/b.ts')])
    expect(tree.map((n) => n.name)).toEqual(['src', 'test'])
    expect(tree[0]?.children[0]?.name).toBe('a.ts')
    expect(tree[1]?.children[0]?.name).toBe('b.ts')
  })

  it('空数组返回空树', () => {
    expect(buildReviewTree([])).toEqual([])
  })

  it('重复路径去重（同一 path 只保留一个文件节点）', () => {
    // codex 同 path 的 change 会被 CodexTurn 的 Map 去重，但这里也兜底
    const tree = buildReviewTree([fc('a.ts', 1, 0), fc('a.ts', 2, 2)])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.change?.stats.additions).toBe(1) // 第一个胜出
  })
})

describe('collectReviewDirPaths', () => {
  it('收集所有中间目录路径（不含文件本身）', () => {
    const dirs = collectReviewDirPaths([fc('src/main/foo.ts'), fc('src/bar.ts'), fc('baz.ts')])
    expect(dirs.sort()).toEqual(['src', 'src/main'])
  })

  it('顶层文件不产生目录', () => {
    expect(collectReviewDirPaths([fc('a.ts'), fc('b.ts')])).toEqual([])
  })

  it('去重共享目录前缀', () => {
    const dirs = collectReviewDirPaths([fc('src/a.ts'), fc('src/b.ts'), fc('src/c.ts')])
    expect(dirs).toEqual(['src'])
  })
})
