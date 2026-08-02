import type { WorkspaceFolderContext } from '@shared/backend/types'

/** Multi-root Workspace: 为所有 backend 生成一致、按需搜索的目录说明。 */
export function buildWorkspaceInstructions(folders?: WorkspaceFolderContext[]): string | undefined {
  if (!folders?.length) return undefined
  const primary = folders.find((folder) => folder.role === 'primary') ?? folders[0]
  if (!primary) return undefined
  const secondary = folders.filter((folder) => folder.id !== primary.id)
  return [
    'Catmax workspace folders:',
    `- Primary [${primary.alias}]: ${primary.path}`,
    ...secondary.map((folder) => `- Secondary [${folder.alias}]: ${folder.path}`),
    '',
    'Workspace rules:',
    '- Use the primary folder as the default working directory and Git/configuration root.',
    '- Search secondary folders when the task names them or clearly spans multiple folders.',
    '- Use alias/relative/path when a file reference could be ambiguous across roots.',
    '- Do not scan every folder eagerly; inspect only directories relevant to the task.',
  ].join('\n')
}

export function secondaryWorkspacePaths(folders?: WorkspaceFolderContext[]): string[] {
  return folders?.filter((folder) => folder.role === 'secondary').map((folder) => folder.path) ?? []
}
