import path from 'node:path'
import { writeFile, rename, copyFile, stat } from 'node:fs/promises'
import { runFfmpeg } from './run'
import { EngineError, err } from './errors'
import { videoEncodeArgs, audioEncodeArgs, containerExtras, type HwEncoder } from './encode'
import { buildSegmentGraph, hasEffects, type SegmentEffects } from './filters'
import {
  complementRanges, makeWorkDir, normalizeRanges, removeQuiet,
  type EngineCtx, type ProgressFn, type TimeRange
} from './util'
import type { CutExportOptions, MediaInfo } from '@shared/types'

interface EffectRange extends TimeRange {
  speed: number
  volume: number
}

export interface CutRequest {
  opts: CutExportOptions
  media: Pick<MediaInfo, 'durationSec' | 'kind' | 'audioTracks' | 'video' | 'path'>
  hwEncoder: HwEncoder | null // resolved by caller from settings + detection
  signal?: AbortSignal
  onProgress?: ProgressFn
}

// Computes the ranges that actually end up in the output for a mode.
export function effectiveRanges(
  ranges: TimeRange[],
  mode: 'keep' | 'remove',
  duration: number,
  minLen = 0.01
): TimeRange[] {
  const norm = normalizeRanges(ranges, duration, minLen)
  return mode === 'keep' ? norm : complementRanges(norm, duration, minLen)
}

function concatListContent(parts: string[]): string {
  // concat demuxer syntax: single quotes around the path, embedded quotes
  // escaped as '\''. Forward slashes keep Windows paths unambiguous.
  return parts
    .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n') + '\n'
}

