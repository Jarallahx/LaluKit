import { runFfprobeJson } from './run'
import type { EngineCtx } from './util'

interface FramesOutput {
  frames?: { pts_time?: string; best_effort_timestamp_time?: string }[]
}

// Keyframe timestamps around t (used by the lossless cut mode to snap handles
// to positions where stream-copy is clean).
export async function keyframesNear(
  ctx: EngineCtx,
  filePath: string,
  t: number,
  windowSec: number,
  signal?: AbortSignal
): Promise<number[]> {
  const from = Math.max(0, t - windowSec)
  const to = t + windowSec
  try {
    const raw = (await runFfprobeJson(
      ctx,
      ['-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries',
        'frame=pts_time,best_effort_timestamp_time', '-read_intervals', `${from.toFixed(3)}%${to.toFixed(3)}`,
        filePath],
      signal
    )) as FramesOutput
    const times = (raw.frames ?? [])
      .map((f) => Number(f.pts_time ?? f.best_effort_timestamp_time))
      .filter((n) => Number.isFinite(n) && n >= 0)
    return [...new Set(times)].sort((a, b) => a - b)
  } catch (e) {
    ctx.log(`keyframe probe failed near ${t}s: ${(e as Error).message}`)
    return []
  }
}
