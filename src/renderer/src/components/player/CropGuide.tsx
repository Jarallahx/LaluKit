import { useEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useStore } from '@/state/store'
import { cropRectFor } from '@/lib/crop-math'

// Dashed crop frame over the displayed video, with everything outside dimmed.
// Active while the export dialog has a crop configured.
export function CropGuide({ stageRef }: { stageRef: RefObject<HTMLDivElement | null> }): ReactNode {
  const crop = useStore((s) => s.cropPreview)
  const media = useStore((s) => s.media)
  const [stage, setStage] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [stageRef])

  if (!crop || !media?.video || stage.w === 0) return null

  // The <video> uses object-fit: contain — compute its displayed box.
  const vw = media.video.width
  const vh = media.video.height
  const scale = Math.min(stage.w / vw, stage.h / vh)
  const dispW = vw * scale
  const dispH = vh * scale
  const offX = (stage.w - dispW) / 2
  const offY = (stage.h - dispH) / 2
  const r = cropRectFor(crop, vw, vh)

  const frame: CSSProperties = {
    left: offX + r.x * scale,
    top: offY + r.y * scale,
    width: r.w * scale,
    height: r.h * scale
  }

  return (
    <div className="crop-guide" style={{ left: offX, top: offY, width: dispW, height: dispH }}>
      <div className="crop-guide-frame" style={frame}>
        <span className="crop-guide-label mono">{crop.ratio}</span>
      </div>
    </div>
  )
}
