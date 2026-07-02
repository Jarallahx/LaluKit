import type { ReactNode } from 'react'
import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion'
import { AlertTriangle, ArrowRight, Film, FolderPlus, GripVertical, Layers, Trash2, VolumeX, X, Zap } from 'lucide-react'
import { useStore, type MergeItem } from '@/state/store'
import { useT } from '@/i18n'
import { Button, IconButton, Spinner } from '@/ui/primitives'
import { fmtDuration } from '@/lib/time'
import { baseName } from '@/lib/naming'

export function MergeWorkspace(): ReactNode {
  const t = useT()
  const items = useStore((s) => s.mergeItems)
  const plan = useStore((s) => s.mergePlan)
  const mergeAddPaths = useStore((s) => s.mergeAddPaths)
  const mergeSetOrder = useStore((s) => s.mergeSetOrder)
  const mergeClear = useStore((s) => s.mergeClear)
  const openDialog = useStore((s) => s.openDialog)

  const addClips = async (): Promise<void> => {
    const paths = await window.lalu.system.chooseOpen(true)
    if (paths.length > 0) void mergeAddPaths(paths)
  }

  const valid = items.filter((i) => i.info?.video)
  const totalDur = valid.reduce((s, i) => s + (i.info?.durationSec ?? 0), 0)
  const hasAudioOnly = items.some((i) => i.info && i.info.kind === 'audio')
  const hasBroken = items.some((i) => i.errorCode)
  const canExport = valid.length >= 2 && !hasAudioOnly

  if (items.length === 0) {
    return (
      <div className="merge-empty">
        <motion.button
          className="dropzone merge-dropzone"
          onClick={() => void addClips()}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="dropzone-icon merge-dz-icon"><Layers size={26} strokeWidth={1.7} /></span>
          <span className="dropzone-title">{t('merge.empty.title')}</span>
          <span className="dropzone-sub">{t('merge.empty.sub')}</span>
        </motion.button>
      </div>
    )
  }

  return (
    <div className="merge">
      <div className="merge-list-col">
        <div className="merge-list-head">
          <span className="panel-title"><Layers size={14} /> {t('merge.title')}</span>
          <span className="chip">{items.length === 1 ? t('merge.clipCount.one') : t('merge.clipCount', { n: items.length })}</span>
          <div className="merge-list-head-actions">
            <Button size="sm" variant="ghost" icon={<FolderPlus size={13} />} onClick={() => void addClips()}>
              {t('merge.add')}
            </Button>
            <Button size="sm" variant="subtle" icon={<Trash2 size={13} />} onClick={mergeClear}>
              {t('merge.clear')}
            </Button>
          </div>
        </div>

        <Reorder.Group
          axis="y"
          values={items.map((i) => i.id)}
          onReorder={(ids) => mergeSetOrder(ids as string[])}
          className="merge-list"
        >
          <AnimatePresence initial={false}>
            {items.map((item, idx) => (
              <MergeRow key={item.id} item={item} index={idx} />
            ))}
          </AnimatePresence>
        </Reorder.Group>
      </div>

      <div className="merge-side">
        <div className="merge-side-section">
          <span className="panel-label">{t('merge.orderPreview')}</span>
          <div className="merge-strip">
            {items.map((item, i) => (
              <div className="merge-strip-item" key={item.id}>
                <span className="merge-strip-thumb">
                  {item.thumbUrl ? <img src={item.thumbUrl} alt="" /> : <Film size={14} />}
                  <span className="merge-strip-n">{i + 1}</span>
                </span>
                {i < items.length - 1 && <ArrowRight size={11} className="merge-strip-arrow" />}
              </div>
            ))}
          </div>
        </div>

        <div className="merge-side-section">
          <span className="panel-label">{t('merge.summary')}</span>
          {plan && (
            <div className={`merge-plan ${plan.fastConcat ? 'is-fast' : ''}`}>
              {plan.fastConcat ? (
                <span className="merge-plan-fast"><Zap size={13} /> {t('merge.fastPath')}</span>
              ) : (
                <>
                  <span className="merge-plan-title">{t('merge.normalize')}</span>
                  <ul className="merge-plan-reasons">
                    {plan.reasons.map((r) => (
                      <li key={r}>{t(`merge.reason.${r}` as never)}</li>
                    ))}
                  </ul>
                  <span className="merge-plan-target mono">
                    {plan.width}×{plan.height} · {Math.round(plan.fps * 100) / 100} fps · H.264
                  </span>
                </>
              )}
            </div>
          )}
          <div className="merge-total">
            <span className="muted">{t('merge.totalDuration')}</span>
            <span className="mono">{fmtDuration(totalDur)}</span>
          </div>
          {hasAudioOnly && <p className="panel-note panel-note-warn"><AlertTriangle size={12} /> {t('merge.audioOnlyError')}</p>}
          {!hasAudioOnly && valid.length < 2 && <p className="panel-note">{t('merge.needTwo')}</p>}
          {hasBroken && <p className="panel-note panel-note-warn"><AlertTriangle size={12} /> {t('merge.badFile')}</p>}
        </div>

        <div className="merge-side-footer">
          <Button variant="primary" size="lg" disabled={!canExport} onClick={() => openDialog({ kind: 'export-merge' })}>
            {t('merge.export')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function MergeRow({ item, index }: { item: MergeItem; index: number }): ReactNode {
  const t = useT()
  const mergeRemove = useStore((s) => s.mergeRemove)
  const controls = useDragControls()
  const info = item.info
  const bad = !!item.errorCode || (info ? info.kind === 'audio' : false)

  return (
    <Reorder.Item
      value={item.id}
      dragListener={false}
      dragControls={controls}
      className={`merge-row ${bad ? 'is-bad' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      whileDrag={{ scale: 1.015, boxShadow: 'var(--shadow-2)', zIndex: 5 }}
    >
      <button
        className="merge-grip"
        onPointerDown={(e) => controls.start(e)}
        aria-label="Reorder"
      >
        <GripVertical size={15} />
      </button>
      <span className="merge-n mono">{index + 1}</span>
      <span className="merge-thumb">
        {item.probing ? <Spinner size={14} /> : item.thumbUrl ? <img src={item.thumbUrl} alt="" /> : <Film size={15} />}
      </span>
      <span className="merge-name" title={item.path} dir="ltr">{baseName(item.path)}</span>
      <span className="merge-chips">
        {item.errorCode && <span className="chip chip-err">{t('merge.badFile')}</span>}
        {info?.kind === 'audio' && <span className="chip chip-err">{t('merge.audioOnlyError').split('—')[0]}</span>}
        {info?.video && (
          <>
            <span className="chip mono">{info.video.width}×{info.video.height}</span>
            <span className="chip mono">{Math.round(info.video.fps * 100) / 100}fps</span>
            <span className="chip mono">{info.video.codec}</span>
            {info.audioTracks.length === 0 && <span className="chip chip-warn"><VolumeX size={10} /> {t('merge.noAudioChip')}</span>}
          </>
        )}
        {info && <span className="chip mono">{fmtDuration(info.durationSec)}</span>}
      </span>
      <IconButton label={t('merge.remove')} size="sm" className="merge-x" onClick={() => mergeRemove(item.id)}>
        <X size={13} />
      </IconButton>
    </Reorder.Item>
  )
}
