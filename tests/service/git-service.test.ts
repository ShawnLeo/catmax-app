import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGitStatus } from '@main/service/git-service'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-git-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// 需要 git 可用
const hasGit = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasGit)('git-service', () => {
  test('非 git repo 返回 isRepo=false', async () => {
    const status = await getGitStatus(tempDir)
    expect(status.isRepo).toBe(false)
    expect(status.branch).toBeNull()
  })

  test('git repo 返回 isRepo=true + branch=main', async () => {
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' })
    execSync('git config user.email test@test.com', { cwd: tempDir })
    execSync('git config user.name Test', { cwd: tempDir })
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore' })
    execSync('git commit -m init', { cwd: tempDir, stdio: 'ignore' })

    const status = await getGitStatus(tempDir)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.recentCommits.length).toBeGreaterThan(0)
    expect(status.recentCommits[0]!.message).toContain('init')
  })

  test('modified 文件被识别', async () => {
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' })
    execSync('git config user.email t@t.com', { cwd: tempDir })
    execSync('git config user.name T', { cwd: tempDir })
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    execSync('git add a.txt && git commit -m init', { cwd: tempDir, stdio: 'ignore' })

    // 修改文件
    writeFileSync(join(tempDir, 'a.txt'), 'modified')
    // 新增未跟踪文件
    writeFileSync(join(tempDir, 'b.txt'), 'b')

    const status = await getGitStatus(tempDir)
    expect(status.unstaged.some((f) => f.path === 'a.txt' && f.status === 'modified')).toBe(true)
    expect(status.untracked).toContain('b.txt')
  })
})
