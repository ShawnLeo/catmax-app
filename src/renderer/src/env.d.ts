/// <reference types="vite/client" />

import type { Api } from '../../preload/api'

declare global {
  interface Window {
    api: Api
  }
}

export {}
