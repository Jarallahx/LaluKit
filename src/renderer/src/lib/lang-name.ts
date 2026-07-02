import { WHISPER_LANGUAGES } from '@shared/types'

export function langName(iso: string | null | undefined): string {
  if (!iso) return '—'
  return WHISPER_LANGUAGES.find(([c]) => c === iso)?.[1] ?? iso
}
