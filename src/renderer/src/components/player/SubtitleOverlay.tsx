import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useStore } from '@/state/store'
import { playerCtl } from '@/lib/player-ctl'
import { composeSegments } from '@/lib/subs-compose'
import type { SubtitleSegment, SubtitleStyle } from '@shared/types'

// CSS approximation of the ASS style used at burn-in time, scaled to the
// rendered video height (styles are authored against 720p).
export function subtitleCss(style: SubtitleStyle, renderedH: number): CSSProperties {
  const scale = renderedH / 720
  const px = Math.max(9, style.fontSize * scale)
  const o = Math.max(1, style.outlineWidth * scale)
  const shadow = style.outlineWidth > 0
    ? `${style.outlineColor} 0 0 ${o}px, ${style.outlineColor} 0 0 ${o}px, ` +
      `${style.outlineColor} ${o}px ${o}px 0, ${style.outlineColor} -${o}px ${o}px 0, ` +
      `${style.outlineColor} ${o}px -${o}px 0, ${style.outlineColor} -${o}px -${o}px 0`
    : undefined
  return {
    fontFamily: `'${style.fontFamily}', 'Noto Sans Arabic', sans-serif`,
    fontSize: px,
    fontWeight: style.bold ? 700 : 500,
    color: style.color,
    textShadow: shadow,
    background: style.background ? 'rgba(0,0,0,0.62)' : 'transparent',
    padding: style.background ? `${0.18 * px}px ${0.45 * px}px` : '0',
    borderRadius: style.background ? 6 * scale : 0,
    lineHeight: 1.3,
    // First strong character decides direction per line — mixed Arabic/Latin
    // subtitles render each line in its natural direction.
    unicodeBidi: 'plaintext'
  }
}

export function SubtitleOverlay({ stageRef }: { stageRef: RefObject<HTMLDivElement | null> }): ReactNode {
  const rawSegments = useStore((s) => s.segments)
  const viewMode = useStore((s) => s.subsViewMode)
  const segments = useMemo(() => composeSegments(rawSegments, viewMode), [rawSegments, viewMode])
  const style = useStore((s) => s.subtitleStyle)
  const show = useStore((s) => s.showSubtitlePreview)
  const workspace = useStore((s) => s.workspace)
  const [active, setActive] = useState<SubtitleSegment | null>(null)
  const [stageH, setStageH] = useState(360)
  const lastIdRef = useRef<number | -1>(-1)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageH(el.clientHeight))
    ro.observe(el)
    setStageH(el.clientHeight)
    return () => ro.disconnect()
  }, [stageRef])

  useEffect(() => {
    if (segments.length === 0) {
      setActive(null)
      lastIdRef.current = -1
      return
    }
    return playerCtl.onTime((t) => {
      // Bisect by currentTime over the sorted list: rightmost segment with
      // start <= t, shown when t <= its end. The composed segment carries the
      // translation on the SAME object — no parallel list to fall out of sync.
      let lo = 0
      let hi = segments.length - 1
      let idx = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (segments[mid].start <= t) { idx = mid; lo = mid + 1 } else { hi = mid - 1 }
      }
      const found: SubtitleSegment | null = idx >= 0 && t <= segments[idx].end ? segments[idx] : null
      const id = found?.id ?? -1
      if (id !== lastIdRef.current) {
        lastIdRef.current = id
        setActive(found)
      }
    })
  }, [segments])

  if (!show || workspace !== 'subtitles' || !active || active.text.trim() === '') return null

  const posStyle: CSSProperties =
    style.position === 'bottom'
      ? { bottom: (style.marginV / 720) * stageH }
      : style.position === 'top'
        ? { top: (style.marginV / 720) * stageH }
        : { top: '50%', transform: 'translateY(-50%)' }

  return (
    <div className="sub-overlay" style={posStyle}>
      <span className="sub-overlay-text" dir="auto" style={subtitleCss(style, stageH)}>
        {active.text}
      </span>
    </div>
  )
}
