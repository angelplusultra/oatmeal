import type { OatmealApi } from '../shared/api'

declare global {
  interface Window {
    oatmeal: OatmealApi
  }
}
