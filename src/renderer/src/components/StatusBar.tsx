import type { ReactNode } from 'react'
import { Cpu, Gauge, Zap } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { fmtDuration } from '@/lib/time'
import { ProgressBar } from '@/ui/primitives'
import type { JobInfo, JobKind } from '@shared/types'

const ACTIVE_KINDS: JobKind[] = ['cut', 'merge', 'transcribe', 'burn-in', 'attach-subs', 'extract-audio', 'gif', 'reverse', 'model-download', 'proxy']

// Bottom status bar: current file facts, true acceleration mode, and a
// mini-progress for the busiest running job.
export function StatusBar(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const sysInfo = useStore((s) => s.sysInfo)
  const jobs = useStore((s) => s.jobs)
  const jobOrder = useStore((s) => s.jobOrder)

  const active = jobOrder
    .map((id) => jobs[id])
    .filter((j): j is JobInfo => !!j && j.state === 'running' && ACTIVE_KINDS.includes(j.kind))
    .pop()

  const gpuWhisper = sysInfo?.whisperBackend === 'cuda'
  const gpuEncode = (sysInfo?.hwEncoders.length ?? 0) > 0
  const accelKey = gpuWhisper && gpuEncode
    ? 'status.accel.gpu'
    : gpuWhisper
      ? 'status.accel.gpuWhisper'
      : gpuEncode
        ? 'status.accel.gpuEncode'
        : 'status.accel.cpu'

  return (
    <footer className="statusbar">
      <div className="statusbar-file">
        {media ? (
          <>
            <span className="statusbar-name" dir="ltr" title={media.path}>{media.fileName}</span>
            <span className="statusbar-sep" />
            <span className="mono faint force-ltr">{fmtDuration(media.durationSec)}</span>
            {media.video && (
              <>
                <span className="statusbar-sep" />
                <span className="mono faint force-ltr">{media.video.width}×{media.video.height}</span>
                <span className="statusbar-sep" />
                <span className="mono faint force-ltr">{media.video.codec}</span>
              </>
            )}
          </>
        ) : (
          <span className="faint">{t('app.name')}</span>
        )}
      </div>

      <div className="statusbar-right">
        {active ? (
          <div className="statusbar-job">
            <span className="statusbar-job-label">{t(`jobs.kind.${active.kind}` as never)}</span>
            <div className="statusbar-job-bar">
              <ProgressBar value={active.progress} tone={active.kind === 'transcribe' || active.kind === 'model-download' ? 'ai' : 'accent'} />
            </div>
            <span className="mono faint force-ltr">
              {active.progress !== null ? `${Math.round(active.progress * 100)}%` : '…'}
            </span>
          </div>
        ) : (
          <span className="faint statusbar-idle"><Gauge size={11} /> {t('status.idle')}</span>
        )}
        <span
          className={`statusbar-accel ${gpuWhisper || gpuEncode ? 'is-gpu' : ''}`}
          title={t('status.accel.title')}
        >
          {gpuWhisper || gpuEncode ? <Zap size={11} /> : <Cpu size={11} />}
          {t(accelKey as never)}
        </span>
      </div>
    </footer>
  )
}
