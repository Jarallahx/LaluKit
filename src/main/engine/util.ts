import { createHash } from 'node:crypto'
import { stat, mkdir, rm, readdir } from 'node:fs/promises'
import path from 'node:path'

// Paths + logger every engine call receives (built by the electron side, or by
// the e2e harness — engines never import electron).
export interface EngineCtx {
  ffmpeg: string
  ffprobe: string
  whisperCli: string
  whisperCliCuda: string | null // CUDA build; null when not bundled/usable
  vadModel: string | null // silero VAD ggml model
  fontsDir: string | null // bundled subtitle fonts (Noto Sans + Arabic)
  tempDir: string
  log: (msg: string) => void
}

export interface ProgressFn {
  (progress: number | null, etaSec?: number | null, detail?: string | null): void
}

export async function fileSignature(filePath: string): Promise<string> {
  const st = await stat(filePath)
  return createHash('sha1').update(`${filePath}|${st.size}|${st.mtimeMs}|v1`).digest('hex').slice(0, 24)
}

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}

let workCounter = 0
export async function makeWorkDir(ctx: EngineCtx, tag: string): Promise<string> {
  const dir = path.join(ctx.tempDir, `${tag}-${Date.now().toString(36)}-${(workCounter++).toString(36)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function removeQuiet(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true }).catch(() => {})
}

export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSizeBytes(p)
    else total += (await stat(p).catch(() => null))?.size ?? 0
  }
  return total
}

// Range helpers used by the cut engine.
export interface TimeRange { start: number; end: number }

export function normalizeRanges(ranges: TimeRange[], duration: number, minLen = 0.01): TimeRange[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, duration)), end: Math.max(0, Math.min(r.end, duration)) }))
    .filter((r) => r.end - r.start >= minLen)
    .sort((a, b) => a.start - b.start)
  const merged: TimeRange[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

export function complementRanges(ranges: TimeRange[], duration: number, minLen = 0.01): TimeRange[] {
  const out: TimeRange[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start - cursor >= minLen) out.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (duration - cursor >= minLen) out.push({ start: cursor, end: duration })
  return out
}

// ISO 639-1 (whisper) -> ISO 639-2/B tags for container subtitle metadata.
const ISO3: Record<string, string> = {
  en: 'eng', ar: 'ara', zh: 'chi', de: 'ger', es: 'spa', ru: 'rus', ko: 'kor',
  fr: 'fre', ja: 'jpn', pt: 'por', tr: 'tur', pl: 'pol', nl: 'dut', sv: 'swe',
  it: 'ita', id: 'ind', hi: 'hin', fi: 'fin', vi: 'vie', he: 'heb', uk: 'ukr',
  el: 'gre', ms: 'may', cs: 'cze', ro: 'rum', da: 'dan', hu: 'hun', ta: 'tam',
  no: 'nor', th: 'tha', ur: 'urd', hr: 'hrv', bg: 'bul', fa: 'per', sr: 'srp',
  sk: 'slo', uz: 'uzb', kk: 'kaz', az: 'aze', ka: 'geo', sw: 'swa', am: 'amh',
  bn: 'ben', pa: 'pan', te: 'tel', ml: 'mal', kn: 'kan', mr: 'mar', gu: 'guj',
  ne: 'nep', si: 'sin', km: 'khm', lo: 'lao', my: 'bur', bo: 'tib', tl: 'tgl',
  ca: 'cat', eu: 'baq', gl: 'glg', is: 'ice', lv: 'lav', lt: 'lit', et: 'est',
  mk: 'mac', sq: 'sqi', bs: 'bos', sl: 'slv', mt: 'mlt', cy: 'wel', ga: 'gle',
  af: 'afr', yi: 'yid', ps: 'pus', sd: 'snd', tg: 'tgk', mn: 'mon', hy: 'arm',
  be: 'bel', yue: 'chi'
}

export function iso639_2(code: string): string {
  return ISO3[code] ?? 'und'
}

export function sanitizeBaseName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
}
