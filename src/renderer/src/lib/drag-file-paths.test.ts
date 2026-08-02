import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CATMAX_FILE_MIME, dragHasFiles, readDraggedFiles } from './drag-file-paths'

/** 造一个够用的 DataTransfer 替身——jsdom/happy-dom 的实现不支持任意 setData 类型。 */
function transfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  return {
    types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
    files,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer
}

beforeEach(() => {
  vi.stubGlobal('window', {
    api: { fs: { getPathForFile: (f: File) => `/abs/${f.name}` } },
  })
})

describe('dragHasFiles', () => {
  it('认 OS 文件拖拽', () => {
    expect(dragHasFiles(transfer({}, [new File([], 'a.txt')]))).toBe(true)
  })

  it('认应用内文件树拖拽', () => {
    expect(dragHasFiles(transfer({ [CATMAX_FILE_MIME]: '{}' }))).toBe(true)
  })

  /*
   * 这条是回归测试。VS Code 系编辑器（VS Code / Cursor / Trae …）拖出来时不放
   * `Files`，只放自己那套私有类型 + text/uri-list。判定漏掉它们的话 dragover
   * 不会 preventDefault，drop 事件根本不触发，用户看到的是"拖过去毫无反应"。
   */
  it('认 VS Code 系编辑器的拖拽（它们不放 Files）', () => {
    expect(dragHasFiles(transfer({ 'text/x-vscode-resources': '[]' }))).toBe(true)
    expect(dragHasFiles(transfer({ CodeFiles: '[]' }))).toBe(true)
    expect(dragHasFiles(transfer({ 'text/uri-list': '' }))).toBe(true)
  })

  it('不认纯文本拖拽——否则拖一段选中的字也会弹遮罩', () => {
    expect(dragHasFiles(transfer({ 'text/plain': '/tmp/a.txt' }))).toBe(false)
  })

  /*
   * 判定和解析必须覆盖同一组通道：判定认不了的通道，其解析代码永远跑不到。
   * 这正是 Trae 拖不进来的成因，所以钉一条不变式在这里。
   */
  it('每条解析得出文件的通道，判定都必须认', () => {
    const channels = [
      { [CATMAX_FILE_MIME]: JSON.stringify({ relativePath: 'a.ts', isDirectory: false }) },
      { 'text/x-vscode-resources': JSON.stringify(['file:///tmp/a.ts']) },
      { CodeFiles: JSON.stringify(['/tmp/a.ts']) },
      { 'text/uri-list': 'file:///tmp/a.ts' },
    ]
    for (const data of channels) {
      const dt = transfer(data)
      expect(readDraggedFiles(dt).length, JSON.stringify(data)).toBeGreaterThan(0)
      expect(dragHasFiles(dt), JSON.stringify(data)).toBe(true)
    }
  })
})

describe('readDraggedFiles', () => {
  it('应用内拖拽直接给相对路径，不用再解析', () => {
    const dt = transfer({
      [CATMAX_FILE_MIME]: JSON.stringify({ relativePath: 'src/a.ts', isDirectory: false }),
    })
    expect(readDraggedFiles(dt)).toEqual([{ relativePath: 'src/a.ts' }])
  })

  it('OS 文件拖拽经 preload 桥取绝对路径', () => {
    const dt = transfer({}, [new File([], 'a.txt')])
    expect(readDraggedFiles(dt)).toEqual([{ absolutePath: '/abs/a.txt' }])
  })

  /*
   * VS Code 的 text/uri-list 只写第一个 URI（源码里是 slice(0, 1)），多选拖拽的
   * 其余文件全在私有类型里。顺序反了就会静默只拿到一个文件。
   */
  it('多选时优先读私有清单，而不是只有一条的 uri-list', () => {
    const dt = transfer({
      'text/x-vscode-resources': JSON.stringify(['file:///tmp/a.ts', 'file:///tmp/b.ts']),
      'text/uri-list': 'file:///tmp/a.ts',
    })
    expect(readDraggedFiles(dt)).toEqual([
      { absolutePath: '/tmp/a.ts' },
      { absolutePath: '/tmp/b.ts' },
    ])
  })

  it('私有清单里的裸路径和 file:// URI 都认', () => {
    const dt = transfer({ CodeFiles: JSON.stringify(['/tmp/a.ts', 'file:///tmp/b%20c.ts']) })
    expect(readDraggedFiles(dt)).toEqual([
      { absolutePath: '/tmp/a.ts' },
      { absolutePath: '/tmp/b c.ts' },
    ])
  })

  it('丢弃非本地协议——远程 URI 解析出来也是打不开的引用', () => {
    const dt = transfer({ 'text/uri-list': 'https://example.com/a.ts\nvscode-remote://x/y.ts' })
    expect(readDraggedFiles(dt)).toEqual([])
  })

  it('载荷是坏 JSON 时退到下一条通道，而不是整个失败', () => {
    const dt = transfer({
      'text/x-vscode-resources': '{not json',
      'text/uri-list': 'file:///tmp/a.ts',
    })
    expect(readDraggedFiles(dt)).toEqual([{ absolutePath: '/tmp/a.ts' }])
  })
})
