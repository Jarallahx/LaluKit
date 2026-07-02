import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { CancelledError, mapFfmpegError } from './errors'
import type { EngineCtx, ProgressFn } from './util'

export interface RunOptions {
  signal?: AbortSignal
  cwd?: string
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  onStdoutChunk?: (chunk: Buffer) => void
  timeoutMs?: number
}

export interface RunResult {
  code: number | null
  stderrTail: string
  stdout: string
}

const STDERR_TAIL_MAX = 16 * 1024

// Kills a whole process tree on Windows; plain kill leaves ffmpeg children behind.
export function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = ''
  return (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let idx: number
    while ((idx = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.trim().length > 0) onLine(line)
    }
    if (buf.length > 8192) { onLine(buf); buf = '' }
  }
}

export function runExe(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError())
    const child = spawn(exe, args, { windowsHide: true, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''
    let stdout = ''
    let settled = false
    let timeout: NodeJS.Timeout | null = null

    const onAbort = (): void => {
      killTree(child)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    if (opts.timeoutMs) {
      timeout = setTimeout(() => killTree(child), opts.timeoutMs)
    }

    const stderrLines = opts.onStderrLine ? lineSplitter(opts.onStderrLine) : null
    child.stderr!.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-STDERR_TAIL_MAX)
      stderrLines?.(c)
    })
    const stdoutLines = opts.onStdoutLine ? lineSplitter(opts.onStdoutLine) : null
    child.stdout!.on('data', (c: Buffer) => {
      if (opts.onStdoutChunk) {
        opts.onStdoutChunk(c)
      } else {
        if (stdout.length < 4 * 1024 * 1024) stdout += c.toString('utf8')
      }
      stdoutLines?.(c)
    })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code) => {
      finish(() => {
        if (opts.signal?.aborted) reject(new CancelledError())
        else resolve({ code, stderrTail, stdout })
      })
    })
  })
}

export interface FfmpegRunOptions {
  signal?: AbortSignal
  cwd?: string
  // Total seconds of output media this command produces; enables progress + ETA.
  totalSec?: number
  onProgress?: ProgressFn
  // Maps progress of this command into a sub-window of the overall job.
  window?: { offset: number; scale: number }
}

// Runs ffmpeg with machine-readable progress on stdout. Throws EngineError on
// failure, CancelledError on abort.
export async function runFfmpeg(ctx: EngineCtx, args: string[], opts: FfmpegRunOptions = {}): Promise<RunResult> {
  const full = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args]
  ctx.log(`ffmpeg ${args.join(' ')}`)
  let outSec = 0
  let speed = 0
  const win = opts.window ?? { offset: 0, scale: 1 }
  const report = (): void => {
    if (!opts.onProgress) return
    if (!opts.totalSec || opts.totalSec <= 0) { opts.onProgress(null); return }
    const frac = Math.min(outSec / opts.totalSec, 0.995)
    const eta = speed > 0.01 ? Math.max(0, (opts.totalSec - outSec) / speed) : null
    opts.onProgress(win.offset + frac * win.scale, eta)
  }
  const res = await runExe(ctx.ffmpeg, full, {
    signal: opts.signal,
    cwd: opts.cwd,
    onStdoutLine: (line) => {
      const eq = line.indexOf('=')
      if (eq < 0) return
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim()
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const n = Number(val)
        if (Number.isFinite(n) && n >= 0) outSec = n / 1e6
      } else if (key === 'speed') {
        const n = parseFloat(val)
        if (Number.isFinite(n)) speed = n
      } else if (key === 'progress') {
        report()
      }
    }
  })
  if (res.code !== 0) throw mapFfmpegError(res.stderrTail, res.code)
  return res
}

export async function runFfprobeJson(ctx: EngineCtx, args: string[], signal?: AbortSignal): Promise<unknown> {
  const res = await runExe(ctx.ffprobe, ['-v', 'error', '-print_format', 'json', ...args], { signal, timeoutMs: 60000 })
  if (res.code !== 0) throw mapFfmpegError(res.stderrTail, res.code)
  try {
    return JSON.parse(res.stdout || '{}')
  } catch {
    throw mapFfmpegError(res.stderrTail || 'ffprobe returned invalid JSON', res.code)
  }
}
