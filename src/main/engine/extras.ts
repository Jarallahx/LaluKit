import path from 'node:path'
import { stat } from 'node:fs/promises'
import { runFfmpeg } from './run'
import { EngineError, err } from './errors'
import { videoEncodeArgs, containerExtras, type HwEncoder } from './encode'
import { makeWorkDir, removeQuiet, type EngineCtx, type ProgressFn } from './util'
import type { ExtractAudioOptions, GifExportOptions, MediaInfo, ReverseOptions } from '@shared/types'

type Media = Pick<MediaInfo, 'path' | 'durationSec' | 'audioTracks' | 'video' | 'kind'>

async function assertOutput(p: string, what: string): Promise<void> {
  const st = await stat(p).catch(() => null)
  if (!st || st.size === 0) throw err('ffmpeg-failed', `${what} produced no output file.`)
}

// ---------- extract audio ----------

export async function extractAudio(
  ctx: EngineCtx,
  opts: ExtractAudioOptions,
  media: Media,
  signal?: AbortSignal,
  onProgress?: ProgressFn
): Promise<{ outputPath: string }> {
  if (media.audioTracks.length === 0) throw err('no-audio', 'This file has no audio track to extract.')
  const codec = opts.format === 'mp3'
    ? ['-c:a', 'libmp3lame', '-q:a', '2']
    : ['-c:a', 'pcm_s16le']
  try {
    await runFfmpeg(ctx, ['-i', opts.inputPath, '-map', '0:a:0', '-vn', '-sn', '-dn', ...codec, opts.outputPath],
      { signal, totalSec: media.durationSec, onProgress })
    await assertOutput(opts.outputPath, 'Audio extraction')
    onProgress?.(1, 0, null)
    return { outputPath: opts.outputPath }
  } catch (e) {
    await removeQuiet(opts.outputPath)
    throw e
  }
}

// ---------- GIF (two-pass palette for clean colors) ----------

export async function exportGif(
  ctx: EngineCtx,
  opts: GifExportOptions,
  media: Media,
  signal?: AbortSignal,
  onProgress?: ProgressFn
): Promise<{ outputPath: string }> {
  if (!media.video) throw err('no-video', 'GIF export needs a video file.')
  const start = Math.max(0, opts.start)
  const len = Math.max(0.1, Math.min(opts.end, media.durationSec) - start)
  if (len > 60.5) {
    throw err('gif-too-long', 'GIF export is limited to 60 seconds.', 'Select a shorter range on the timeline.')
  }
  const width = Math.min(opts.maxWidth, media.video.width)
  const scaleFilter = `fps=${opts.fps},scale=${width}:-1:flags=lanczos`
  const workDir = await makeWorkDir(ctx, 'gif')
  try {
    const palette = path.join(workDir, 'palette.png')
    await runFfmpeg(ctx,
      ['-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', opts.inputPath,
        '-vf', `${scaleFilter},palettegen=stats_mode=diff`, palette],
      { signal, totalSec: len, onProgress, window: { offset: 0, scale: 0.35 } })
    await runFfmpeg(ctx,
      ['-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', opts.inputPath, '-i', palette,
        '-filter_complex', `[0:v]${scaleFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        '-loop', String(opts.loop), opts.outputPath],
      { signal, totalSec: len, onProgress, window: { offset: 0.35, scale: 0.65 } })
    await assertOutput(opts.outputPath, 'GIF export')
    onProgress?.(1, 0, null)
    return { outputPath: opts.outputPath }
  } catch (e) {
    await removeQuiet(opts.outputPath)
    throw e
  } finally {
    await removeQuiet(workDir)
  }
}

// ---------- reverse ----------

export async function reverseExport(
  ctx: EngineCtx,
  opts: ReverseOptions,
  media: Media,
  hwEncoder: HwEncoder | null,
  signal?: AbortSignal,
  onProgress?: ProgressFn
): Promise<{ outputPath: string }> {
  const start = opts.start ?? 0
  const end = opts.end ?? media.durationSec
  const len = Math.max(0.1, end - start)
  // reverse buffers all frames in memory; keep it bounded.
  if (len > 300.5) {
    throw err('reverse-too-long', 'Reversing is limited to 5 minutes at a time.', 'Select a shorter range on the timeline.')
  }
  const hasAudio = media.audioTracks.length > 0
  const build = (hw: HwEncoder | null): string[] => {
    const args = ['-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', opts.inputPath]
    if (media.video) {
      args.push('-map', '0:v:0', '-vf', 'reverse', ...videoEncodeArgs(opts.quality, hw))
      if (hasAudio) args.push('-map', '0:a:0', '-af', 'areverse', '-c:a', 'aac', '-b:a', '192k')
    } else {
      args.push('-map', '0:a:0', '-af', 'areverse', '-c:a', 'aac', '-b:a', '192k')
    }
    args.push('-sn', '-dn', ...containerExtras(opts.outputPath), opts.outputPath)
    return args
  }
  try {
    try {
      await runFfmpeg(ctx, build(opts.useHardware ? hwEncoder : null), { signal, totalSec: len, onProgress })
    } catch (e) {
      if (opts.useHardware && hwEncoder && e instanceof EngineError && e.friendly.code === 'hw-encoder') {
        ctx.log('hardware encoder failed during reverse, retrying with libx264')
        await removeQuiet(opts.outputPath)
        await runFfmpeg(ctx, build(null), { signal, totalSec: len, onProgress })
      } else {
        throw e
      }
    }
    await assertOutput(opts.outputPath, 'Reverse export')
    onProgress?.(1, 0, null)
    return { outputPath: opts.outputPath }
  } catch (e) {
    await removeQuiet(opts.outputPath)
    throw e
  }
}
