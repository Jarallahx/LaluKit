// Timecode formatting/parsing. All times are seconds (float).

export function fmtTC(sec: number, opts: { ms?: boolean } = {}): string {
  const showMs = opts.ms ?? true
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.floor((s - Math.floor(s)) * 1000)
  const base = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return showMs ? `${base}.${String(ms).padStart(3, '0')}` : base
}

// Accepts "ss", "ss.mmm", "mm:ss", "mm:ss.mmm", "h:mm:ss.mmm".
export function parseTC(text: string): number | null {
  const t = text.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  if (!/^[\d:.,]+$/.test(t)) return null
  const parts = t.replace(',', '.').split(':')
  if (parts.length > 3) return null
  let sec = 0
  for (const p of parts) {
    if (p === '' || Number.isNaN(Number(p))) return null
    sec = sec * 60 + Number(p)
  }
  return Number.isFinite(sec) && sec >= 0 ? sec : null
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}h ${m}m ${ss}s`
  if (m > 0) return `${m}m ${ss}s`
  return `${ss}s`
}

export function fmtETA(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '…'
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function frameOf(sec: number, fps: number): number {
  return Math.round(sec * fps)
}

export function snapToFrame(sec: number, fps: number): number {
  if (fps <= 0) return sec
  return Math.round(sec * fps) / fps
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
