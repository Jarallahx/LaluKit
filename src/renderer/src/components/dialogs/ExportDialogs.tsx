import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, HardDrive } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Button, Field, Modal, Segmented, Slider, Toggle } from '@/ui/primitives'
import { fmtBytes } from '@/lib/time'
import { baseName, extOf, suggestOutput } from '@/lib/naming'
import { composeSegments } from '@/lib/subs-compose'
import type { CropOptions, QualityPreset, WatermarkOptions } from '@shared/types'

function useFreeSpace(path: string): number | null {
  const [free, setFree] = useState<number | null>(null)
  useEffect(() => {
    if (!path) return
    const dir = path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))
    let alive = true
    void window.lalu.system.diskSpace(dir).then((d) => {
      if (alive) setFree(d.freeBytes)
    }).catch(() => {})
    return () => { alive = false }
  }, [path])
  return free
}

function QualityPicker({ value, onChange }: { value: QualityPreset; onChange: (q: QualityPreset) => void }): ReactNode {
  const t = useT()
  return (
    <Field label={t('export.quality')} hint={t(`export.quality.${value}.hint` as never)}>
      <Segmented
        value={value}
        onChange={onChange}
        options={[
          { value: 'best', label: t('export.quality.best') },
          { value: 'balanced', label: t('export.quality.balanced') },
          { value: 'fast', label: t('export.quality.fast') }
        ]}
      />
    </Field>
  )
}

function HwToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): ReactNode {
  const t = useT()
  const sysInfo = useStore((s) => s.sysInfo)
  if (!sysInfo || sysInfo.hwEncoders.length === 0) return null
  return (
    <Field row label={t('export.hw', { name: sysInfo.hwEncoders[0].toUpperCase() })} hint={t('export.hw.hint')}>
      <Toggle checked={value} onChange={onChange} label="hw" />
    </Field>
  )
}

export function OutputRow({ path, onPick, filters }: {
  path: string
  onPick: (p: string) => void
  filters: { name: string; extensions: string[] }[]
}): ReactNode {
  const t = useT()
  return (
    <Field label={t('export.saveTo')}>
      <div className="output-row">
        <span className="output-path mono" dir="ltr" title={path}>{path || '…'}</span>
        <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => {
          void window.lalu.system.chooseSave({ defaultPath: path, filters }).then((p) => {
            if (p) onPick(p)
          })
        }}>
          {t('export.browse')}
        </Button>
      </div>
    </Field>
  )
}

function FreeSpaceLine({ path }: { path: string }): ReactNode {
  const t = useT()
  const free = useFreeSpace(path)
  if (free === null) return null
  return (
    <p className="panel-note export-space">
      <HardDrive size={12} /> {t('export.freeSpace', { space: fmtBytes(free) })}
    </p>
  )
}

// ---------- cut ----------

