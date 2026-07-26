/**
 * Review File Tree 构建：把扁平的 CodexFileChange.path 列表聚合成嵌套目录树。
 *
 * 抽成纯函数模块——便于单测，且不依赖 Vue 运行时。
 * path 在各平台都是 / 风格（codex 协议保证），统一用 / 切分。
 */
import type { CodexFileChange } from '@shared/backend/blocks'

/** 树节点。目录节点有 children；文件节点带原始 change 数据。 */
export interface ReviewTreeNode {
  name: string
  /** 完整路径：目录是前缀路径，文件是 change.path */
  path: string
  dir: boolean
  children: ReviewTreeNode[]
  /** 仅文件节点有 */
  change?: CodexFileChange
}

/**
 * 把 files 聚合成树。目录在前、文件在后，同类按名字升序（类 IDE 排序）。
 * 共享前缀的文件会归到同一目录节点下（如 a/b.ts 与 a/c.ts 都在 a/ 下）。
 */
export function buildReviewTree(files: CodexFileChange[]): ReviewTreeNode[] {
  const root: ReviewTreeNode = { name: '', path: '', dir: true, children: [] }
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    let cursor = root
    segments.forEach((seg, idx) => {
      const isLeaf = idx === segments.length - 1
      // 同名时按 dir/leaf 区分（理论上同名目录与文件不会共存，但稳妥起见）
      let child = cursor.children.find((c) => c.name === seg && c.dir === !isLeaf)
      if (!child) {
        child = {
          name: seg,
          path: segments.slice(0, idx + 1).join('/'),
          dir: !isLeaf,
          children: [],
          ...(isLeaf ? { change: file } : {}),
        }
        cursor.children.push(child)
      }
      cursor = child
    })
  }
  return sortReviewNodes(root.children)
}

/** 收集所有目录路径，用于默认全部展开 */
export function collectReviewDirPaths(files: CodexFileChange[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join('/'))
    }
  }
  return [...dirs]
}

function sortReviewNodes(nodes: ReviewTreeNode[]): ReviewTreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const n of sorted) n.children = sortReviewNodes(n.children)
  return sorted
}
