import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Magnet, Maximize2, Plus, ZoomIn, ZoomOut } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { playerCtl } from '@/lib/player-ctl'
import { clamp, fmtTC } from '@/lib/time'
import { IconButton } from '@/ui/primitives'

const RULER_H = 24
const THUMB_H = 56
const WAVE_H = 46
const BODY_H = RULER_H + THUMB_H + WAVE_H

interface DragState {
  kind: 'scrub' | 'handle' | 'move'
  rangeId?: string
  edge?: 'start' | 'end'
  grabOffset?: number // for move: pointer time minus range start
  tooltip?: { x: number; text: string }
}

export function Timeline(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const thumbs = useStore((s) => s.thumbs)
  const peaks = useStore((s) => s.peaks)
  const noAudio = useStore((s) => s.noAudio)
  const ranges = useStore((s) => s.ranges)
  const selectedId = useStore((s) => s.selectedRangeId)
  const cutMode = useStore((s) => s.cutMode)
  const cutEngine = useStore((s) => s.cutEngine)
  const snapping = useStore((s) => s.snapping)
  const keyframes = useStore((s) => s.keyframes)
  const theme = useStore((s) => s.theme)
  const playing = useStore((s) => s.playing)
  const workspace = useStore((s) => s.workspace)

  const selectedIds = useStore((s) => s.selectedRangeIds)
  const selectRange = useStore((s) => s.selectRange)
  const updateRange = useStore((s) => s.updateRange)
  const moveRange = useStore((s) => s.moveRange)
  const addRangeAt = useStore((s) => s.addRangeAt)
  const addKeyframes = useStore((s) => s.addKeyframes)
  const patchSettings = useStore((s) => s.patchSettings)
  const historyMark = useStore((s) => s.historyMark)
  const [hover, setHover] = useState<{ x: number; t: number; url: string | null } | null>(null)

  const duration = media?.durationSec ?? 0
  const fps = media?.video?.fps ?? 30

  const bodyRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const [viewportW, setViewportW] = useState(0)
  // Zoom is a multiple of "fit" (1 = whole file fills the viewport), so the
  // time<->pixel mapping can never go stale when the viewport resizes.
  const [zoom, setZoom] = useState(1)
  const [drag, setDrag] = useState<DragState | null>(null)
  const followRef = useRef(true)
  const pendingScrollRef = useRef<number | null>(null)
  const kfFetchRef = useRef(0)
  const imgCache = useRef(new Map<string, HTMLImageElement>())

  const fitPps = Math.max(0.01, Math.max(50, viewportW) / Math.max(0.001, duration))
  const maxZoom = Math.max(1, 400 / fitPps)
  const effPps = fitPps * Math.min(Math.max(zoom, 1), maxZoom)
  const contentW = Math.max(duration * effPps, viewportW)

  // --- layout: track viewport size; reset zoom on new media ---
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth))
    ro.observe(el)
    setViewportW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setZoom(1)
    if (viewportRef.current) viewportRef.current.scrollLeft = 0
  }, [media?.id])

  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && viewportRef.current) {
      viewportRef.current.scrollLeft = pendingScrollRef.current
      pendingScrollRef.current = null
    }
  })

  // --- canvas drawing ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const viewport = viewportRef.current
    if (!canvas || !viewport || duration <= 0) return
    const dpr = window.devicePixelRatio || 1
    const w = viewport.clientWidth
    const h = BODY_H
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(document.documentElement)
    const col = (name: string): string => css.getPropertyValue(name).trim()
    const scroll = viewport.scrollLeft
    const t0 = scroll / effPps
    const t1 = (scroll + w) / effPps

    ctx.clearRect(0, 0, w, h)

    // thumbnails strip
    const tileCount = thumbs.length
    ctx.fillStyle = col('--bg2')
    ctx.fillRect(0, RULER_H, w, THUMB_H)
    if (tileCount > 0) {
      const tileDur = duration / tileCount
      const i0 = Math.max(0, Math.floor(t0 / tileDur))
      const i1 = Math.min(tileCount - 1, Math.ceil(t1 / tileDur))
      for (let i = i0; i <= i1; i++) {
        const x = i * tileDur * effPps - scroll
        const tw = tileDur * effPps + 0.5
        const url = thumbs[i]
        if (url) {
          let img = imgCache.current.get(url)
          if (!img) {
            img = new Image()
            img.src = url
            img.onload = () => requestDraw()
            imgCache.current.set(url, img)
          }
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, x, RULER_H, tw, THUMB_H)
            continue
          }
        }
        ctx.fillStyle = col('--thumb-skeleton')
        ctx.fillRect(x + 1, RULER_H + 2, Math.max(1, tw - 2), THUMB_H - 4)
        ctx.fillStyle = col('--bg2')
      }
    }

    // waveform
    const waveY = RULER_H + THUMB_H
    ctx.fillStyle = col('--bg1')
    ctx.fillRect(0, waveY, w, WAVE_H)
    if (peaks && peaks.length >= 4) {
      const buckets = peaks.length / 2
      const mid = waveY + WAVE_H / 2
      const amp = WAVE_H / 2 - 3
      ctx.beginPath()
      for (let px = 0; px < w; px++) {
        const bA = clamp(Math.floor(((scroll + px) / effPps / duration) * buckets), 0, buckets - 1)
        const bB = clamp(Math.floor(((scroll + px + 1) / effPps / duration) * buckets), bA, buckets - 1)
        let lo = 1
        let hi = -1
        for (let b = bA; b <= bB; b++) {
          if (peaks[b * 2] < lo) lo = peaks[b * 2]
          if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1]
        }
        if (hi < lo) { lo = 0; hi = 0 }
        ctx.moveTo(px + 0.5, mid - Math.max(1, hi * amp))
        ctx.lineTo(px + 0.5, mid + Math.max(1, -lo * amp))
      }
      ctx.strokeStyle = col('--accent')
      ctx.globalAlpha = 0.55
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // ruler
    ctx.fillStyle = col('--bg1')
    ctx.fillRect(0, 0, w, RULER_H)
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
    const step = steps.find((s) => s * effPps >= 78) ?? 3600
    const minor = step / 5
    ctx.strokeStyle = col('--line-strong')
    ctx.fillStyle = col('--text3')
    ctx.font = '10px "JetBrains Mono Variable", monospace'
    ctx.textBaseline = 'middle'
    ctx.beginPath()
    for (let s = Math.floor(t0 / minor) * minor; s <= t1 + minor; s += minor) {
      const x = Math.round(s * effPps - scroll) + 0.5
      const major = Math.abs(s / step - Math.round(s / step)) < 1e-6
      ctx.moveTo(x, major ? 8 : 16)
      ctx.lineTo(x, RULER_H - 1)
      if (major && s <= duration + 1e-6) {
        ctx.fillText(fmtTC(Math.max(0, s), { ms: step < 1 }), x + 4, 10)
      }
    }
    ctx.stroke()

    // keyframe markers (lossless mode)
    if (cutEngine === 'lossless' && keyframes.length > 0) {
      ctx.fillStyle = col('--warn')
      for (const kf of keyframes) {
        if (kf < t0 - 1 || kf > t1 + 1) continue
        const x = kf * effPps - scroll
        ctx.beginPath()
        ctx.moveTo(x, RULER_H - 8)
        ctx.lineTo(x + 3.2, RULER_H - 4)
        ctx.lineTo(x, RULER_H)
        ctx.lineTo(x - 3.2, RULER_H - 4)
        ctx.closePath()
        ctx.fill()
      }
    }

    // hairlines
    ctx.strokeStyle = col('--line')
    ctx.beginPath()
    for (const y of [RULER_H, waveY, BODY_H]) {
      ctx.moveTo(0, y - 0.5)
      ctx.lineTo(w, y - 0.5)
    }
    ctx.stroke()
  }, [duration, effPps, thumbs, peaks, keyframes, cutEngine, theme])

  const drawReqRef = useRef(0)
  const requestDraw = useCallback(() => {
    cancelAnimationFrame(drawReqRef.current)
    drawReqRef.current = requestAnimationFrame(() => draw())
  }, [draw])

  useEffect(() => {
    requestDraw()
  }, [requestDraw, viewportW])

  // --- playhead positioning (rAF, outside React) ---
  useEffect(() => {
    return playerCtl.onTime((time) => {
      const ph = playheadRef.current
      const viewport = viewportRef.current
      if (!ph || !viewport) return
      ph.style.transform = `translateX(${time * effPps}px)`
      if (followRef.current && playing) {
        const x = time * effPps
        const { scrollLeft, clientWidth } = viewport
        if (x < scrollLeft + 40 || x > scrollLeft + clientWidth - 70) {
          viewport.scrollLeft = Math.max(0, x - 90)
        }
      }
    })
  }, [effPps, playing])

  useEffect(() => {
    if (playing) followRef.current = true
  }, [playing])

  // --- zoom / scroll ---
  const onWheel = (e: React.WheelEvent): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    if (e.ctrlKey || e.metaKey) {
      const rect = viewport.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const tAt = (viewport.scrollLeft + cursorX) / effPps
      const factor = Math.pow(1.2, -e.deltaY / 100)
      const nextZoom = clamp(zoom * factor, 1, maxZoom)
      pendingScrollRef.current = Math.max(0, tAt * (fitPps * nextZoom) - cursorX)
      setZoom(nextZoom)
    } else {
      followRef.current = false
      viewport.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX
    }
  }

  const zoomBy = (factor: number): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const center = viewport.scrollLeft + viewport.clientWidth / 2
    const tAt = center / effPps
    const nextZoom = clamp(zoom * factor, 1, maxZoom)
    pendingScrollRef.current = Math.max(0, tAt * (fitPps * nextZoom) - viewport.clientWidth / 2)
    setZoom(nextZoom)
  }

  // --- snapping ---
  const snapCandidates = useMemo(() => {
    const cands: number[] = [0, duration]
    for (const r of ranges) {
      cands.push(r.start, r.end)
    }
    return cands
  }, [ranges, duration])

  const applySnap = useCallback(
    (time: number, excludeRange?: string, edge?: 'start' | 'end'): { t: number; snapped: boolean } => {
      let candidates = snapCandidates
      if (excludeRange) {
        const r = ranges.find((x) => x.id === excludeRange)
        candidates = candidates.filter((c) => !r || (c !== r.start && c !== r.end))
      }
      candidates = [...candidates, playerCtl.currentTime]
      const useKf = cutEngine === 'lossless' && edge === 'start'
      if (useKf) candidates = [...candidates, ...keyframes]
      if (!snapping && !useKf) return { t: time, snapped: false }
      const threshold = (useKf ? 12 : 8) / effPps
      let best = time
      let bestD = threshold
      for (const c of candidates) {
        const d = Math.abs(c - time)
        if (d < bestD) { bestD = d; best = c }
      }
      return { t: best, snapped: best !== time }
    },
    [snapCandidates, snapping, effPps, cutEngine, keyframes, ranges]
  )

  // Lossless mode: lazily fetch keyframes around the pointer while dragging.
  const maybeFetchKeyframes = useCallback(
    (time: number): void => {
      if (cutEngine !== 'lossless' || !media || media.kind !== 'video') return
      const now = Date.now()
      if (now - kfFetchRef.current < 400) return
      kfFetchRef.current = now
      void window.lalu.media.keyframes(media.path, time, 8).then(addKeyframes).catch(() => {})
    },
    [cutEngine, media, addKeyframes]
  )

  // --- pointer interactions ---
  const timeAt = (clientX: number): number => {
    const viewport = viewportRef.current
    if (!viewport) return 0
    const rect = viewport.getBoundingClientRect()
    return clamp((viewport.scrollLeft + clientX - rect.left) / effPps, 0, duration)
  }

  const beginScrub = (e: React.PointerEvent): void => {
    followRef.current = false
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    playerCtl.pause()
    playerCtl.seek(timeAt(e.clientX))
    setDrag({ kind: 'scrub' })
  }

  const beginHandle = (e: React.PointerEvent, rangeId: string, edge: 'start' | 'end'): void => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    selectRange(rangeId)
    historyMark()
    playerCtl.pause()
    setDrag({ kind: 'handle', rangeId, edge })
  }

  const beginMove = (e: React.PointerEvent, rangeId: string): void => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    selectRange(rangeId, { additive: e.shiftKey })
    if (e.shiftKey) return // shift-click only toggles selection
    historyMark()
    const r = ranges.find((x) => x.id === rangeId)
    setDrag({ kind: 'move', rangeId, grabOffset: timeAt(e.clientX) - (r?.start ?? 0) })
  }

  // Hover scrub preview: nearest thumbnail + timecode under the pointer.
  const onHoverMove = (e: React.PointerEvent): void => {
    if (drag || thumbs.length === 0) {
      if (hover) setHover(null)
      return
    }
    const time = timeAt(e.clientX)
    const idx = clamp(Math.floor((time / Math.max(0.001, duration)) * thumbs.length), 0, thumbs.length - 1)
    setHover({ x: e.clientX, t: time, url: thumbs[idx] })
  }

  const seekPreviewRef = useRef(0)
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const time = timeAt(e.clientX)
    if (drag.kind === 'scrub') {
      playerCtl.seek(time)
      return
    }
    if (drag.kind === 'handle' && drag.rangeId && drag.edge) {
      maybeFetchKeyframes(time)
      const { t: snapped } = applySnap(time, drag.rangeId, drag.edge)
      updateRange(drag.rangeId, drag.edge === 'start' ? { start: snapped } : { end: snapped })
      const now = Date.now()
      if (now - seekPreviewRef.current > 90) {
        seekPreviewRef.current = now
        playerCtl.seek(snapped)
      }
      setDrag({ ...drag, tooltip: { x: e.clientX, text: fmtTC(snapped) } })
      return
    }
    if (drag.kind === 'move' && drag.rangeId) {
      const r = ranges.find((x) => x.id === drag.rangeId)
      if (!r) return
      const targetStart = time - (drag.grabOffset ?? 0)
      const { t: snapped } = applySnap(targetStart, drag.rangeId)
      moveRange(drag.rangeId, snapped - r.start)
    }
  }

  const endDrag = (): void => {
    if (drag?.kind === 'handle' && drag.rangeId && drag.edge === 'start' && cutEngine === 'lossless') {
      // Hard-snap lossless starts to the nearest keyframe at or before the handle.
      const r = useStore.getState().ranges.find((x) => x.id === drag.rangeId)
      if (r) {
        const kfs = useStore.getState().keyframes.filter((k) => k <= r.start + 0.001 && k >= r.start - 10)
        if (kfs.length > 0) {
          const kf = kfs[kfs.length - 1]
          if (Math.abs(kf - r.start) > 0.0005) updateRange(drag.rangeId, { start: kf })
        }
      }
    }
    setDrag(null)
  }

  if (!media) return null

  // Discarded regions get veiled so the output is always obvious.
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const veils: { start: number; end: number }[] = []
  if (cutMode === 'keep') {
    let cursor = 0
    for (const r of sorted) {
      if (r.start > cursor) veils.push({ start: cursor, end: r.start })
      cursor = Math.max(cursor, r.end)
    }
    if (cursor < duration) veils.push({ start: cursor, end: duration })
  }

  return (
    <div className="timeline force-ltr">
      <div className="tl-toolbar">
        <div className="tl-toolbar-group">
          <IconButton label={t('timeline.zoomOut')} size="sm" onClick={() => zoomBy(1 / 1.5)}><ZoomOut size={14} /></IconButton>
          <IconButton label={t('timeline.zoomIn')} size="sm" onClick={() => zoomBy(1.5)}><ZoomIn size={14} /></IconButton>
          <IconButton label={t('timeline.fit')} size="sm" onClick={() => { pendingScrollRef.current = 0; setZoom(1) }}><Maximize2 size={13} /></IconButton>
          <span className="tl-zoom-label mono">{(effPps / fitPps).toFixed(1)}×</span>
        </div>
        <div className="tl-toolbar-group">
          <IconButton label={t('timeline.snap')} size="sm" active={snapping} onClick={() => patchSettings({ snapping: !snapping })}>
            <Magnet size={14} />
          </IconButton>
          {workspace === 'cut' && (
            <IconButton label={t('timeline.addRange')} size="sm" onClick={() => addRangeAt(playerCtl.currentTime)}>
              <Plus size={14} />
            </IconButton>
          )}
        </div>
        {ranges.length === 0 && workspace === 'cut' && (
          <span className="tl-hint">{t('timeline.hint')}</span>
        )}
        {cutEngine === 'lossless' && workspace === 'cut' && (
          <span className="tl-kf-legend"><span className="tl-kf-diamond" /> {t('timeline.keyframes')}</span>
        )}
      </div>

      <div
        className={`tl-body ${playing ? 'is-playing' : ''}`}
        ref={bodyRef}
        onWheel={onWheel}
        onPointerMove={onHoverMove}
        onPointerLeave={() => setHover(null)}
      >
        <canvas className="tl-canvas" ref={canvasRef} />
        {!peaks && !noAudio && <div className="tl-wave-loading" style={{ top: RULER_H + THUMB_H, height: WAVE_H }} />}
        {noAudio && (
          <div className="tl-no-audio" style={{ top: RULER_H + THUMB_H, height: WAVE_H }}>
            {t('timeline.noAudio')}
          </div>
        )}
        <div
          className="tl-viewport"
          ref={viewportRef}
          onScroll={() => requestDraw()}
        >
          <div
            className="tl-content"
            style={{ width: contentW }}
            onPointerDown={beginScrub}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {workspace === 'cut' && veils.map((v, i) => (
              <div key={i} className="tl-veil" style={{ left: v.start * effPps, width: Math.max(0, (v.end - v.start) * effPps) }} />
            ))}
            {workspace === 'cut' && sorted.map((r) => (
              <div
                key={r.id}
                className={`tl-range ${selectedIds.includes(r.id) || r.id === selectedId ? 'is-selected' : ''} ${cutMode === 'remove' ? 'is-remove' : ''}`}
                style={{ left: r.start * effPps, width: Math.max(3, (r.end - r.start) * effPps) }}
                onPointerDown={(e) => beginMove(e, r.id)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <span className="tl-range-label mono">{fmtTC(r.end - r.start, { ms: false })}</span>
                <div className="tl-handle tl-handle-l" onPointerDown={(e) => beginHandle(e, r.id, 'start')} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
                  <span />
                </div>
                <div className="tl-handle tl-handle-r" onPointerDown={(e) => beginHandle(e, r.id, 'end')} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
                  <span />
                </div>
              </div>
            ))}
            <div className="tl-playhead" ref={playheadRef}>
              <div
                className="tl-playhead-cap"
                onPointerDown={(e) => { e.stopPropagation(); beginScrub(e) }}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            </div>
          </div>
        </div>
        {drag?.tooltip && (
          <div className="tl-tooltip mono" style={{ left: drag.tooltip.x }}>
            {drag.tooltip.text}
          </div>
        )}
        {hover && !drag && (
          <div className="tl-hover" style={{ left: hover.x }}>
            {hover.url && <img src={hover.url} alt="" className="tl-hover-img" />}
            <span className="tl-hover-tc mono">{fmtTC(hover.t)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
