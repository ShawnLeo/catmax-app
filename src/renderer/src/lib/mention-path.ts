/**
 * File Mention: 绝对路径 → 写进输入框的那一串。
 *
 * 两个入口共用：拖放（useChatFileDrop）和「+」按钮的文件选择对话框——两者拿到的
 * 都是 OS 给的绝对路径，展示规则必须一致，否则同一个文件用不同方式加进来会得到
 * 两条看起来不同的引用，pill 也会重复。
 */

/**
 * 工作区内的文件收敛成相对路径：短、可读，agent 也不用先猜工作区在哪。
 * 工作区外的保持原样（`~/…` 或完整绝对路径）。
 *
 * 这套判断 resolveFileReference 已经完整实现了（含 symlink realpath 比对），
 * 这里只是复用它。解析失败就退回绝对路径原文——用户加进来的东西不该因为解析不了
 * 就消失，agent 拿到一个绝对路径照样能读。
 */
export async function mentionPathFor(
  workspaceId: string | undefined,
  absolutePath: string,
): Promise<string> {
  if (!workspaceId) return absolutePath
  const resolve = window.api.fs.resolveFileReference
  if (typeof resolve !== 'function') return absolutePath
  try {
    const resolved = await resolve({
      workspaceId,
      reference: absolutePath,
      // 文件夹也是合理的引用对象（"看看这个目录"），只有预览通道必须拒绝目录。
      allowDirectory: true,
    })
    if (!resolved) return absolutePath
    // 工作区外文件的 relativePath 只是展示用的原始形态，absolutePath 才是真的；
    // 工作区内文件没有 absolutePath，relativePath 就是要的结果。
    return resolved.absolutePath ? absolutePath : resolved.relativePath
  } catch {
    return absolutePath
  }
}
