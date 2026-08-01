/**
 * Warmup Transcript: 启动时清理 claude 预热残留。
 *
 * 预热跑完会在 finally 里删掉自己的 transcript，但应用被强杀（SIGKILL、强制退出、
 * 崩溃）时 finally 根本不会执行，文件就留在了 ~/.claude/projects/ 里。
 *
 * 为什么挂在启动而不是退出：退出钩子（before-quit）只覆盖正常退出，而正常退出
 * 时预热多半已经自己清理完了——真正会留下垃圾的恰恰是钩子跑不到的那些情况。
 * 启动清理没有这个问题，它一定会执行。
 *
 * 两件事一起做：
 *   1. 删磁盘上的残留 jsonl
 *   2. 删 db 里已经被 reconcile 收进去的那条会话记录
 *
 * 第 2 步不能省：扫描层现在会跳过预热 transcript，但在这个修复之前残留文件已经
 * 被 reconcile 写进 sessions 表了，光删文件那条记录还挂在侧边栏上。
 */
import { unlink } from 'node:fs/promises'

import { listWarmupTranscripts } from '@main/backend/claude/jsonl-reader'
import { ctx } from '@main/context'

import { logger } from './logger'

const log = logger.domain('warmup-cleanup')

export async function cleanupWarmupTranscripts(): Promise<void> {
  let transcripts: Awaited<ReturnType<typeof listWarmupTranscripts>>
  try {
    // 不传 cwd = 全盘扫——残留可能落在任何一个项目目录下，不只是当前工作区
    transcripts = await listWarmupTranscripts()
  } catch (e) {
    log.warn('failed to scan for warmup transcripts:', e)
    return
  }
  if (transcripts.length === 0) return

  let filesDeleted = 0
  let rowsDeleted = 0
  for (const { sessionId, filePath } of transcripts) {
    // 先删 db 再删文件：反过来的话删文件成功、删 db 失败会留下一条指向不存在
    // 文件的会话，用户点开只能看到报错——比现状更糟。
    const session = ctx.db.findSessionByBackendThreadId('claude', sessionId)
    if (session) {
      // 同时写 tombstone——万一文件没删掉（权限/占用），reconcile 也不会再把它加回来
      ctx.db.insertDeletedSession('claude', sessionId)
      ctx.db.deleteSession(session.id)
      rowsDeleted++
    }
    try {
      await unlink(filePath)
      filesDeleted++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('failed to delete warmup transcript', filePath, e)
      }
    }
  }

  log.info('cleaned up warmup transcripts', {
    found: transcripts.length,
    filesDeleted,
    sessionRowsDeleted: rowsDeleted,
  })
}
