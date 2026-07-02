import path from 'node:path'
import { writeFile, copyFile, mkdir, access } from 'node:fs/promises'
import type { CropOptions, WatermarkOptions } from '@shared/types'

// Builds the per-segment filtergraph for the exact cut engine when effects
// (speed, volume, crop, watermark, loudness) are active. Returns null pieces
// when the plain -map/-c:v path suffices.

export interface SegmentEffects {
  speed: number
  volume: number
  crop: CropOptions | null
  watermark: WatermarkOptions | null
  loudnorm: boolean
}

export function hasEffects(e: SegmentEffects): boolean {
  return e.speed !== 1 || e.volume !== 1 || !!e.crop || !!e.watermark || e.loudnorm
}

// atempo only accepts 0.5..2 per instance; chain for the full 0.25..4 range.
export function atempoChain(speed: number): string[] {
  const parts: string[] = []
  let s = speed
  while (s > 2) { parts.push('atempo=2.0'); s /= 2 }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5 }
  if (Math.abs(s - 1) > 0.001) parts.push(`atempo=${s.toFixed(4)}`)
  return parts
}

export function cropRect(crop: CropOptions, iw: number, ih: number): { w: number; h: number; x: number; y: number } {
  const ratios: Record<string, number> = {
    '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '21:9': 21 / 9
  }
  const r = crop.ratio === 'custom'
    ? Math.max(0.1, (crop.customW ?? 16) / Math.max(1, crop.customH ?? 9))
    : ratios[crop.ratio]
  let w = iw
  let h = Math.round(w / r)
  if (h > ih) { h = ih; w = Math.round(h * r) }
  w -= w % 2
  h -= h % 2
  const x = Math.round(((iw - w) / 2) * (1 + Math.max(-1, Math.min(1, crop.panX))))
  const y = Math.round(((ih - h) / 2) * (1 + Math.max(-1, Math.min(1, crop.panY))))
  return { w, h, x: Math.max(0, Math.min(iw - w, x)), y: Math.max(0, Math.min(ih - h, y)) }
}

const WM_POS: Record<WatermarkOptions['position'], (pad: number) => string> = {
  tl: (p) => `${p}:${p}`,
  tc: (p) => `(main_w-overlay_w)/2:${p}`,
  tr: (p) => `main_w-overlay_w-${p}:${p}`,
  ml: (p) => `${p}:(main_h-overlay_h)/2`,
  mc: () => '(main_w-overlay_w)/2:(main_h-overlay_h)/2',
  mr: (p) => `main_w-overlay_w-${p}:(main_h-overlay_h)/2`,
  bl: (p) => `${p}:main_h-overlay_h-${p}`,
  bc: (p) => `(main_w-overlay_w)/2:main_h-overlay_h-${p}`,
  br: (p) => `main_w-overlay_w-${p}:main_h-overlay_h-${p}`
}

const TEXT_POS: Record<WatermarkOptions['position'], (pad: number) => string> = {
  tl: (p) => `x=${p}:y=${p}`,
  tc: (p) => `x=(w-text_w)/2:y=${p}`,
  tr: (p) => `x=w-text_w-${p}:y=${p}`,
  ml: (p) => `x=${p}:y=(h-text_h)/2`,
  mc: () => 'x=(w-text_w)/2:y=(h-text_h)/2',
  mr: (p) => `x=w-text_w-${p}:y=(h-text_h)/2`,
  bl: (p) => `x=${p}:y=h-text_h-${p}`,
  bc: (p) => `x=(w-text_w)/2:y=h-text_h-${p}`,
  br: (p) => `x=w-text_w-${p}:y=h-text_h-${p}`
}

export interface BuiltGraph {
  filterComplex: string
  extraInputs: string[] // ffmpeg args inserted after the main input
  videoOut: string
  audioOut: string | null
  // Files the caller must materialize in the working directory beforehand.
  prepare: (workDir: string, fontsDir: string | null) => Promise<void>
}

export function buildSegmentGraph(
  e: SegmentEffects,
  hasVideo: boolean,
  hasAudio: boolean,
  videoW: number,
  videoH: number
): BuiltGraph {
  const vChain: string[] = []
  const extraInputs: string[] = []
  const scale = videoH / 720
  const pad = Math.max(8, Math.round(16 * scale))
  let needsWmFile = false
  let needsFont = false

  if (e.crop && hasVideo) {
    const r = cropRect(e.crop, videoW, videoH)
    vChain.push(`crop=${r.w}:${r.h}:${r.x}:${r.y}`)
  }
  if (e.speed !== 1 && hasVideo) {
    vChain.push(`setpts=PTS/${e.speed.toFixed(4)}`)
  }

  const parts: string[] = []
  let vLabel = '[0:v:0]'
  if (hasVideo) {
    parts.push(`${vLabel}${vChain.length > 0 ? vChain.join(',') : 'null'}[vbase]`)
    vLabel = '[vbase]'
    if (e.watermark?.kind === 'image' && e.watermark.imagePath) {
      const wmScale = Math.max(0.03, Math.min(0.6, e.watermark.scale))
      extraInputs.push('-i', e.watermark.imagePath)
      parts.push(
        `[1:v]format=rgba,colorchannelmixer=aa=${e.watermark.opacity.toFixed(2)},` +
        `scale=iw*min(1\\,(${Math.round(videoW * wmScale)}/iw)):-1[wm]`,
        `[vbase][wm]overlay=${WM_POS[e.watermark.position](pad)}[vout]`
      )
      vLabel = '[vout]'
    } else if (e.watermark?.kind === 'text' && e.watermark.text) {
      needsWmFile = true
      needsFont = true
      const size = Math.max(10, Math.round(e.watermark.scale * scale))
      const alpha = e.watermark.opacity.toFixed(2)
      parts.push(
        `[vbase]drawtext=textfile=wm.txt:fontfile=fonts/NotoSansArabic-Bold.ttf:` +
        `fontsize=${size}:fontcolor=white@${alpha}:borderw=${Math.max(1, Math.round(2 * scale))}:` +
        `bordercolor=black@${alpha}:${TEXT_POS[e.watermark.position](pad)}[vout]`
      )
      vLabel = '[vout]'
    }
  }

  let aLabel: string | null = null
  if (hasAudio) {
    const aChain: string[] = []
    aChain.push(...atempoChain(e.speed))
    if (e.volume !== 1) aChain.push(`volume=${e.volume.toFixed(3)}`)
    if (e.loudnorm) aChain.push('loudnorm=I=-16:TP=-1.5:LRA=11')
    parts.push(`[0:a:0]${aChain.length > 0 ? aChain.join(',') : 'anull'}[aout]`)
    aLabel = '[aout]'
  }

  const wm = e.watermark
  return {
    filterComplex: parts.join(';'),
    extraInputs,
    videoOut: vLabel,
    audioOut: aLabel,
    prepare: async (workDir, fontsDir) => {
      if (needsWmFile && wm?.text) {
        // textfile dodges drawtext's escaping rules entirely (arabic-safe).
        await writeFile(path.join(workDir, 'wm.txt'), wm.text, 'utf8')
      }
      if (needsFont) {
        const dest = path.join(workDir, 'fonts')
        await mkdir(dest, { recursive: true })
        const name = 'NotoSansArabic-Bold.ttf'
        if (fontsDir) {
          try {
            await access(path.join(dest, name))
          } catch {
            await copyFile(path.join(fontsDir, name), path.join(dest, name)).catch(() => {})
          }
        }
      }
    }
  }
}
