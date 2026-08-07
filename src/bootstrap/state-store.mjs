/**
 * Hot Update: state.json 的读写。
 *
 * 写入必须是原子的（临时文件 + rename）。这个文件在每次启动时都会被写一遍
 * （bootAttempts++），如果在写到一半时断电，留下的半个 JSON 会让下次启动
 * 解析失败——而解析失败的降级路径是"当作没有热更新"，用户会莫名其妙地
 * 退回内置版本，且所有已下载的版本都还占着磁盘。rename 是同分区原子操作，
 * 要么是旧内容要么是新内容，不存在中间态。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export function hotUpdatePaths(userDataDir) {
  const root = join(userDataDir, 'hot-updates')
  return {
    root,
    stateFile: join(root, 'state.json'),
    versionsDir: join(root, 'versions'),
    stagingDir: join(root, 'staging'),
    logFile: join(root, 'hot-update.log'),
  }
}

export function versionDir(paths, n) {
  return join(paths.versionsDir, `h${n}`)
}

/** 一个版本目录必须有 main/index.js 才算完整——只有目录存在不足以说明安装完成。 */
export function versionEntry(paths, n) {
  return join(versionDir(paths, n), 'main', 'index.js')
}

export function readState(paths) {
  try {
    if (!existsSync(paths.stateFile)) return null
    const parsed = JSON.parse(readFileSync(paths.stateFile, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // 解析失败等同于没有热更新：降级到内置版本，绝不因为一个坏 JSON 让 app 打不开
    return null
  }
}

export function writeState(paths, state) {
  mkdirSync(paths.root, { recursive: true })
  const tmp = `${paths.stateFile}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, paths.stateFile)
}

export function removeVersion(paths, n) {
  rmSync(versionDir(paths, n), { recursive: true, force: true })
}

export function resetAllVersions(paths) {
  rmSync(paths.versionsDir, { recursive: true, force: true })
  rmSync(paths.stagingDir, { recursive: true, force: true })
}

/** 列出已安装的版本号，按目录名 h<N> 解析。 */
export function listVersions(paths) {
  try {
    if (!existsSync(paths.versionsDir)) return []
    return readdirSync(paths.versionsDir)
      .map((name) => /^h(\d+)$/.exec(name))
      .filter(Boolean)
      .map((m) => Number(m[1]))
  } catch {
    return []
  }
}
