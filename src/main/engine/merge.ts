import { stat } from 'node:fs/promises'
import { runFfmpeg } from './run'
import { EngineError, err } from './errors'
import { videoEncodeArgs, containerExtras, type HwEncoder } from './encode'
import { makeWorkDir, removeQuiet, type EngineCtx, type ProgressFn } from './util'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MediaInfo, MergePlan, QualityPreset } from '@shared/types'

type ClipInfo = Pick<MediaInfo, 'path' | 'durationSec' | 'kind' | 'audioTracks' | 'video' | 'container'>

// Display dimensions after rotation is applied (ffmpeg autorotates on decode).
function displayDims(info: ClipInfo): { w: number; h: number } {
  const v = info.video!
  const rotated = v.rotation === 90 || v.rotation === 270
  return rotated ? { w: v.height, h: v.width } : { w: v.width, h: v.height }
}

export function buildMergePlan(infos: ClipInfo[]): MergePlan {
  const reasons = new Set<string>()
  const videos = infos.filter((i) => i.video)
  if (videos.length !== infos.length) reasons.add('audio-only-clip')

  let width = 1280
  let height = 720
  let maxArea = 0
  let fps = 0
  for (const i of videos) {
    const d = displayDims(i)
    if (d.w * d.h > maxArea) { maxArea = d.w * d.h; width = d.w; height = d.h }
    fps = Math.max(fps, i.video!.fps)
  }
  if (fps <= 0) fps = 30
  fps = Math.min(fps, 60)
  // Even dimensions required by yuv420p h264.
  width -= width % 2
  height -= height % 2

  const first = videos[0]
  let fast = videos.length === infos.length && infos.length > 0
  if (fast) {
    for (const i of infos) {
      const v = i.video!
      const f = first.video!
      if (v.codec !== f.codec || v.pixFmt !== f.pixFmt) { reasons.add('codecs-differ'); fast = false }
      const dv = displayDims(i)
      const df = displayDims(first)
      if (dv.w !== df.w || dv.h !== df.h) { reasons.add('resolutions-differ'); fast = false }
      if (Math.abs(v.fps - f.fps) > 0.02) { reasons.add('framerates-differ'); fast = false }
      const a = i.audioTracks[0]
      const fa = first.audioTracks[0]
      if (!!a !== !!fa) { reasons.add('audio-missing'); fast = false }
      else if (a && fa && (a.codec !== fa.codec || a.sampleRate !== fa.sampleRate || a.channels !== fa.channels)) {
        reasons.add('audio-differs'); fast = false
      }
      if (i.container !== first.container) { reasons.add('containers-differ'); fast = false }
    }
  } else if (infos.length > 0) {
    reasons.add('codecs-differ')
  }
  return { fastConcat: fast, width, height, fps, reasons: [...reasons] }
}

export interface MergeRequest {
  infos: ClipInfo[]
  outputPath: string
  quality: QualityPreset
  hwEncoder: HwEncoder | null
  signal?: AbortSignal
  onProgress?: ProgressFn
}

export async function exportMerge(ctx: EngineCtx, req: MergeRequest): Promise<{ outputPath: string }> {
  if (req.infos.length < 2) throw err('merge-too-few', 'Add at least two clips to merge.')
  if (req.infos.some((i) => !i.video)) {
    throw err('merge-audio-clip', 'Merge currently works with video clips only.', 'Remove audio-only files from the list.')
  }
  const plan = buildMergePlan(req.infos)
  const totalSec = req.infos.reduce((s, i) => s + i.durationSec, 0)
  const onProgress: ProgressFn = req.onProgress ?? (() => {})

  if (plan.fastConcat) {
    try {
      await fastConcat(ctx, req, totalSec)
      onProgress(1, 0, null)
      return { outputPath: req.outputPath }
    } catch (e) {
      if (e instanceof EngineError && e.friendly.code !== 'disk-full' && e.friendly.code !== 'permission') {
        ctx.log(`fast concat failed (${e.friendly.code}); falling back to normalized merge`)
        await removeQuiet(req.outputPath)
      } else {
        throw e
      }
    }
  }
  await normalizedMerge(ctx, req, plan, totalSec)
  onProgress(1, 0, null)
  return { outputPath: req.outputPath }
}

async function fastConcat(ctx: EngineCtx, req: MergeRequest, totalSec: number): Promise<void> {
  const workDir = await makeWorkDir(ctx, 'merge')
  try {
    const listPath = path.join(workDir, 'concat.txt')
    const content = req.infos
      .map((i) => `file '${i.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n') + '\n'
    await writeFile(listPath, content, 'utf8')
    await runFfmpeg(
      ctx,
      ['-f', 'concat', '-safe', '0', '-fflags', '+genpts', '-i', listPath,
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', ...containerExtras(req.outputPath), req.outputPath],
      { signal: req.signal, totalSec, onProgress: req.onProgress }
    )
    const st = await stat(req.outputPath).catch(() => null)
    if (!st || st.size === 0) throw err('ffmpeg-failed', 'Merge produced no output file.')
  } finally {
    await removeQuiet(workDir)
  }
}

async function normalizedMerge(ctx: EngineCtx, req: MergeRequest, plan: MergePlan, totalSec: number): Promise<void> {
  const { width: W, height: H, fps: FPS } = plan
  const n = req.infos.length
  const args: string[] = []
  for (const i of req.infos) args.push('-i', i.path)

  // Clips without audio get a silent lavfi input appended after the real ones.
  const silentInputOf = new Map<number, number>()
  let extra = 0
  for (let i = 0; i < n; i++) {
    if (req.infos[i].audioTracks.length === 0) {
      args.push('-f', 'lavfi', '-t', req.infos[i].durationSec.toFixed(3),
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      silentInputOf.set(i, n + extra)
      extra++
    }
  }

  const chains: string[] = []
  const concatIn: string[] = []
  for (let i = 0; i < n; i++) {
    chains.push(
      `[${i}:v:0]fps=${FPS.toFixed(3)},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`
    )
    const aSrc = silentInputOf.has(i) ? `[${silentInputOf.get(i)}:a:0]` : `[${i}:a:0]`
    chains.push(`${aSrc}aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
    concatIn.push(`[v${i}][a${i}]`)
  }
  chains.push(`${concatIn.join('')}concat=n=${n}:v=1:a=1[vout][aout]`)

  const build = (hw: HwEncoder | null): string[] => [
    ...args,
    '-filter_complex', chains.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...videoEncodeArgs(req.quality, hw),
    '-c:a', 'aac', '-b:a', '192k',
    ...containerExtras(req.outputPath), req.outputPath
  ]

  try {
    await runFfmpeg(ctx, build(req.hwEncoder), { signal: req.signal, totalSec, onProgress: req.onProgress })
  } catch (e) {
    if (req.hwEncoder && e instanceof EngineError && e.friendly.code === 'hw-encoder') {
      ctx.log('hardware encoder failed during merge, retrying with libx264')
      await removeQuiet(req.outputPath)
      await runFfmpeg(ctx, build(null), { signal: req.signal, totalSec, onProgress: req.onProgress })
    } else {
      throw e
    }
  }
  const st = await stat(req.outputPath).catch(() => null)
  if (!st || st.size === 0) throw err('ffmpeg-failed', 'Merge produced no output file.')
}
