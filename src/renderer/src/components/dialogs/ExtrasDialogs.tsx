import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Button, Field, Modal, Segmented } from '@/ui/primitives'
import { fmtDuration } from '@/lib/time'
import { suggestOutput } from '@/lib/naming'
import { OutputRow } from './ExportDialogs'

function useSelectedSpan(): { start: number; end: number; whole: boolean } {
  const media = useStore((s) => s.media)
  const ranges = useStore((s) => s.ranges)
  const selectedId = useStore((s) => s.selectedRangeId)
  const sel = ranges.find((r) => r.id === selectedId) ?? null
  if (sel) return { start: sel.start, end: sel.end, whole: false }
  return { start: 0, end: media?.durationSec ?? 0, whole: true }
}

export function ExtractAudioDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const media = useStore((s) => s.media)
  const exportDir = useStore((s) => s.exportDir)
  const toast = useStore((s) => s.toast)
  const open = dialog?.kind === 'extract-audio'
  const [format, setFormat] = useState<'mp3' | 'wav'>('mp3')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !media) return
    void suggestOutput(media.path, 'audio', format, exportDir).then(setPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, format])

  if (!media) return null
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lalu.extras.extractAudio({ inputPath: media.path, format, outputPath: path })
      closeDialog()
    } catch (e) {
      toast({ severity: 'error', titleKey: 'error.generic', friendly: (e as { friendly?: never }).friendly ?? null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={closeDialog} title={t('extras.audio.title')} width={460}>
      <Field label={t('extras.audio.format')}>
        <Segmented value={format} onChange={setFormat} options={[
          { value: 'mp3', label: 'MP3' },
          { value: 'wav', label: 'WAV' }
        ]} />
      </Field>
      <OutputRow path={path} onPick={setPath} filters={[{ name: 'Audio', extensions: [format] }]} />
      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('export.cancel')}</Button>
        <Button variant="primary" disabled={busy || !path} onClick={() => void start()}>{t('export.start')}</Button>
      </div>
    </Modal>
  )
}

export function GifDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const media = useStore((s) => s.media)
  const exportDir = useStore((s) => s.exportDir)
  const toast = useStore((s) => s.toast)
  const span = useSelectedSpan()
  const open = dialog?.kind === 'gif'
  const [fps, setFps] = useState<'10' | '15' | '24'>('15')
  const [width, setWidth] = useState<'480' | '720' | '1080'>('480')
  const [loop, setLoop] = useState<'0' | '1' | '3'>('0')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const len = span.end - span.start
  const tooLong = len > 60

  useEffect(() => {
    if (!open || !media) return
    void suggestOutput(media.path, 'clip', 'gif', exportDir).then(setPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!media) return null
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lalu.extras.gif({
        inputPath: media.path, start: span.start, end: span.end,
        fps: Number(fps) as 10, maxWidth: Number(width) as 480,
        loop: loop === '1' ? -1 : Number(loop === '3' ? 3 : 0),
        outputPath: path
      })
      closeDialog()
    } catch (e) {
      toast({ severity: 'error', titleKey: 'error.generic', friendly: (e as { friendly?: never }).friendly ?? null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={closeDialog} title={t('extras.gif.title')} width={480}>
      <p className={`panel-note ${tooLong ? 'panel-note-warn' : ''}`}>
        {span.whole
          ? t('extras.gif.wholeShort', { span: fmtDuration(len) })
          : t('extras.gif.span', { span: fmtDuration(len) })}
      </p>
      <Field label={t('extras.gif.fps')}>
        <Segmented value={fps} onChange={setFps} options={[
          { value: '10', label: '10' }, { value: '15', label: '15' }, { value: '24', label: '24' }
        ]} />
      </Field>
      <Field label={t('extras.gif.width')}>
        <Segmented value={width} onChange={setWidth} options={[
          { value: '480', label: '480' }, { value: '720', label: '720' }, { value: '1080', label: '1080' }
        ]} />
      </Field>
      <Field label={t('extras.gif.loop')}>
        <Segmented value={loop} onChange={setLoop} options={[
          { value: '0', label: t('extras.gif.loop.forever') },
          { value: '1', label: t('extras.gif.loop.once') },
          { value: '3', label: t('extras.gif.loop.n', { n: 3 }) }
        ]} />
      </Field>
      <OutputRow path={path} onPick={setPath} filters={[{ name: 'GIF', extensions: ['gif'] }]} />
      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('export.cancel')}</Button>
        <Button variant="primary" disabled={busy || !path || tooLong} onClick={() => void start()}>{t('export.start')}</Button>
      </div>
    </Modal>
  )
}

export function ReverseDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const media = useStore((s) => s.media)
  const exportDir = useStore((s) => s.exportDir)
  const quality = useStore((s) => s.quality)
  const useHardware = useStore((s) => s.useHardware)
  const toast = useStore((s) => s.toast)
  const span = useSelectedSpan()
  const open = dialog?.kind === 'reverse'
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const len = span.end - span.start
  const tooLong = len > 300

  useEffect(() => {
    if (!open || !media) return
    const ext = media.kind === 'video' ? 'mp4' : 'm4a'
    void suggestOutput(media.path, 'reversed', ext, exportDir).then(setPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!media) return null
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lalu.extras.reverse({
        inputPath: media.path,
        start: span.whole ? null : span.start,
        end: span.whole ? null : span.end,
        quality, useHardware, outputPath: path
      })
      closeDialog()
    } catch (e) {
      toast({ severity: 'error', titleKey: 'error.generic', friendly: (e as { friendly?: never }).friendly ?? null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={closeDialog} title={t('extras.reverse.title')} width={460}>
      <p className={`panel-note ${tooLong ? 'panel-note-warn' : ''}`}>
        {span.whole
          ? t('extras.reverse.whole', { span: fmtDuration(len) })
          : t('extras.reverse.span', { span: fmtDuration(len) })}
        {tooLong && ` — ${t('error.reverse-too-long')}`}
      </p>
      <OutputRow path={path} onPick={setPath} filters={[{ name: 'Media', extensions: [media.kind === 'video' ? 'mp4' : 'm4a'] }]} />
      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('export.cancel')}</Button>
        <Button variant="primary" disabled={busy || !path || tooLong} onClick={() => void start()}>{t('export.start')}</Button>
      </div>
    </Modal>
  )
}
