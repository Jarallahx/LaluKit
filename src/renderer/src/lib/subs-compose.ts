import type { SubtitleSegment } from '@shared/types'

export type SubsViewMode = 'original' | 'translation' | 'both'

// Produces the text actually shown/exported for a view mode. Untranslated
// segments fall back to their original text so output never has holes.
export function composeSegments(segments: SubtitleSegment[], mode: SubsViewMode): SubtitleSegment[] {
  if (mode === 'original') return segments
  return segments.map((s) => {
    const tr = s.translation?.trim()
    if (!tr) return s
    return {
      ...s,
      text: mode === 'translation' ? tr : `${tr}\n${s.text}`
    }
  })
}

export function hasAnyTranslation(segments: SubtitleSegment[]): boolean {
  return segments.some((s) => !!s.translation?.trim())
}

export function fileSuffixFor(mode: SubsViewMode, targetLang: string, detectedLang: string | null): string {
  if (mode === 'translation') return targetLang
  if (mode === 'both') return `${targetLang}-bilingual`
  return detectedLang ?? 'subs'
}
