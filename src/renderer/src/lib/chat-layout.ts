export const MIN_WIDTH_FOR_MESSAGE_NAV_RAIL = 640

const CHAT_CONTENT_MAX_WIDTH_CLASS =
  'max-w-3xl lg:max-w-screen-lg xl:max-w-[1280px] 2xl:max-w-[1440px]'

/** Chat Layout Width: keep conversations and every bottom interaction panel aligned. */
export function chatContentWidthClass(navRailVisible: boolean | undefined): string[] {
  return [
    'mx-auto',
    CHAT_CONTENT_MAX_WIDTH_CLASS,
    navRailVisible ? 'w-[calc(100%-2.5rem)]' : 'w-full',
  ]
}