export async function exportCut(ctx: EngineCtx, req: CutRequest): Promise<{ outputPath: string }> {
  const { opts, media } = req
  const duration = media.durationSec
  const base = effectiveRanges(opts.ranges, opts.mode, duration)
  if (base.length === 0) {
    throw opts.mode === 'remove'
      ? err('nothing-left', 'The selected ranges cover the whole file — nothing would be left.', 'Shrink the ranges to remove, or switch to "Keep" mode.')
      : err('empty-selection', 'No ranges are selected.', 'Mark at least one range on the timeline first.')
  }
  // Per-range speed/volume only apply in keep mode (in remove mode the kept
  // ranges are complements, with no user-set effects of their own).
  const ranges: EffectRange[] = base.map((r) => {
    const src = opts.mode === 'keep'
      ? opts.ranges.find((o) => Math.abs(o.start - r.start) < 0.01 && Math.abs(o.end - r.end) < 0.01)
      : undefined
    return {
      ...r,
      speed: Math.max(0.25, Math.min(4, src?.speed ?? 1)),
      volume: Math.max(0, Math.min(3, src?.volume ?? 1))
    }
  })

  // Output time accounts for speed changes (ETA/progress accuracy).
  const totalSec = ranges.reduce((s, r) => s + (r.end - r.start) / r.speed, 0)
  const onProgress: ProgressFn = req.onProgress ?? (() => {})
  const hasVideo = media.kind === 'video' && !!media.video
  const hasAudio = media.audioTracks.length > 0
  const workDir = await makeWorkDir(ctx, 'cut')
  const outExt = path.extname(opts.outputPath) || '.mp4'
  // Lossless parts must stay in a container that accepts the source codecs.
  const partExt = opts.engine === 'lossless' ? (path.extname(media.path) || outExt) : outExt
  let hw = opts.useHardware ? req.hwEncoder : null

  const mapsFor = (engine: 'exact' | 'lossless'): string[] => {
    const maps: string[] = []
    if (engine === 'lossless') {
      // Copy everything except subtitles/data (they break across containers
      // and rarely survive cutting meaningfully).
      maps.push('-map', '0:v:0?', '-map', '0:a?', '-sn', '-dn')
    } else {
      if (hasVideo) maps.push('-map', '0:v:0')
      if (hasAudio) maps.push('-map', '0:a')
      maps.push('-sn', '-dn')
    }
    return maps
  }

  const encodeSegment = async (range: EffectRange, dest: string, win: { offset: number; scale: number }): Promise<void> => {
    const len = range.end - range.start
    const outLen = len / range.speed
    const effects: SegmentEffects = {
      speed: range.speed,
      volume: range.volume,
      crop: opts.crop ?? null,
      watermark: opts.watermark ?? null,
      loudnorm: opts.loudnorm ?? false
    }
    const useGraph = hasEffects(effects)
    const graph = useGraph
      ? buildSegmentGraph(effects, hasVideo, hasAudio, media.video?.width ?? 1280, media.video?.height ?? 720)
      : null
    if (graph) await graph.prepare(workDir, ctx.fontsDir)

    const build = (useHw: HwEncoder | null): string[] => {
      // Input-side -ss/-t: decode exactly the selected span (frame-accurate
      // with re-encode) regardless of speed filters downstream.
      const args = ['-ss', range.start.toFixed(4), '-t', len.toFixed(4), '-i', media.path]
      if (graph) {
        args.push(...graph.extraInputs, '-filter_complex', graph.filterComplex)
        if (hasVideo) args.push('-map', graph.videoOut)
        if (graph.audioOut) args.push('-map', graph.audioOut)
        args.push('-sn', '-dn')
      } else {
        args.push(...mapsFor('exact'))
      }
      if (hasVideo) args.push(...videoEncodeArgs(opts.quality, useHw))
      if (hasAudio) args.push(...audioEncodeArgs())
      args.push(...containerExtras(dest), dest)
      return args
    }
    const runOpts = { signal: req.signal, totalSec: outLen, onProgress, window: win, cwd: workDir }
    try {
      await runFfmpeg(ctx, build(hw), runOpts)
    } catch (e) {
      // Hardware encoder init failures fall back to software once, then stick.
      if (hw && e instanceof EngineError && e.friendly.code === 'hw-encoder') {
        ctx.log('hardware encoder failed, retrying segment with libx264')
        hw = null
        await runFfmpeg(ctx, build(null), runOpts)
      } else {
        throw e
      }
    }
  }

  const copySegment = async (range: TimeRange, dest: string, win: { offset: number; scale: number }): Promise<void> => {
    const len = range.end - range.start
    const args = ['-ss', range.start.toFixed(4), '-i', media.path, '-t', len.toFixed(4),
      ...mapsFor('lossless'), '-c', 'copy', '-avoid_negative_ts', 'make_zero',
      ...containerExtras(dest), dest]
    await runFfmpeg(ctx, args, { signal: req.signal, totalSec: len, onProgress, window: win })
  }

  try {
    const segWeight = 0.96 // concat gets the final 4%
    const single = ranges.length === 1
    const parts: string[] = []
    let done = 0
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      const effLen = (r.end - r.start) / r.speed
      const win = single
        ? { offset: 0, scale: 1 }
        : { offset: (done / totalSec) * segWeight, scale: (effLen / totalSec) * segWeight }
      const dest = single ? opts.outputPath : path.join(workDir, `part${String(i).padStart(3, '0')}${partExt}`)
      onProgress(win.offset, null, ranges.length > 1 ? `segment:${i + 1}/${ranges.length}` : null)
      if (opts.engine === 'exact') await encodeSegment(r, dest, win)
      else await copySegment(r, dest, win)
      parts.push(dest)
      done += effLen
    }

    if (!single) {
      onProgress(segWeight, null, 'joining')
      const listPath = path.join(workDir, 'concat.txt')
      await writeFile(listPath, concatListContent(parts), 'utf8')
      await runFfmpeg(
        ctx,
        ['-f', 'concat', '-safe', '0', '-fflags', '+genpts', '-i', listPath, '-map', '0',
          '-c', 'copy', ...containerExtras(opts.outputPath), opts.outputPath],
        { signal: req.signal, totalSec, onProgress, window: { offset: segWeight, scale: 1 - segWeight } }
      )
    }

    const st = await stat(opts.outputPath).catch(() => null)
    if (!st || st.size === 0) {
      throw err('ffmpeg-failed', 'The export finished but produced no output file.', 'Check the log for details.')
    }
    onProgress(1, 0, null)
    return { outputPath: opts.outputPath }
  } catch (e) {
    await removeQuiet(opts.outputPath)
    throw e
  } finally {
    await removeQuiet(workDir)
  }
}

// Lossless copy of a whole file into a new container (used when the user
// "removes" zero ranges but still wants the file rewrapped — and by tests).
export async function rewrap(ctx: EngineCtx, input: string, output: string, signal?: AbortSignal): Promise<void> {
  await runFfmpeg(ctx, ['-i', input, '-map', '0', '-c', 'copy', ...containerExtras(output), output], { signal })
}

export { rename, copyFile }
