import type { SubtitleSegment } from '@shared/types'

// Whisper hallucination detection, tiered:
//   'reject'     — unmistakable garbage, dropped outright
//   'suspicious' — likely hallucination; worth one re-transcription attempt
//   'ok'         — keep
// Signals: repeated n-gram coverage, word loops, and text length wildly
// disproportionate to segment duration (e.g. 200 chars in 1 second).

function ngramCoverage(t: string[], nMin: number, nMax: number, minRun: number): number {
  let worst = 0
  for (let n = nMin; n <= nMax; n++) {
    if (t.length < n * minRun) break
    let covered = 0
    let i = 0
    while (i + n <= t.length) {
      const gram = t.slice(i, i + n).join('')
      let j = i + n
      let run = 1
      while (j + n <= t.length && t.slice(j, j + n).join('') === gram) {
        run++
        j += n
      }
      if (run >= minRun) {
        covered += run * n
        i = j
      } else {
        i++
      }
    }
    worst = Math.max(worst, covered / t.length)
  }
  return worst
}

export function repetitionScore(text: string): number {
  const t = [...text.replace(/\s+/g, '')] // code points, so CJK works
  if (t.length < 8) return 0
  let worst = ngramCoverage(t, 1, 6, 3)

  // Word-level loops ("thank you thank you thank you…").
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0)
  if (words.length >= 5) {
    const unique = new Set(words.map((w) => w.toLowerCase()))
    if (unique.size <= Math.max(2, Math.ceil(words.length / 5))) {
      worst = Math.max(worst, 1 - unique.size / words.length)
    }
  }
  return worst
}

export type SegmentVerdict = 'ok' | 'suspicious' | 'reject'

export function classifySegment(text: string, durationSec: number): SegmentVerdict {
  const stripped = [...text.replace(/\s+/g, '')]
  if (stripped.length === 0) return 'reject'

  const score = repetitionScore(text)
  // Short bursts ("だめだめだめ!", "おいおいおい") are often real exclamations
  // even at high coverage — those go through the re-transcribe retry instead.
  if (score > 0.5 && stripped.length >= 16) return 'reject'
  if (score > 0.5) return 'suspicious'

  // Characters-per-second sanity: speech tops out around ~12 cps even for
  // fast CJK; far beyond that is decoder runaway.
  const cps = stripped.length / Math.max(0.1, durationSec)
  if (cps > 60 && stripped.length > 40) return 'reject'
  if (cps > 25 && stripped.length > 30) return 'suspicious'

  // Stricter short-gram rule (1–3 chars, >25% coverage) marks suspicion —
  // real exclamations like "だめだめだめ!" survive via the retry path.
  if (stripped.length >= 8 && ngramCoverage(stripped, 1, 3, 3) > 0.25) return 'suspicious'
  if (score > 0.4) return 'suspicious'
  return 'ok'
}

export function isHallucinatedRepetition(text: string): boolean {
  return repetitionScore(text) > 0.4
}

export interface CleanResult {
  segments: SubtitleSegment[]
  cleaned: SubtitleSegment[]
  suspicious: SubtitleSegment[]
}

// First pass over raw whisper output: hard-rejects out, suspicious collected
// for the caller's re-transcription repair, immediate duplicate loops capped.
export function triageSegments(segments: SubtitleSegment[]): CleanResult {
  const cleaned: SubtitleSegment[] = []
  const suspicious: SubtitleSegment[] = []
  const kept: SubtitleSegment[] = []
  let dupRun = 0
  for (const seg of segments) {
    const verdict = classifySegment(seg.text, seg.end - seg.start)
    if (verdict === 'reject') {
      cleaned.push(seg)
      continue
    }
    const prev = kept[kept.length - 1]
    if (prev && prev.text.trim() === seg.text.trim() && seg.text.trim().length >= 6) {
      dupRun++
      // Two identical lines in a row can be legit; three or more is a loop.
      if (dupRun >= 2) {
        cleaned.push(seg)
        continue
      }
    } else {
      dupRun = 0
    }
    if (verdict === 'suspicious') suspicious.push(seg)
    kept.push(seg)
  }
  return { segments: kept, cleaned, suspicious }
}
