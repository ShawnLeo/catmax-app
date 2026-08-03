import type { SkillsHandlers } from '@shared/ipc/skills'

import { handleRendererRequest } from '../../typed'

import {
  listSkills,
  migrateSkill,
  mirrorSkill,
  openSkillInEditor,
  removeSkill,
  revealSkill,
  setSkillEnabled,
} from './handlers'

export function registerSkillsHandlers(): void {
  handleRendererRequest<SkillsHandlers, 'skills.list'>('skills.list', listSkills)
  handleRendererRequest<SkillsHandlers, 'skills.setEnabled'>('skills.setEnabled', setSkillEnabled)
  handleRendererRequest<SkillsHandlers, 'skills.mirror'>('skills.mirror', mirrorSkill)
  handleRendererRequest<SkillsHandlers, 'skills.migrate'>('skills.migrate', migrateSkill)
  handleRendererRequest<SkillsHandlers, 'skills.remove'>('skills.remove', removeSkill)
  handleRendererRequest<SkillsHandlers, 'skills.reveal'>('skills.reveal', revealSkill)
  handleRendererRequest<SkillsHandlers, 'skills.openInEditor'>(
    'skills.openInEditor',
    openSkillInEditor,
  )
}

export { syncSkillsOnStartup } from './handlers'
export type { SkillsHandlers } from '@shared/ipc/skills'
