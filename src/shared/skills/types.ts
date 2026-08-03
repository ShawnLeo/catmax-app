/**
 * Unified Skill Center: 技能的跨后端统一视图。
 *
 * 背景（决定了下面每一个字段的形状，见 docs/superpowers/specs/2026-08-02-unified-skill-center-design.md）：
 * - codex **原生**扫描 `~/.agents/skills` 和 `<repo>/.agents/skills`，所以统一目录选它，codex 侧零成本；
 * - claude **完全不认识** `.agents`（二进制里连这个字符串都没有），只看 `~/.claude/skills`
 *   和 `<repo>/.claude/skills`，所以要靠 catmax 建的软链把统一目录接过去。
 *
 * 于是"同一个技能"在磁盘上可能有多处身影：统一目录里的真目录 + 各后端目录里的软链，
 * 也可能是几份互不相干的**副本**（这台机器上 `~/.claude/skills` 和 `~/.codex/skills`
 * 就有 10 个同名却各自独立的目录）。`SkillEntry.locations` 就是用来把这些摊开的，
 * `symlink` 字段是区分"镜像"和"副本"的唯一依据。
 */
import type { BackendId } from '../constants'

/** 技能所在的根目录种类。`agents` = 统一目录。 */
export type SkillRootKind = 'agents' | 'codex' | 'claude'

/** 全局（用户主目录）还是当前项目（工作区文件夹内）。 */
export type SkillScope = 'global' | 'project'

/** 同一个技能在磁盘上的一处身影。 */
export interface SkillLocation {
  kind: SkillRootKind
  /** SKILL.md 绝对路径。codex 的 skills/config/write 的 path 选择器要的就是这个（不是目录）。 */
  path: string
  /** 技能目录绝对路径 */
  dir: string
  /**
   * `dir` 本身是不是软链。
   *
   * 这是"镜像"和"独立副本"的分界线：软链意味着内容和统一目录一致，改一处两边都变；
   * 真目录意味着它是另一份会各自漂移的拷贝——本机 `~/.claude/skills` 与
   * `~/.codex/skills` 的 10 个同名目录就是后者。
   */
  symlink: boolean
  /** 软链解析后的真实目录；非软链时等于 `dir`。 */
  realDir: string
  /** 这条软链是 catmax 建的（在镜像清单里）。清理时**只**动这一类。 */
  managed: boolean
}

export interface SkillEntry {
  /**
   * 稳定标识 = `<scope>:<name>`。
   *
   * 不用路径：镜像和迁移都会让路径变，而技能名不变。也不用纯 name：全局和项目
   * 同名时列表里要能分开显示。
   */
  id: string
  /** 技能名（SKILL.md frontmatter 的 name，缺失时退化成目录名） */
  name: string
  description: string
  scope: SkillScope
  /** project scope 时是所属的工作区文件夹；global 为 null */
  folderPath: string | null
  /** 找到它的全部位置，按 agents → codex → claude 排序 */
  locations: SkillLocation[]
  /**
   * 主位置：优先统一目录，其次 codex，最后 claude。
   * "在编辑器中打开""在访达中显示""删除"都以它为准。
   */
  primary: SkillLocation
  /** 已经住在统一目录里（`locations` 中有 kind==='agents' 的真目录） */
  unified: boolean
  /** 哪些后端现在真能看到它 */
  visibleTo: BackendId[]
  /** 用户有没有关掉它（catmax 自己的状态，见 skills-state.json） */
  enabled: boolean
}

/** 扫描过程中读不动的目录——摊给用户看，而不是当作"没有技能"。 */
export interface SkillScanIssue {
  path: string
  message: string
}

export interface SkillsSnapshot {
  entries: SkillEntry[]
  issues: SkillScanIssue[]
  /** 统一全局目录（`~/.agents/skills`）的可写性——不可写时软链和删除都做不了 */
  unifiedRoot: {
    path: string
    exists: boolean
    writable: boolean
  }
}
