/**
 * Right Panel Layout: 右栏各形态的宽度下限，由 ChatView（算可用空间、约束拖拽）和
 * RightPanel（决定渲染成并排还是单栏）共用。
 *
 * 两边必须用同一组数——之前各自写了一份，文件 tab 的"预览 + 文件树"并排宽度因此
 * 可以超过窗口本身：面板贴着右边缘绝对定位，多出来的部分从左侧溢出到窗口外，左边
 * 那一栏（文件详情）直接看不见。
 */

/** 右栏常规下限（Git / 审查 / 任务，以及文件树单独显示时）。 */
export const RIGHT_PANEL_MIN = 320

/** 文件详情能正常阅读的下限。 */
export const FILE_PREVIEW_MIN = 360

/** 文件树还能看清层级和文件名的下限。 */
export const FILE_TREE_MIN = 240

/** 预览与文件树之间分隔条的宽度。 */
export const FILE_SPLIT_HANDLE_WIDTH = 1

/**
 * File Preview Split: 预览与文件树并排所需的最小宽度。
 *
 * 右栏可用宽度低于它时并排必然有一栏被压到不可读（或整体溢出窗口），改走单栏——
 * 同一时刻只显示预览或文件树，互相之间用标题栏按钮切换，见 RightPanel。
 */
export const MIN_WIDTH_FOR_FILE_SPLIT = FILE_PREVIEW_MIN + FILE_TREE_MIN + FILE_SPLIT_HANDLE_WIDTH
