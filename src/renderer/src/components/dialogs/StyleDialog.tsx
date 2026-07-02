import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Flame } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Button, Field, Modal, Segmented, SearchSelect, Slider, Toggle } from '@/ui/primitives'
import { subtitleCss } from '@/components/player/SubtitleOverlay'
import { suggestOutput } from '@/lib/naming'
import { playerCtl } from '@/lib/player-ctl'
import { composeSegments, fileSuffixFor } from '@/lib/subs-compose'
import type { SubtitleStyle } from '@shared/types'

// Captures the current video frame as the style preview backdrop.
function grabFrame(): string | null {
  const video = document.querySelector('video.player-video') as HTMLVideoElement | null
  if (!video || video.videoWidth === 0) return null
  const canvas = document.createElement('canvas')
  const scale = 480 / video.videoWidth
  canvas.width = 480
  canvas.height = Math.round(video.videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return null
  }
}

export function StyleDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const media = useStore((s) => s.media)
  const segments = useStore((s) => s.segments)
  const globalStyle = useStore((s) => s.subtitleStyle)
  const setSubtitleStyle = useStore((s) => s.setSubtitleStyle)
  const fonts = useStore((s) => s.fonts)
  const exportDir = useStore((s) => s.exportDir)
  const quality = useStore((s) => s.quality)
  const useHardware = useStore((s) => s.useHardware)
  const toast = useStore((s) => s.toast)

  const subsViewMode = useStore((s) => s.subsViewMode)
  const targetLang = useStore((s) => s.translate.targetLang)
  const detectedLang = useStore((s) => s.detectedLang)
  const open = dialog?.kind === 'style'
  const thenBurn = dialog?.kind === 'style' && !!dialog.thenBurn
  const [style, setStyle] = useState<SubtitleStyle>(globalStyle)
  const [frame, setFrame] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const composed = useMemo(() => composeSegments(segments, subsViewMode), [segments, subsViewMode])

  useEffect(() => {
    if (open) {
      setStyle(globalStyle)
      setFrame(grabFrame())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Bundled fonts first: they're guaranteed at burn-in time on any machine.
  const fontOptions = useMemo(() => {
    const bundled = ['Noto Sans Arabic', 'Noto Sans']
    const system = (fonts.length > 0 ? fonts : ['Arial']).filter((f) => !bundled.includes(f))
    return [...bundled, ...system].map((f) => ({ value: f, label: f }))
  }, [fonts])

  const sampleText = useMemo(() => {
    const tNow = playerCtl.currentTime
    const active = composed.find((s) => tNow >= s.start && tNow <= s.end)
    return active?.text || composed[0]?.text || t('style.sample')
  }, [composed, t, open])

  if (!media) return null

  const patch = (p: Partial<SubtitleStyle>): void => setStyle((s) => ({ ...s, ...p }))

  const save = (): void => {
    setSubtitleStyle(style)
    closeDialog()
  }

  const burn = async (): Promise<void> => {
    setSubtitleStyle(style)
    setBusy(true)
    try {
      const suffix = `subtitled-${fileSuffixFor(subsViewMode, targetLang, detectedLang)}`
      const def = await suggestOutput(media.path, suffix, 'mp4', exportDir)
      const path = await window.lalu.system.chooseSave({
        defaultPath: def,
        filters: [{ name: 'Video', extensions: ['mp4', 'mkv'] }]
      })
      if (!path) { setBusy(false); return }
      await window.lalu.subs.burnIn({
        inputPath: media.path,
        segments: composed,
        style,
        quality,
        useHardware,
        outputPath: path
      })
      closeDialog()
    } catch (e) {
      toast({ severity: 'error', titleKey: 'error.generic', friendly: (e as { friendly?: never }).friendly ?? null })
    } finally {
      setBusy(false)
    }
  }

  const previewH = 200

  return (
    <Modal open={open} onClose={closeDialog} title={t('style.title')} width={640} tone="ai">
      <div className="style-grid">
        <div className="style-preview" style={{ height: previewH, backgroundImage: frame ? `url(${frame})` : undefined }}>
          <div
            className="style-preview-text"
            dir="auto"
            style={{
              ...subtitleCss(style, previewH),
              position: 'absolute',
              left: '6%',
              right: '6%',
              textAlign: 'center',
              ...(style.position === 'bottom'
                ? { bottom: (style.marginV / 720) * previewH }
                : style.position === 'top'
                  ? { top: (style.marginV / 720) * previewH }
                  : { top: '50%', transform: 'translateY(-50%)' })
            }}
          >
            <span style={{ background: 'inherit', padding: 'inherit', borderRadius: 'inherit' }}>{sampleText}</span>
          </div>
          <span className="style-preview-note">{t('style.preview.note')}</span>
        </div>

        <div className="style-controls">
          <Field label={t('style.font')}>
            <SearchSelect value={style.fontFamily} options={fontOptions} onChange={(v) => patch({ fontFamily: v })} placeholder="" width={240} />
          </Field>
          <Field row label={`${t('style.size')} — ${style.fontSize}`}>
            <Slider value={style.fontSize} min={16} max={72} onChange={(v) => patch({ fontSize: v })} width={150} />
          </Field>
          <Field row label={t('style.bold')}>
            <Toggle checked={style.bold} onChange={(v) => patch({ bold: v })} label={t('style.bold')} />
          </Field>
          <Field row label={t('style.color')}>
            <input type="color" className="color-input" value={style.color} onChange={(e) => patch({ color: e.target.value })} />
          </Field>
          <Field row label={`${t('style.outline')} — ${style.outlineWidth}`}>
            <Slider value={style.outlineWidth} min={0} max={6} step={0.5} onChange={(v) => patch({ outlineWidth: v })} width={150} />
          </Field>
          <Field row label={t('style.outlineColor')}>
            <input type="color" className="color-input" value={style.outlineColor} onChange={(e) => patch({ outlineColor: e.target.value })} />
          </Field>
          <Field row label={t('style.background')}>
            <Toggle checked={style.background} onChange={(v) => patch({ background: v })} label={t('style.background')} />
          </Field>
          <Field label={t('style.position')}>
            <Segmented
              value={style.position}
              onChange={(v) => patch({ position: v })}
              size="sm"
              options={[
                { value: 'bottom', label: t('style.position.bottom') },
                { value: 'middle', label: t('style.position.middle') },
                { value: 'top', label: t('style.position.top') }
              ]}
            />
          </Field>
          {style.position !== 'middle' && (
            <Field row label={`${t('style.margin')} — ${style.marginV}`}>
              <Slider value={style.marginV} min={10} max={200} onChange={(v) => patch({ marginV: v })} width={150} />
            </Field>
          )}
        </div>
      </div>

      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('common.cancel')}</Button>
        {thenBurn || media.kind === 'video' ? (
          <Button variant="ai" icon={<Flame size={14} />} disabled={busy || segments.length === 0} onClick={() => void burn()}>
            {t('subs.burn')}
          </Button>
        ) : null}
        <Button variant="primary" onClick={save}>{t('common.ok')}</Button>
      </div>
    </Modal>
  )
}
