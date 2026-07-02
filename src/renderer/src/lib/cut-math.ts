import type { CutMode } from '@shared/types'

interface R { start: number; end: number }

// Mirrors the engine's range math so the UI shows the exact output duration.
export function normalizeRanges(ranges: R[], duration: number): R[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, duration)), end: Math.max(0, Math.min(r.end, duration)) }))
    .filter((r) => r.end - r.start >= 0.01)
    .sort((a, b) => a.start - b.start)
  const merged: R[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

export function effectiveOutputDuration(ranges: R[], mode: CutMode, duration: number): number {
  const norm = normalizeRanges(ranges, duration)
  const selected = norm.reduce((s, r) => s + (r.end - r.start), 0)
  return mode === 'keep' ? selected : Math.max(0, duration - selected)
}
