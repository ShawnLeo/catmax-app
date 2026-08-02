/**
 * Composer Autocomplete: `@` 文件/文件夹联想。
 *
 * 复用现成的 fs IPC，没有新增通道：
 * - query 为空或以 `/` 结尾 → readDirectory 列这一层（「浏览」语义）
 * - 其它 → searchFiles 全工作区搜（「搜索」语义）
 *
 * 两种语义合成一个输入框的效果是：打 `@` 先看到根目录，选中 `src/` 后接着看到
 * src 下面一层，中途随时改打 `@Composer` 就变成全局搜索。用户不用知道自己在
 * 哪个模式里。
 *
 * 插进去的文本形态由 formatFileMention 决定，跟拖放/右键/「+」按钮完全一致——
 * 所以联想选中的文件立刻会被 parseFileMentions 认出来，蓝色高亮和上方的引用
 * pill 自动就有了，这里一行相关代码都不用写。
 */
import { formatFileMention } from '@renderer/lib/file-mention'
import { dirname } from '@renderer/lib/path'
import type { DirEntry } from '@shared/ipc/fs'

import { charTrigger } from '../trigger'
import type { SuggestionContext, SuggestionItem, SuggestionProvider, TriggerMatch } from '../types'

/**
 * 一次最多给多少条。
 *
 * 弹层只有 ~6 行可视高度，给太多没人会滚到底，却会让每次按键的 IPC 变重
 * （searchWorkspace 是有上限的磁盘遍历，limit 直接决定它什么时候停）。
 */
const MAX_RESULTS = 30

export const fileSuggestionProvider: SuggestionProvider = {
  id: 'file',
  detect: charTrigger({ char: '@' }),
  emptyText: '没有匹配的文件',

  async search(match: TriggerMatch, ctx: SuggestionContext): Promise<SuggestionItem[]> {
    const { workspaceId } = ctx
    if (!workspaceId) return []
    const query = match.query

    // 浏览语义：`@` 刚打下（空 query）列根目录，`@src/` 列 src 这一层。
    if (query === '' || query.endsWith('/')) {
      const entries = await listDirectory(workspaceId, query)
      // 目录不存在时（用户手打了个不存在的路径）回退到搜索，而不是给个空列表
      if (entries) return entries.slice(0, MAX_RESULTS).map(toItem)
      if (query === '') return []
    }

    const entries = await window.api.fs.searchFiles({ workspaceId, query, limit: MAX_RESULTS })
    return entries.map(toItem)
  },
}

/** 列一层目录；路径不存在或读不了返回 null（交给调用方决定回退）。 */
async function listDirectory(workspaceId: string, query: string): Promise<DirEntry[] | null> {
  try {
    return await window.api.fs.readDirectory({
      workspaceId,
      relativePath: query.replace(/\/+$/, ''),
    })
  } catch {
    return null
  }
}

function toItem(entry: DirEntry): SuggestionItem {
  // 目录路径带上尾随 `/`：既是给用户看的「这还能往下走」，也让下一轮 search
  // 走进上面的浏览分支。
  const path = entry.isDirectory ? `${entry.relativePath}/` : entry.relativePath
  const parent = dirname(entry.relativePath)
  /*
   * 含空格的路径会被 formatFileMention 包成 `@"a b/"`，那个收尾的引号让触发段
   * 就此结束，再往下钻是钻不动的（charTrigger 也不允许 query 里有空格）。
   * 与其让弹层开着却什么都搜不到，不如按普通文件收尾。
   */
  const keepOpen = entry.isDirectory && !/[\s"]/.test(path)
  return {
    id: entry.relativePath,
    label: entry.name,
    ...(parent ? { detail: parent } : {}),
    icon: { kind: 'file', name: entry.name, isDirectory: entry.isDirectory },
    // 非 keepOpen 的项补一个尾随空格，把触发段收干净——不补的话紧接着输入的
    // 字符会继续长进这条引用里。
    insert: keepOpen ? formatFileMention(path) : `${formatFileMention(path)} `,
    ...(keepOpen && { keepOpen: true }),
  }
}
