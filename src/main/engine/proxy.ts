import { runFfmpeg } from './run'
import { EngineError } from './errors'
import type { EngineCtx, ProgressFn } from './util'
import type { MediaInfo } from '@shared/types'

export interface ProxyRequest {
  info: Pick<MediaInfo, 'path' | 'durationSec' | 'kind' | 'audioTracks' | 'video'>
  mode: 'remux' | 'transcode'
  outPath: string // .mp4 (video) or .m4a (audio-only)
  signal?: AbortSignal
  onProgress?: ProgressFn
}

// Builds the preview proxy the <video> element plays when the original can't
// be played directly. Remux first (instant) when codecs allow, full transcode
// otherwise. The caller falls back remux -> transcode on failure.
export async function makeProxy(ctx: EngineCtx, req: ProxyRequest): Promise<string> {
  const { info } = req
  const hasAudio = info.audioTracks.length > 0

  if (req.mode === 'remux') {
    const args = ['-i', info.path]
    if (info.kind === 'video') args.push('-map', '0:v:0')
    if (hasAudio) args.push('-map', '0:a:0')
    args.push('-c', 'copy', '-sn', '-dn', '-movflags', '+faststart', req.outPath)
    await runFfmpeg(ctx, args, { signal: req.signal, totalSec: info.durationSec, onProgress: req.onProgress })
    return req.outPath
  }

  const args = ['-i', info.path]
  if (info.kind === 'video') {
    args.push('-map', '0:v:0')
    if (hasAudio) args.push('-map', '0:a:0')
    args.push(
      '-vf', "scale='min(1280,iw)':-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    )
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-sn', '-dn', '-movflags', '+faststart', req.outPath)
  } else {
    args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-vn', '-sn', '-dn', '-movflags', '+faststart', req.outPath)
  }
  await runFfmpeg(ctx, args, { signal: req.signal, totalSec: info.durationSec, onProgress: req.onProgress })
  return req.outPath
}

export async function makeProxyWithFallback(ctx: EngineCtx, req: ProxyRequest): Promise<string> {
  if (req.mode === 'remux') {
    try {
      return await makeProxy(ctx, req)
    } catch (e) {
      if (e instanceof EngineError) {
        ctx.log(`remux proxy failed (${e.friendly.code}), falling back to transcode`)
        return makeProxy(ctx, { ...req, mode: 'transcode' })
      }
      throw e
    }
  }
  return makeProxy(ctx, req)
}
