import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle, AlertTriangle, Captions, CheckCircle2, Download, Film, Flame,
  FolderOpen, Image as ImageIcon, Import, Info, Layers, Music, RotateCcw,
  Scissors, Sparkles, X
} from 'lucide-react'
import { useStore, type Toast } from '@/state/store'
import { errorText, useT } from '@/i18n'
import { Button, IconButton, ProgressBar, Spinner } from '@/ui/primitives'
import { fmtETA } from '@/lib/time'
import type { JobInfo, JobKind } from '@shared/types'

const VISIBLE_KINDS: JobKind[] = ['proxy', 'cut', 'merge', 'transcribe', 'model-download', 'burn-in', 'attach-subs', 'extract-audio', 'gif', 'reverse']
const AI_KINDS: JobKind[] = ['transcribe', 'model-download']

const KIND_ICON: Partial<Record<JobKind, typeof Scissors>> = {
  cut: Scissors,
  merge: Layers,
  transcribe: Sparkles,
  'model-download': Download,
  'burn-in': Flame,
  'attach-subs': Captions,
  proxy: Film,
  'extract-audio': Music,
  gif: ImageIcon,
  reverse: RotateCcw
}

export function JobCenter(): ReactNode {
  const jobs = useStore((s) => s.jobs)
  const jobOrder = useStore((s) => s.jobOrder)
  const toasts = useStore((s) => s.toasts)
  const batch = useStore((s) => s.batch)

  // Batch transcribe jobs surface in the batch card, not as individual cards.
  const visible = jobOrder
    .map((id) => jobs[id])
    .filter((j): j is JobInfo => !!j && VISIBLE_KINDS.includes(j.kind))
    .filter((j) => j.id !== batch.jobId)
    .filter((j) => j.state === 'running' || j.state === 'queued' || j.state === 'error' || j.state === 'done')
    .slice(-4)

  return (
    <div className="jobcenter">
      <AnimatePresence initial={false}>
        {toasts.map((t) => <ToastCard key={t.id} toast={t} />)}
        {batch.active && <BatchCard key="batch" />}
        {visible.map((job) => <JobCard key={job.id} job={job} />)}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({ toast }: { toast: Toast }): ReactNode {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const dismissToast = useStore((s) => s.dismissToast)
  const err = toast.friendly ? errorText(locale, toast.friendly) : null
  const Icon = toast.severity === 'error' ? AlertCircle
    : toast.severity === 'warning' ? AlertTriangle
      : toast.severity === 'info' ? Info : CheckCircle2
  return (
    <motion.div
      layout
      className={`jobcard toast-${toast.severity}`}
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
    >
      <span className="jobcard-icon"><Icon size={16} /></span>
      <div className="jobcard-main">
        <span className="jobcard-label">{t(toast.titleKey, toast.titleVars)}</span>
        {err && <span className="jobcard-detail">{err.message}{err.hint ? ` — ${err.hint}` : ''}</span>}
        {toast.action && (
          <div className="jobcard-actions">
            <Button size="sm" variant="primary" onClick={() => { toast.action!.run(); dismissToast(toast.id) }}>
              {t(toast.action.labelKey)}
            </Button>
          </div>
        )}
      </div>
      <IconButton label={t('jobs.dismiss')} size="sm" onClick={() => dismissToast(toast.id)}>
        <X size={13} />
      </IconButton>
    </motion.div>
  )
}

function BatchCard(): ReactNode {
  const t = useT()
  const batch = useStore((s) => s.batch)
  const jobs = useStore((s) => s.jobs)
  const cancelBatch = useStore((s) => s.cancelBatch)
  const job = batch.jobId ? jobs[batch.jobId] : null
  const done = batch.items.filter((i) => i.status === 'done' || i.status === 'error').length
  const current = batch.items[batch.index]
  return (
    <motion.div
      layout
      className="jobcard jobcard-ai"
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
    >
      <span className="jobcard-icon is-running"><Sparkles size={15} /></span>
      <div className="jobcard-main">
        <span className="jobcard-label">
          {t('batch.title')}
          <span className="jobcard-file"> · {t('batch.progress', { done, total: batch.items.length })}</span>
        </span>
        {current && <span className="jobcard-detail" dir="ltr">{current.status === 'working' ? <Spinner size={9} /> : null} {current.name}</span>}
        <ProgressBar
          value={batch.items.length > 0 ? (done + (job?.progress ?? 0)) / batch.items.length : null}
          tone="ai"
        />
      </div>
      <IconButton label={t('batch.cancel')} size="sm" onClick={cancelBatch}>
        <X size={13} />
      </IconButton>
    </motion.div>
  )
}

function JobCard({ job }: { job: JobInfo }): ReactNode {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const cancelJob = useStore((s) => s.cancelJob)
  const openFile = useStore((s) => s.openFile)
  const [dismissed, setDismissed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const doneAtRef = useRef<number | null>(null)

  const ai = AI_KINDS.includes(job.kind)
  const Icon = KIND_ICON[job.kind] ?? Film
  const finished = job.state === 'done' || job.state === 'cancelled'

  // Auto-dismiss finished cards unless hovered; errors stay until dismissed.
  useEffect(() => {
    if (!finished || hovered) return
    doneAtRef.current = doneAtRef.current ?? Date.now()
    const id = window.setTimeout(() => setDismissed(true), job.state === 'done' ? 9000 : 4000)
    return () => window.clearTimeout(id)
  }, [finished, hovered, job.state])

  if (dismissed || job.state === 'cancelled') return null

  const detailText = (): string | null => {
    if (job.state === 'queued') return t('jobs.queued')
    if (!job.detail) return null
    const seg = /^segment:(\d+)\/(\d+)$/.exec(job.detail)
    if (seg) return t('jobs.stage.segment', { a: seg[1], b: seg[2] })
    if (job.detail === 'joining') return t('jobs.stage.joining')
    return job.detail
  }

  const err = job.error ? errorText(locale, job.error) : null
  const showLoadResult = job.state === 'done' && job.outputPath &&
    (job.kind === 'cut' || job.kind === 'merge' || job.kind === 'burn-in' || job.kind === 'attach-subs')

  return (
    <motion.div
      layout
      className={`jobcard ${job.state === 'error' ? 'toast-error' : ''} ${ai ? 'jobcard-ai' : ''}`}
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className={`jobcard-icon ${job.state === 'running' ? 'is-running' : ''}`}>
        {job.state === 'done' ? <CheckCircle2 size={16} /> : job.state === 'error' ? <AlertCircle size={16} /> : <Icon size={15} />}
      </span>
      <div className="jobcard-main">
        <span className="jobcard-label">
          {job.state === 'done' ? t(`jobs.done.${job.kind}` as never) : t(`jobs.kind.${job.kind}` as never)}
          <span className="jobcard-file" dir="ltr"> · {job.label}</span>
        </span>

        {job.state === 'running' && (
          <>
            <ProgressBar value={job.progress} tone={ai ? 'ai' : 'accent'} />
            <span className="jobcard-detail mono">
              {job.progress !== null ? `${Math.round(job.progress * 100)}%` : ''}
              {job.etaSec !== null && job.etaSec > 0.5 ? ` · ${t('jobs.eta', { eta: fmtETA(job.etaSec) })}` : ''}
              {detailText() ? ` · ${detailText()}` : ''}
            </span>
          </>
        )}
        {job.state === 'queued' && <span className="jobcard-detail">{t('jobs.queued')}</span>}
        {job.state === 'error' && err && (
          <span className="jobcard-detail">{err.message}{err.hint ? ` — ${err.hint}` : ''}</span>
        )}

        {(job.state === 'done' || job.state === 'error') && (
          <div className="jobcard-actions">
            {job.state === 'done' && job.outputPath && (
              <>
                <Button size="sm" variant="ghost" icon={<FolderOpen size={12} />} onClick={() => void window.lalu.system.showInFolder(job.outputPath!)}>
                  {t('jobs.showInFolder')}
                </Button>
                {showLoadResult && (
                  <Button size="sm" variant="ghost" icon={<Import size={12} />} onClick={() => {
                    setDismissed(true)
                    void openFile(job.outputPath!, { force: true })
                  }}>
                    {t('jobs.loadResult')}
                  </Button>
                )}
              </>
            )}
            {job.state === 'error' && (
              <Button size="sm" variant="ghost" onClick={() => void window.lalu.system.openLog()}>
                {t('jobs.openLog')}
              </Button>
            )}
          </div>
        )}
      </div>

      {job.state === 'running' || job.state === 'queued' ? (
        job.cancellable ? (
          <IconButton label={t('jobs.cancel')} size="sm" onClick={() => cancelJob(job.id)}>
            <X size={13} />
          </IconButton>
        ) : null
      ) : (
        <IconButton label={t('jobs.dismiss')} size="sm" onClick={() => setDismissed(true)}>
          <X size={13} />
        </IconButton>
      )}
    </motion.div>
  )
}
