import type { LaluApi } from '../shared/api'

declare global {
  interface Window {
    lalu: LaluApi
  }
}

export {}
