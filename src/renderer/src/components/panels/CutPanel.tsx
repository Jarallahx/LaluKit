import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight, Gauge, Image as ImageIcon, Music, Plus, RotateCcw, Scissors,
  SlidersHorizontal, Trash2, Volume2, Zap, Crosshair
} from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { playerCtl } from '@/lib/player-ctl'
import { fmtDuration } from '@/lib/time'
import { Button, IconButton, Segmented, Slider } from '@/ui/primitives'
import { TimecodeInput } from '@/ui/TimecodeInput'
import { effectiveOutputDuration } from '@/lib/cut-math'

const SPEEDS = ['0.25', '0.5', '1', '1.5', '2', '4'] as const

export function CutPanel(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const ranges = useStore((s) => s.ranges)
  const selectedIds = useStore((s) => s.selectedRangeIds)
  const cutMode = useStore((s) => s.cutMode)
  const cutEngine = useStore((s) => s.cutEngine)
  const setCutMode = useStore((s) => s.setCutMode)
  const setCutEngine = useStore((s) => s.setCutEngine)
  const selectRange = useStore((s) => s.selectRange)
  const removeRange = useStore((s) => s.removeRange)
  const updateRangeCommitted = useStore((s) => s.updateRangeCommitted)
  const setRangeFx = useStore((s) => s.setRangeFx)
  const addRangeAt = useStore((s) => s.addRangeAt)
  const openDialog = useStore((s) => s.openDialog)
  const noAudio = useStore((s) => s.noAudio)

  const [fxOpenId, setFxOpenId] = useState<string | null>(null)

  if (!media) return null

  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const outDur = effectiveOutputDuration(sorted, cutMode, media.durationSec)
  const canExport = cutMode === 'keep' ? sorted.length > 0 : sorted.length > 0 && outDur > 0.01

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title"><Scissors size={14} /> {t('cut.title')}</span>
      </div>

      <div className="panel-scroll">
        <div className="panel-section">
          <Segmented
            value={cutMode}
            onChange={setCutMode}
            options={[
              { value: 'keep', label: t('cut.mode.keep') },
              { value: 'remove', label: t('cut.mode.remove') }
            ]}
          />
          <p className="panel-note">{cutMode === 'keep' ? t('cut.mode.keep.hint') : t('cut.mode.remove.hint')}</p>
        </div>

        <div className="panel-section">
          <span className="panel-label">{t('cut.engine')}</span>
          <Segmented
            value={cutEngine}
            onChange={setCutEngine}
            options={[
              { value: 'exact', label: <><Crosshair size={12} /> {t('cut.engine.exact')}</> },
              { value: 'lossless', label: <><Zap size={12} /> {t('cut.engine.lossless')}</> }
            ]}
          />
          <p className="panel-note">
            {cutEngine === 'exact' ? t('cut.engine.exact.hint') : t('cut.engine.lossless.hint')}
          </p>
        </div>

        <div className="panel-section panel-section-grow">
          <div className="panel-label-row">
            <span className="panel-label">{t('cut.ranges')}</span>
            <IconButton label={t('timeline.addRange')} size="sm" onClick={() => addRangeAt(playerCtl.currentTime)}>
              <Plus size={13} />
            </IconButton>
          </div>

          {sorted.length === 0 ? (
            <div className="ranges-empty">
              <span className="ranges-empty-title">{t('cut.noRanges')}</span>
              <span className="ranges-empty-sub">{t('cut.noRanges.sub')}</span>
            </div>
          ) : (
            <div className="ranges-list">
              <AnimatePresence initial={false}>
                {sorted.map((r, i) => {
                  const fx = (r.speed ?? 1) !== 1 || (r.volume ?? 1) !== 1
                  return (
                    <motion.div
                      key={r.id}
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={{ duration: 0.18 }}
                      className={`range-row ${selectedIds.includes(r.id) ? 'is-selected' : ''} ${cutMode === 'remove' ? 'is-remove' : ''}`}
                      onClick={(e) => {
                        selectRange(r.id, { additive: e.shiftKey })
                        if (!e.shiftKey) playerCtl.seek(r.start)
                      }}
                    >
                      <div className="range-row-main">
                        <span className="range-index">{i + 1}</span>
                        <div className="range-times force-ltr" onClick={(e) => e.stopPropagation()}>
                          <TimecodeInput value={r.start} max={media.durationSec} onCommit={(v) => updateRangeCommitted(r.id, { start: v })} />
                          <ArrowRight size={11} className="range-arrow" />
                          <TimecodeInput value={r.end} max={media.durationSec} onCommit={(v) => updateRangeCommitted(r.id, { end: v })} />
                        </div>
                        {fx && (
                          <span className="chip chip-accent range-fx-chip force-ltr">
                            {(r.speed ?? 1) !== 1 && `${r.speed}×`}
                            {(r.volume ?? 1) !== 1 && <Volume2 size={9} />}
                          </span>
                        )}
                        <span className="range-dur mono">{fmtDuration((r.end - r.start) / (r.speed ?? 1))}</span>
                        <IconButton
                          label={t('fx.title')}
                          size="sm"
                          className="range-x"
                          active={fxOpenId === r.id}
                          onClick={(e) => { e.stopPropagation(); setFxOpenId(fxOpenId === r.id ? null : r.id) }}
                        >
                          <SlidersHorizontal size={12} />
                        </IconButton>
                        <IconButton
                          label={t('cut.deleteRange')}
                          size="sm"
                          className="range-x"
                          onClick={(e) => { e.stopPropagation(); removeRange(r.id) }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                      {fxOpenId === r.id && (
                        <div className="range-fx" onClick={(e) => e.stopPropagation()}>
                          <div className="range-fx-row">
                            <span className="panel-label"><Gauge size={11} /> {t('fx.speed')}</span>
                            <Segmented
                              size="sm"
                              value={String(r.speed ?? 1) as typeof SPEEDS[number]}
                              onChange={(v) => setRangeFx(r.id, { speed: Number(v) })}
                              options={SPEEDS.map((sp) => ({ value: sp, label: `${sp}×` }))}
                            />
                          </div>
                          {!noAudio && (
                            <div className="range-fx-row">
                              <span className="panel-label"><Volume2 size={11} /> {t('fx.volume')} — {Math.round((r.volume ?? 1) * 100)}%</span>
                              <Slider value={r.volume ?? 1} min={0} max={2} step={0.05} onChange={(v) => setRangeFx(r.id, { volume: v })} width={130} />
                            </div>
                          )}
                          {cutEngine === 'lossless' && <p className="panel-note panel-note-warn">{t('fx.losslessNote')}</p>}
                        </div>
                      )}
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </div>
          )}

          {cutEngine === 'lossless' && sorted.length > 0 && (
            <p className="panel-note panel-note-warn">{t('cut.snapNote')}</p>
          )}
        </div>
      </div>

      <div className="panel-footer">
        <div className="panel-summary">
          {sorted.length > 0 && (
            <span className="muted">
              {t(cutMode === 'keep' ? 'cut.output.keep' : 'cut.output.remove', {
                duration: fmtDuration(outDur),
                count: sorted.length
              })}
            </span>
          )}
        </div>
        <Button variant="primary" size="lg" disabled={!canExport} onClick={() => openDialog({ kind: 'export-cut' })}>
          {t('cut.export')}
        </Button>
        <div className="panel-more">
          <Button size="sm" variant="subtle" icon={<Music size={12} />} disabled={noAudio} onClick={() => openDialog({ kind: 'extract-audio' })}>
            {t('extras.audio.title')}
          </Button>
          <Button size="sm" variant="subtle" icon={<ImageIcon size={12} />} disabled={media.kind !== 'video'} onClick={() => openDialog({ kind: 'gif' })}>
            GIF
          </Button>
          <Button size="sm" variant="subtle" icon={<RotateCcw size={12} />} onClick={() => openDialog({ kind: 'reverse' })}>
            {t('extras.reverse.title')}
          </Button>
        </div>
      </div>
    </div>
  )
}
