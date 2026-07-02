import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ListPlus, Merge, Play, Plus, Trash2 } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { playerCtl } from '@/lib/player-ctl'
import { Button, IconButton, Toggle } from '@/ui/primitives'
import { TimecodeInput } from '@/ui/TimecodeInput'
import { SegWave } from './SegWave'

// Inline-editable transcript. Rows render as plain divs and swap to a
// textarea on click, so thousand-line transcripts stay snappy.
export function TranscriptList(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const segments = useStore((s) => s.segments)
  const editSegment = useStore((s) => s.editSegment)
  const deleteSegment = useStore((s) => s.deleteSegment)
  const addSegmentAfter = useStore((s) => s.addSegmentAfter)
  const mergeSegmentWithNext = useStore((s) => s.mergeSegmentWithNext)
  const follow = useStore((s) => s.followPlayback)
  const setSubsOption = useStore((s) => s.setSubsOption)
  const currentTime = useStore((s) => s.currentTimeCoarse)
  const playing = useStore((s) => s.playing)

  const subsViewMode = useStore((s) => s.subsViewMode)
  const [editing, setEditing] = useState<{ id: number; field: 'text' | 'translation' } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const activeId = segments.find((s) => currentTime >= s.start && currentTime <= s.end)?.id ?? null

  useEffect(() => {
    if (!follow || !playing || activeId === null || !listRef.current) return
    const el = listRef.current.querySelector(`[data-seg="${activeId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeId, follow, playing])

  if (segments.length === 0) {
    return (
      <div className="subs-noaudio">
        <span className="ranges-empty-sub">{t('subs.empty.afterDelete')}</span>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => addSegmentAfter(null)}>
          {t('subs.addLine')}
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="transcript-follow">
        <span className="panel-label">{t('subs.follow')}</span>
        <Toggle checked={follow} onChange={(v) => setSubsOption({ followPlayback: v })} label={t('subs.follow')} />
      </div>
      <div className="transcript" ref={listRef}>
        {segments.map((seg) => (
          <div
            key={seg.id}
            data-seg={seg.id}
            className={`seg-row ${seg.id === activeId ? 'is-active' : ''}`}
          >
            <SegWave start={seg.start} end={seg.end} />
            <div className="seg-times force-ltr">
              <TimecodeInput
                value={seg.start}
                max={media?.durationSec}
                onCommit={(v) => editSegment(seg.id, { start: v })}
                className="seg-tc"
              />
              <TimecodeInput
                value={seg.end}
                max={media?.durationSec}
                onCommit={(v) => editSegment(seg.id, { end: v })}
                className="seg-tc"
              />
            </div>

            {(subsViewMode === 'translation' || subsViewMode === 'both') && (
              editing?.id === seg.id && editing.field === 'translation' ? (
                <textarea
                  autoFocus
                  className="seg-edit seg-edit-tr"
                  defaultValue={seg.translation ?? ''}
                  dir="auto"
                  rows={Math.min(5, Math.max(1, Math.ceil((seg.translation ?? '').length / 42)))}
                  onBlur={(e) => {
                    editSegment(seg.id, { translation: e.target.value })
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <div
                  className="seg-text seg-text-tr"
                  dir="auto"
                  onClick={() => setEditing({ id: seg.id, field: 'translation' })}
                >
                  {seg.translation || <span className="faint">…</span>}
                </div>
              )
            )}
            {(subsViewMode === 'original' || subsViewMode === 'both') && (
              editing?.id === seg.id && editing.field === 'text' ? (
                <textarea
                  autoFocus
                  className="seg-edit"
                  defaultValue={seg.text}
                  dir="auto"
                  rows={Math.min(5, Math.max(1, Math.ceil(seg.text.length / 42)))}
                  onBlur={(e) => {
                    editSegment(seg.id, { text: e.target.value })
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <div
                  className={`seg-text ${subsViewMode === 'both' ? 'seg-text-secondary' : ''}`}
                  dir="auto"
                  onClick={() => setEditing({ id: seg.id, field: 'text' })}
                >
                  {seg.text || <span className="faint">…</span>}
                </div>
              )
            )}

            <div className="seg-actions">
              <IconButton label={t('subs.playFromHere')} size="sm" onClick={() => { playerCtl.seek(seg.start); playerCtl.play() }}>
                <Play size={12} />
              </IconButton>
              <IconButton label={t('subs.mergeNext')} size="sm" onClick={() => mergeSegmentWithNext(seg.id)}>
                <Merge size={12} />
              </IconButton>
              <IconButton label={t('subs.addAfter')} size="sm" onClick={() => addSegmentAfter(seg.id)}>
                <ListPlus size={12} />
              </IconButton>
              <IconButton label={t('subs.deleteLine')} size="sm" onClick={() => deleteSegment(seg.id)}>
                <Trash2 size={12} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
