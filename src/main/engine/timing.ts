import { runExe } from './run'
import type { EngineCtx } from './util'
import type { SubtitleSegment } from '@shared/types'

// Broadcast-tight subtitle timing: rebuild lines from whisper's word-level
// timestamps, then clamp every boundary to energy-detected speech regions so
// text on/off mirrors voice on/off.

export interface Word {
  start: number
  end: number
  text: string
}

export interface TimedLine {
  start: number
  end: number
  text: string
  words: Word[]
}

const GAP_SPLIT_SEC = 0.7
const MAX_LINE_SEC = 6
const MAX_LINE_CHARS = 42
const LEAD_IN_SEC = 0.03
const TRAIL_OUT_SEC = 0.08
const MAX_INNER_SILENCE_SEC = 0.5

// CJK has no spaces and reads denser; count it double toward the line budget.
function visibleWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    w += /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1
  }
  return w
}

const SENTENCE_END = /[.!?。！？…،؟]$/

export function buildLinesFromWords(words: Word[]): TimedLine[] {
  const lines: TimedLine[] = []
  let cur: Word[] = []

  const flush = (): void => {
    if (cur.length === 0) return
    const text = cur.map((w) => w.text).join('').replace(/\s+/g, ' ').trim()
    if (text.length > 0) {
      lines.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: cur })
    }
    cur = []
  }

  for (const w of words) {
    if (cur.length > 0) {
      const last = cur[cur.length - 1]
      const gap = w.start - last.end
      const dur = w.end - cur[0].start
      const width = visibleWidth(cur.map((x) => x.text).join(''))
      const sentenceBreak = width >= 24 && SENTENCE_END.test(last.text.trim())
      if (gap > GAP_SPLIT_SEC || dur > MAX_LINE_SEC || width >= MAX_LINE_CHARS || sentenceBreak) {
        flush()
      }
    }
    cur.push(w)
  }
  flush()

  // Readability lead-in/trail-out, never overlapping neighbours.
  for (let i = 0; i < lines.length; i++) {
    const prevEnd = i > 0 ? lines[i - 1].end : 0
    lines[i].start = Math.max(prevEnd, lines[i].start - LEAD_IN_SEC)
    const nextStart = i < lines.length - 1 ? lines[i + 1].start : Infinity
    lines[i].end = Math.min(nextStart - 0.001, lines[i].end + TRAIL_OUT_SEC)
    // Multi-word lines are already bounded by the MAX_LINE_SEC flush above, but
    // a single word can carry a wildly long span: whisper smears brief
    // utterances — shouts, or CJK phrases where --split-on-word finds no break —
    // across long music/action stretches. Never park one subtitle on screen for
    // tens of seconds; anchor at the start (the reliable edge) and trim the
    // smeared tail to the readable cap.
    if (lines[i].end - lines[i].start > MAX_LINE_SEC) lines[i].end = lines[i].start + MAX_LINE_SEC
    if (lines[i].end <= lines[i].start) lines[i].end = lines[i].start + 0.2
  }
  return lines
}

export interface SpeechRegion {
  start: number
  end: number
}

