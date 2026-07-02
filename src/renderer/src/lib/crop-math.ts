import type { CropOptions } from '@shared/types'

// Mirror of the engine's crop rectangle math, for the on-player guide.
export function cropRectFor(crop: CropOptions, iw: number, ih: number): { w: number; h: number; x: number; y: number } {
  const ratios: Record<string, number> = {
    '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '21:9': 21 / 9
  }
  const r = crop.ratio === 'custom'
    ? Math.max(0.1, (crop.customW ?? 16) / Math.max(1, crop.customH ?? 9))
    : ratios[crop.ratio]
  let w = iw
  let h = Math.round(w / r)
  if (h > ih) { h = ih; w = Math.round(h * r) }
  const x = Math.round(((iw - w) / 2) * (1 + Math.max(-1, Math.min(1, crop.panX))))
  const y = Math.round(((ih - h) / 2) * (1 + Math.max(-1, Math.min(1, crop.panY))))
  return { w, h, x: Math.max(0, Math.min(iw - w, x)), y: Math.max(0, Math.min(ih - h, y)) }
}
