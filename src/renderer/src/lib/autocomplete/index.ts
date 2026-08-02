/**
 * Composer Autocomplete: 组合根。
 *
 * 这个文件就是「Composer 里有哪些联想」的完整答案——想知道输入什么会弹东西，
 * 看下面的 register 调用即可，不用翻组件。
 *
 * 下一期加斜杠命令时，这里只多一行：
 *   composerSuggestions.register(slashCommandProvider)
 * provider 自己在 providers/ 下面新建一个文件，用 charTrigger({ char: '/',
 * atTextStart: true }) 声明触发规则。composable、弹层组件、Composer 都不用改。
 *
 * 顺序即优先级：靠前的 provider 先被问「这是你的触发段吗」。
 */
import { fileSuggestionProvider } from './providers/file'
import { SuggestionRegistry } from './registry'

export const composerSuggestions = new SuggestionRegistry()

composerSuggestions.register(fileSuggestionProvider)

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
