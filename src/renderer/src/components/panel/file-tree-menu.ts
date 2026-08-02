/**
 * File Mention: 文件树右键菜单的 provide/inject key。
 *
 * 单独一个文件而不是写在 FileTree.vue 里——FileTreeNode 是递归组件，
 * 它要 import 这个 key，而 FileTree 又 import 了 FileTreeNode。key 留在
 * FileTree.vue 里就成了循环依赖。
 */
import type { DirEntry } from '@shared/ipc/fs'
import type { InjectionKey } from 'vue'

export type OpenFileTreeMenu = (entry: DirEntry, event: MouseEvent) => void

export const FILE_TREE_MENU_KEY: InjectionKey<OpenFileTreeMenu> = Symbol('file-tree-menu')
