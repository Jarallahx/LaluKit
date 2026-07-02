import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from '@/state/store'

// Mini waveform strip behind a transcript row: the audio around the segment
// with the segment's own span highlighted — timing that hugs the speech is
// visible at a glance.
export function SegWave({ start, end }: { start: number; end: number }): ReactNode {
  const peaks = useStore((s) => s.peaks)
  const duration = useStore((s) => s.media?.durationSec ?? 0)
  const theme = useStore((s) => s.theme)
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !peaks || duration <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 200
    const h = canvas.clientHeight || 26
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const css = getComputedStyle(document.documentElement)
    const buckets = peaks.length / 2
    // Window: segment plus half a second of context each side.
    const w0 = Math.max(0, start - 0.5)
    const w1 = Math.min(duration, end + 0.5)
    const span = Math.max(0.001, w1 - w0)
    const mid = h / 2
    const amp = h / 2 - 1.5

    // Highlight the segment's own span first.
    const hx = ((start - w0) / span) * w
    const hw = Math.max(2, ((end - start) / span) * w)
    ctx.fillStyle = css.getPropertyValue('--ai-soft').trim()
    ctx.fillRect(hx, 0, hw, h)

    ctx.beginPath()
    for (let px = 0; px < w; px++) {
      const t = w0 + (px / w) * span
      const b = Math.min(buckets - 1, Math.max(0, Math.floor((t / duration) * buckets)))
      const lo = peaks[b * 2]
      const hi = peaks[b * 2 + 1]
      ctx.moveTo(px + 0.5, mid - Math.max(0.7, hi * amp))
      ctx.lineTo(px + 0.5, mid + Math.max(0.7, -lo * amp))
    }
    ctx.strokeStyle = css.getPropertyValue('--text3').trim()
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.globalAlpha = 1
  }, [peaks, duration, start, end, theme])

  if (!peaks || duration <= 0) return null
  return <canvas ref={ref} className="seg-wave" aria-hidden="true" />
}
