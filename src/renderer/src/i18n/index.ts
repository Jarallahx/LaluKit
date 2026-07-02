import { en, type I18nKey } from './en'
import { ar } from './ar'
import { useStore } from '@/state/store'

export type { I18nKey }

type Vars = Record<string, string | number>

const dicts: Record<'en' | 'ar', Record<I18nKey, string>> = { en, ar }

export function translate(locale: 'en' | 'ar', key: I18nKey, vars?: Vars): string {
  let s: string = dicts[locale][key] ?? en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}

// Hook: returns a bound t() that re-renders on locale change.
export function useT(): (key: I18nKey, vars?: Vars) => string {
  const locale = useStore((s) => s.locale)
  return (key, vars) => translate(locale, key, vars)
}

// Maps a FriendlyError code to a localized message; falls back to the
// engine-provided english message for unknown codes.
export function errorText(
  locale: 'en' | 'ar',
  err: { code: string; message: string; hint?: string } | null | undefined
): { message: string; hint: string | null } {
  if (!err) return { message: translate(locale, 'error.generic'), hint: null }
  const key = `error.${err.code}` as I18nKey
  const known = dicts.en[key] !== undefined
  return {
    message: known ? translate(locale, key) : err.message,
    hint: err.hint ?? null
  }
}
