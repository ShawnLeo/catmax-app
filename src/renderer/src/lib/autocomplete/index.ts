/**
 * Composer Autocomplete: 组合根。
 *
 * 这个文件就是「Composer 里有哪些联想」的完整答案——想知道输入什么会弹东西，
 * 看下面的 register 调用即可，不用翻组件。
 *
 * 再加一种联想（技能、MCP 工具……）= providers/ 下新建一个文件 + 这里加一行
 * register，composable、弹层组件、Composer 都不用动。
 *
 * 注意 provider 是「一种触发方式」，不是「一个后端」：斜杠命令在不同后端下内容
 * 完全不同，那个差异收在 commands/ 的按后端分表里，provider 只有一个。
 *
 * 顺序即优先级：靠前的 provider 先被问「这是你的触发段吗」。
 */
import { fileSuggestionProvider } from './providers/file'
import { slashCommandProvider } from './providers/slash-command'
import { SuggestionRegistry } from './registry'

export const composerSuggestions = new SuggestionRegistry()

composerSuggestions.register(fileSuggestionProvider)
composerSuggestions.register(slashCommandProvider)

export {
  registerSlashCommands,
  slashCommandsFor,
  toSlashCommandSpecs,
  type SlashCommandSpec,
} from './commands'
export { charTrigger, type CharTriggerOptions } from './trigger'
export { type DetectedTrigger, SuggestionRegistry } from './registry'
export type {
  SuggestionContext,
  SuggestionIcon,
  SuggestionItem,
  SuggestionProvider,
  TriggerDetector,
  TriggerMatch,
} from './types'
