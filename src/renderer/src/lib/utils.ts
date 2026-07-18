import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn-vue 标配的 class 合并工具 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