export function ExportCutDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const media = useStore((s) => s.media)
  const ranges = useStore((s) => s.ranges)
  const cutMode = useStore((s) => s.cutMode)
  const cutEngine = useStore((s) => s.cutEngine)
  const exportDir = useStore((s) => s.exportDir)
  const defaultQuality = useStore((s) => s.quality)
  const defaultHw = useStore((s) => s.useHardware)
  const setCropPreview = useStore((s) => s.setCropPreview)
  const toast = useStore((s) => s.toast)

  const open = dialog?.kind === 'export-cut'
  const [path, setPath] = useState('')
  const [container, setContainer] = useState<'auto' | 'mp4' | 'mkv'>('auto')
  const [quality, setQuality] = useState<QualityPreset>(defaultQuality)
  const [hw, setHw] = useState(defaultHw)
  const [busy, setBusy] = useState(false)
  const [loudnorm, setLoudnorm] = useState(false)
  const [wmKind, setWmKind] = useState<'none' | 'text' | 'image'>('none')
  const [wmText, setWmText] = useState('')
  const [wmImage, setWmImage] = useState('')
  const [wmPos, setWmPos] = useState<WatermarkOptions['position']>('br')
  const [wmOpacity, setWmOpacity] = useState(0.7)
  const [wmScale, setWmScale] = useState(0.15)
  const [cropRatio, setCropRatio] = useState<'off' | CropOptions['ratio']>('off')
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)

  const isAudio = media?.kind === 'audio'

  useEffect(() => {
    if (!open || !media) return
    setQuality(defaultQuality)
    setHw(defaultHw)
    setContainer('auto')
    setLoudnorm(false)
    setWmKind('none')
    setCropRatio('off')
    setPanX(0)
    setPanY(0)
    const ext = isAudio ? 'm4a' : cutEngine === 'lossless' ? (extOf(media.path) || 'mp4') : 'mp4'
    void suggestOutput(media.path, 'cut', ext, exportDir).then(setPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, media?.id, cutEngine])

  useEffect(() => {
    if (!open || !media || container === 'auto' || isAudio) return
    setPath((p) => (p ? p.replace(/\.[a-z0-9]+$/i, `.${container}`) : p))
  }, [container, open, media, isAudio])

  // Live crop guide on the player while configuring.
  useEffect(() => {
    if (!open || cropRatio === 'off' || isAudio) {
      setCropPreview(null)
      return
    }
    setCropPreview({ ratio: cropRatio, panX, panY, customW: 16, customH: 9 })
    return () => setCropPreview(null)
  }, [open, cropRatio, panX, panY, isAudio, setCropPreview])

  if (!media) return null

  const exact = cutEngine === 'exact'

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lalu.cut.export({
        inputPath: media.path,
        ranges: ranges.map((r) => ({ start: r.start, end: r.end, speed: r.speed, volume: r.volume })),
        mode: cutMode,
        engine: cutEngine,
        quality,
        useHardware: hw,
        outputPath: path,
        loudnorm: exact && loudnorm,
        watermark: exact && wmKind !== 'none'
          ? {
              kind: wmKind,
              text: wmKind === 'text' ? wmText : undefined,
              imagePath: wmKind === 'image' ? wmImage : undefined,
              position: wmPos,
              opacity: wmOpacity,
              scale: wmKind === 'text' ? Math.round(20 + wmScale * 100) : wmScale
            }
          : null,
        crop: exact && cropRatio !== 'off'
          ? { ratio: cropRatio, panX, panY, customW: 16, customH: 9 }
          : null
      })
      closeDialog()
    } catch (e) {
      toast({ severity: 'error', titleKey: 'error.generic', friendly: (e as { friendly?: never }).friendly ?? null })
    } finally {
      setBusy(false)
    }
  }

  const wmReady = wmKind === 'none' || (wmKind === 'text' ? wmText.trim() !== '' : wmImage !== '')

  return (
    <Modal open={open} onClose={closeDialog} title={`${t('export.title')} — ${t('cut.title')}`} width={560}>
      <OutputRow
        path={path}
        onPick={setPath}
        filters={isAudio
          ? [{ name: 'Audio', extensions: ['m4a'] }]
          : [{ name: 'Video', extensions: ['mp4', 'mkv'] }]}
      />
      {!isAudio && exact && (
        <Field label={t('export.container')}>
          <Segmented
            value={container}
            onChange={setContainer}
            options={[
              { value: 'auto', label: t('export.container.auto') },
              { value: 'mp4', label: 'MP4' },
              { value: 'mkv', label: 'MKV' }
            ]}
          />
        </Field>
      )}
      {exact ? (
        <>
          <QualityPicker value={quality} onChange={setQuality} />
          {!isAudio && <HwToggle value={hw} onChange={setHw} />}
          {media.audioTracks.length > 0 && (
            <Field row label={t('export.loudnorm')} hint={t('export.loudnorm.hint')}>
              <Toggle checked={loudnorm} onChange={setLoudnorm} label={t('export.loudnorm')} />
            </Field>
          )}
          {!isAudio && (
            <>
              <Field label={t('export.watermark')}>
                <Segmented
                  value={wmKind}
                  onChange={setWmKind}
                  size="sm"
                  options={[
                    { value: 'none', label: t('export.watermark.none') },
                    { value: 'text', label: t('export.watermark.text') },
                    { value: 'image', label: t('export.watermark.image') }
                  ]}
                />
              </Field>
              {wmKind !== 'none' && (
                <div className="wm-config">
                  {wmKind === 'text' ? (
                    <input
                      className="text-input"
                      dir="auto"
                      placeholder={t('export.watermark.textPh')}
                      value={wmText}
                      onChange={(e) => setWmText(e.target.value)}
                    />
                  ) : (
                    <div className="output-row">
                      <span className="output-path mono" dir="ltr">{wmImage || '…'}</span>
                      <Button size="sm" variant="ghost" onClick={() => {
                        void window.lalu.system.chooseOpen(false).then((p) => { if (p[0]) setWmImage(p[0]) })
                      }}>
                        {t('export.watermark.pick')}
                      </Button>
                    </div>
                  )}
                  <div className="wm-row">
                    <PositionGrid value={wmPos} onChange={setWmPos} />
                    <div className="wm-sliders">
                      <Field row label={`${t('export.watermark.opacity')} — ${Math.round(wmOpacity * 100)}%`}>
                        <Slider value={wmOpacity} min={0.1} max={1} step={0.05} onChange={setWmOpacity} width={110} />
                      </Field>
                      <Field row label={t('export.watermark.size')}>
                        <Slider value={wmScale} min={0.05} max={0.4} step={0.01} onChange={setWmScale} width={110} />
                      </Field>
                    </div>
                  </div>
                </div>
              )}
              <Field label={t('export.crop')}>
                <Segmented
                  value={cropRatio}
                  onChange={setCropRatio}
                  size="sm"
                  options={[
                    { value: 'off', label: t('export.crop.none') },
                    { value: '16:9', label: '16:9' },
                    { value: '9:16', label: '9:16' },
                    { value: '1:1', label: '1:1' },
                    { value: '4:5', label: '4:5' },
                    { value: '21:9', label: '21:9' }
                  ]}
                />
              </Field>
              {cropRatio !== 'off' && (
                <Field label={t('export.crop.pan')}>
                  <div className="crop-pans force-ltr">
                    <Slider value={panX} min={-1} max={1} step={0.05} onChange={setPanX} width={140} />
                    <Slider value={panY} min={-1} max={1} step={0.05} onChange={setPanY} width={140} />
                  </div>
                </Field>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <p className="panel-note">{t('export.lossless.note')}</p>
          {(ranges.some((r) => (r.speed ?? 1) !== 1 || (r.volume ?? 1) !== 1)) && (
            <p className="panel-note panel-note-warn">{t('export.effectsNote')}</p>
          )}
        </>
      )}
      <FreeSpaceLine path={path} />
      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('export.cancel')}</Button>
        <Button variant="primary" disabled={busy || !path || !wmReady} onClick={() => void start()}>{t('export.start')}</Button>
      </div>
    </Modal>
  )
}

function PositionGrid({ value, onChange }: {
  value: WatermarkOptions['position']
  onChange: (p: WatermarkOptions['position']) => void
}): ReactNode {
  const cells: WatermarkOptions['position'][] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
  return (
    <div className="pos-grid force-ltr" role="radiogroup">
      {cells.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value === c}
          className={`pos-cell ${value === c ? 'is-on' : ''}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

// ---------- merge ----------

export function ExportMergeDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const items = useStore((s) => s.mergeItems)
  const plan = useStore((s) => s.mergePlan)
  const exportDir = useStore((s) => s.exportDir)
  const defaultQuality = useStore((s) => s.quality)
  const defaultHw = useStore((s) => s.useHardware)
  const toast = useStore((s) => s.toast)

  const open = dialog?.kind === 'export-merge'
  const [path, setPath] = useState('')
  const [quality, setQuality] = useState<QualityPreset>(defaultQuality)
  const [hw, setHw] = useState(defaultHw)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || items.length === 0) return
    setQuality(defaultQuality)
    setHw(defaultHw)
    const first = items[0].path
    const ext = plan?.fastConcat ? (extOf(first) || 'mp4') : 'mp4'
    void suggestOutput(first, 'merged', ext, exportDir).then(setPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lalu.merge.export({
        inputs: items.filter((i) => i.info?.video).map((i) => i.path),
        outputPath: path,
        quality,
        useHardware: hw
      })
      closeDialog()
    } catch (e) {
      toast({ severity: 'error', titleKey: 'error.generic', friendly: (e as { friendly?: never }).friendly ?? null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={closeDialog} title={`${t('export.title')} — ${t('merge.title')}`}>
      <OutputRow path={path} onPick={setPath} filters={[{ name: 'Video', extensions: ['mp4', 'mkv'] }]} />
      {plan?.fastConcat ? (
        <p className="panel-note">{t('merge.fastPath')}</p>
      ) : (
        <>
          <QualityPicker value={quality} onChange={setQuality} />
          <HwToggle value={hw} onChange={setHw} />
        </>
      )}
      <FreeSpaceLine path={path} />
      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('export.cancel')}</Button>
        <Button variant="primary" disabled={busy || !path} onClick={() => void start()}>{t('export.start')}</Button>
      </div>
    </Modal>
  )
}

// ---------- attach soft subtitles ----------

export function AttachDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const media = useStore((s) => s.media)
  const rawSegments = useStore((s) => s.segments)
  const subsViewMode = useStore((s) => s.subsViewMode)
  const targetLang = useStore((s) => s.translate.targetLang)
  const segments = composeSegments(rawSegments, subsViewMode)
  const detectedLang = useStore((s) => s.detectedLang)
  const exportDir = useStore((s) => s.exportDir)
  const toast = useStore((s) => s.toast)

  const open = dialog?.kind === 'attach'
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const srcExt = media ? extOf(media.path) : 'mp4'
  const noSubSupport = srcExt === 'avi' || srcExt === 'wmv' || srcExt === 'flv' || srcExt === 'mpg' || srcExt === 'ts'
  const outExt = noSubSupport ? 'mkv' : (srcExt === 'webm' ? 'webm' : srcExt === 'mkv' ? 'mkv' : 'mp4')
  const codec = outExt === 'mkv' ? 'SRT' : outExt === 'webm' ? 'WebVTT' : 'mov_text'

  useEffect(() => {
    if (!open || !media) return
    void suggestOutput(media.path, 'subtitled', outExt, exportDir).then(setPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, media?.id])

  if (!media) return null

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lalu.subs.attach({
        inputPath: media.path,
        segments,
        language: subsViewMode === 'translation' ? targetLang : (detectedLang ?? 'und'),
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
    <Modal open={open} onClose={closeDialog} title={t('subs.attach')} tone="ai">
      <OutputRow path={path} onPick={setPath} filters={[{ name: 'Video', extensions: [outExt] }]} />
      <p className="panel-note">{t('export.attach.note', { codec })}</p>
      {noSubSupport && <p className="panel-note panel-note-warn">{t('export.attach.containerNote')}</p>}
      <FreeSpaceLine path={path} />
      <div className="modal-footer">
        <Button variant="subtle" onClick={closeDialog}>{t('export.cancel')}</Button>
        <Button variant="ai" disabled={busy || !path} onClick={() => void start()}>{t('export.start')}</Button>
      </div>
    </Modal>
  )
}

// ---------- confirmation dialogs ----------

export function ConfirmDialogs(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const openFile = useStore((s) => s.openFile)
  const setSegments = useStore((s) => s.setSegments)
  const startTranscribe = useStore((s) => s.startTranscribe)

  return (
    <>
      <Modal open={dialog?.kind === 'confirm-open'} onClose={closeDialog} width={440}>
        <p className="confirm-text">
          {dialog?.kind === 'confirm-open' && t('confirm.replaceMedia', { name: baseName(dialog.path) })}
        </p>
        <div className="modal-footer">
          <Button variant="subtle" onClick={closeDialog}>{t('confirm.no')}</Button>
          <Button variant="primary" onClick={() => {
            if (dialog?.kind === 'confirm-open') void openFile(dialog.path, { force: true })
          }}>{t('confirm.yes')}</Button>
        </div>
      </Modal>

      <Modal open={dialog?.kind === 'confirm-retranscribe'} onClose={closeDialog} width={440}>
        <p className="confirm-text">{t('subs.retranscribe.confirm')}</p>
        <div className="modal-footer">
          <Button variant="subtle" onClick={closeDialog}>{t('common.cancel')}</Button>
          <Button variant="ai" onClick={() => {
            setSegments([])
            closeDialog()
            void startTranscribe()
          }}>{t('subs.retranscribe')}</Button>
        </div>
      </Modal>
    </>
  )
}