// Energy-based speech regions via ffmpeg silencedetect over the 16k mono wav.
// Used as hard constraints for subtitle boundaries (the words already come
// from silero-gated audio; this pass trims whisper's trailing word stretch).
export async function detectSpeechRegions(
  ctx: EngineCtx,
  wavPath: string,
  durationSec: number,
  signal?: AbortSignal
): Promise<SpeechRegion[]> {
  const lines: string[] = []
  const res = await runExe(ctx.ffmpeg,
    ['-hide_banner', '-nostdin', '-i', wavPath, '-af', 'silencedetect=n=-32dB:d=0.28', '-f', 'null', '-'],
    { signal, onStderrLine: (l) => { if (l.includes('silence_')) lines.push(l) } })
  if (res.code !== 0) return [{ start: 0, end: durationSec }]

  const silences: SpeechRegion[] = []
  let pendingStart: number | null = null
  for (const l of lines) {
    const ms = /silence_start:\s*(-?[\d.]+)/.exec(l)
    const me = /silence_end:\s*(-?[\d.]+)/.exec(l)
    if (ms) pendingStart = Number(ms[1])
    if (me && pendingStart !== null) {
      silences.push({ start: Math.max(0, pendingStart), end: Number(me[1]) })
      pendingStart = null
    }
  }
  if (pendingStart !== null) silences.push({ start: Math.max(0, pendingStart), end: durationSec })

  const regions: SpeechRegion[] = []
  let cursor = 0
  for (const s of silences.sort((a, b) => a.start - b.start)) {
    if (s.start - cursor > 0.05) regions.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (durationSec - cursor > 0.05) regions.push({ start: cursor, end: durationSec })
  return regions.length > 0 ? regions : [{ start: 0, end: durationSec }]
}

function overlap(aStart: number, aEnd: number, b: SpeechRegion): number {
  return Math.max(0, Math.min(aEnd, b.end) - Math.max(aStart, b.start))
}

// Hard-clamp lines to speech: snap starts/ends into speech regions and split
// any line spanning an internal silence longer than 500ms.
export function tightenToSpeech(lines: TimedLine[], regions: SpeechRegion[]): TimedLine[] {
  if (regions.length === 0) return lines
  const out: TimedLine[] = []

  const splitAtSilence = (line: TimedLine): TimedLine[] => {
    if (line.words.length < 2) return [line]
    // Find a silence gap fully inside the line that exceeds the limit.
    for (const r of regions) {
      // gap between region r and the next region
      const next = regions[regions.indexOf(r) + 1]
      if (!next) break
      const silStart = r.end
      const silEnd = next.start
      if (silEnd - silStart <= MAX_INNER_SILENCE_SEC) continue
      if (silStart > line.start + 0.05 && silEnd < line.end - 0.05) {
        // Split at the word boundary closest to the silence.
        let idx = -1
        for (let i = 0; i < line.words.length - 1; i++) {
          if (line.words[i].end <= silStart + 0.12 && line.words[i + 1].start >= silEnd - 0.12) { idx = i; break }
        }
        if (idx < 0) {
          for (let i = 0; i < line.words.length - 1; i++) {
            if (line.words[i + 1].start >= silEnd - 0.12) { idx = i; break }
          }
        }
        if (idx >= 0) {
          const a = line.words.slice(0, idx + 1)
          const b = line.words.slice(idx + 1)
          const mk = (ws: Word[]): TimedLine => ({
            start: ws[0].start,
            end: ws[ws.length - 1].end,
            text: ws.map((w) => w.text).join('').replace(/\s+/g, ' ').trim(),
            words: ws
          })
          return [...splitAtSilence(mk(a)), ...splitAtSilence(mk(b))]
        }
      }
    }
    return [line]
  }

  for (const raw of lines) {
    for (const line of splitAtSilence(raw)) {
      // The speech region with the largest overlap governs the boundaries.
      let best: SpeechRegion | null = null
      let bestOv = 0
      let firstTouching: SpeechRegion | null = null
      let lastTouching: SpeechRegion | null = null
      for (const r of regions) {
        const ov = overlap(line.start, line.end, r)
        if (ov > bestOv) { bestOv = ov; best = r }
        if (ov > 0.02) {
          if (!firstTouching) firstTouching = r
          lastTouching = r
        }
      }
      if (!best) { out.push(line); continue }
      const startBound = (firstTouching ?? best).start
      const endBound = (lastTouching ?? best).end
      const start = Math.max(line.start, startBound - 0.04)
      const end = Math.min(line.end, endBound + 0.06)
      out.push({ ...line, start, end: end > start ? end : start + 0.2 })
    }
  }

  // Final non-overlap pass after all the snapping.
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) {
      out[i - 1].end = Math.max(out[i - 1].start + 0.1, out[i].start - 0.001)
    }
  }
  return out
}

// Boundary snap for EXISTING segments (no word data — legacy projects and the
// "Tighten to speech" button): clamp each line to the speech it overlaps.
export function snapSegmentsToSpeech(segments: SubtitleSegment[], regions: SpeechRegion[]): SubtitleSegment[] {
  const lines: TimedLine[] = segments.map((s) => ({
    start: s.start, end: s.end, text: s.text, words: [{ start: s.start, end: s.end, text: s.text }]
  }))
  const tightened = tightenToSpeech(lines, regions)
  // Without words a line can't be split; counts match 1:1 here because every
  // input line carries a single pseudo-word.
  return segments.map((s, i) => ({
    ...s,
    start: tightened[i]?.start ?? s.start,
    end: tightened[i]?.end ?? s.end
  }))
}
