import { randomUUID } from 'node:crypto'
import log from './logger'
import { CancelledError, EngineError } from './engine/errors'
import type { FriendlyError, JobInfo, JobKind } from '@shared/types'

export interface JobCtl {
  signal: AbortSignal
  setProgress: (progress: number | null, etaSec?: number | null, detail?: string | null) => void
}

type Lane = 'heavy' | 'light' | 'download'
const LANE_LIMIT: Record<Lane, number> = { heavy: 1, light: 3, download: 2 }

interface InternalJob {
  info: JobInfo
  lane: Lane
  abort: AbortController
  runner: (ctl: JobCtl) => Promise<unknown>
  outputPathOnDone: string | null
}

// Serializes heavy encodes, parallelizes light probing work, throttles
// progress broadcasts to ~10/sec per job.
export class JobManager {
  private jobs = new Map<string, InternalJob>()
  private queues: Record<Lane, string[]> = { heavy: [], light: [], download: [] }
  private active: Record<Lane, number> = { heavy: 0, light: 0, download: 0 }
  private lastEmit = new Map<string, number>()

  constructor(private broadcast: (info: JobInfo) => void) {}

  create(
    kind: JobKind,
    label: string,
    lane: Lane,
    runner: (ctl: JobCtl) => Promise<unknown>,
    opts: { cancellable?: boolean; outputPath?: string | null } = {}
  ): JobInfo {
    const id = randomUUID()
    const info: JobInfo = {
      id, kind, label,
      detail: null, progress: null, etaSec: null,
      state: 'queued', error: null, result: null,
      outputPath: null,
      createdAt: Date.now(),
      cancellable: opts.cancellable ?? true
    }
    const job: InternalJob = {
      info, lane,
      abort: new AbortController(),
      runner,
      outputPathOnDone: opts.outputPath ?? null
    }
    this.jobs.set(id, job)
    this.queues[lane].push(id)
    this.emit(job, true)
    this.pump(lane)
    this.prune()
    return { ...info }
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (job.info.state === 'queued') {
      this.queues[job.lane] = this.queues[job.lane].filter((q) => q !== id)
      job.info.state = 'cancelled'
      this.emit(job, true)
      return
    }
    if (job.info.state === 'running') {
      job.abort.abort()
    }
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => ({ ...j.info }))
  }

  get(id: string): JobInfo | null {
    const j = this.jobs.get(id)
    return j ? { ...j.info } : null
  }

  private pump(lane: Lane): void {
    while (this.active[lane] < LANE_LIMIT[lane] && this.queues[lane].length > 0) {
      const id = this.queues[lane].shift()!
      const job = this.jobs.get(id)
      if (!job || job.info.state !== 'queued') continue
      this.active[lane]++
      job.info.state = 'running'
      this.emit(job, true)
      const ctl: JobCtl = {
        signal: job.abort.signal,
        setProgress: (p, eta, detail) => {
          job.info.progress = p === null ? null : Math.max(0, Math.min(1, p))
          if (eta !== undefined) job.info.etaSec = eta
          if (detail !== undefined) job.info.detail = detail
          this.emit(job, false)
        }
      }
      job.runner(ctl)
        .then((result) => {
          job.info.state = 'done'
          job.info.progress = 1
          job.info.etaSec = 0
          job.info.result = result ?? null
          job.info.outputPath = job.outputPathOnDone
          log.info(`[job ${job.info.kind}] done: ${job.info.label}`)
        })
        .catch((e) => {
          if (e instanceof CancelledError || job.abort.signal.aborted) {
            job.info.state = 'cancelled'
            log.info(`[job ${job.info.kind}] cancelled: ${job.info.label}`)
          } else {
            job.info.state = 'error'
            job.info.error = toFriendly(e)
            log.error(`[job ${job.info.kind}] failed: ${job.info.label}`, e instanceof EngineError ? e.friendly : e)
          }
        })
        .finally(() => {
          this.active[lane]--
          this.emit(job, true)
          this.pump(lane)
        })
    }
  }

  private emit(job: InternalJob, force: boolean): void {
    const now = Date.now()
    const last = this.lastEmit.get(job.info.id) ?? 0
    if (!force && now - last < 100) return
    this.lastEmit.set(job.info.id, now)
    this.broadcast({ ...job.info })
  }

  // Keep the in-memory history bounded.
  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((j) => j.info.state === 'done' || j.info.state === 'error' || j.info.state === 'cancelled')
      .sort((a, b) => a.info.createdAt - b.info.createdAt)
    while (finished.length > 40) {
      const oldest = finished.shift()!
      this.jobs.delete(oldest.info.id)
      this.lastEmit.delete(oldest.info.id)
    }
  }
}

function toFriendly(e: unknown): FriendlyError {
  if (e instanceof EngineError) return e.friendly
  const ee = e as NodeJS.ErrnoException
  if (ee?.code === 'ENOSPC') {
    return { code: 'disk-full', message: 'There is not enough free disk space to finish this operation.' }
  }
  if (ee?.code === 'EACCES' || ee?.code === 'EPERM') {
    return { code: 'permission', message: 'LaluKit was not allowed to write to that location.' }
  }
  return {
    code: 'unexpected',
    message: 'Something went wrong.',
    hint: 'Check the log file for details.',
    logExcerpt: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
  }
}
