import path from 'node:path'
import { stat } from 'node:fs/promises'
import { runFfprobeJson } from './run'
import { err } from './errors'
import { fileSignature, type EngineCtx } from './util'
import type { AudioStreamInfo, MediaInfo, PlaybackMode, VideoStreamInfo } from '@shared/types'

interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  bit_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: { side_data_type?: string; rotation?: number }[]
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string }
  streams?: FfprobeStream[]
}

function parseFps(s: string | undefined): number {
  if (!s) return 0
  const [num, den] = s.split('/').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return 0
  const fps = num / den
  return fps > 0 && fps <= 480 ? fps : 0
}

const PLAYABLE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'm4a', 'mp3', 'ogg', 'wav', 'flac', 'opus', 'aac', 'weba'])
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le', 'pcm_s24le'])
const EIGHT_BIT_PIX = /^(yuv420p|yuvj420p|nv12|yuv444p|yuvj444p|yuv422p|yuvj422p)$/

export interface ProbeResult {
  info: Omit<MediaInfo, 'playback'>
  playbackMode: PlaybackMode
}

export async function probeFile(ctx: EngineCtx, filePath: string): Promise<ProbeResult> {
  let st
  try {
    st = await stat(filePath)
  } catch {
    throw err('not-found', 'That file could not be found.', 'It may have been moved, renamed or deleted.')
  }
  if (!st.isFile()) throw err('not-found', 'That path is not a file.')
  if (st.size === 0) throw err('corrupt', 'This file is empty (0 bytes).')

  let raw: FfprobeOutput
  try {
    raw = (await runFfprobeJson(ctx, ['-show_format', '-show_streams', filePath])) as FfprobeOutput
  } catch (e) {
    // ffprobe errors on unreadable media; normalize the message for openers.
    throw err('corrupt', "This file couldn't be read. It may be corrupt or not a media file.", 'Try playing it in another player to confirm it works.')
  }

  const streams = raw.streams ?? []
  const vStream = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const aStreams = streams.filter((s) => s.codec_type === 'audio')
  const sStreams = streams.filter((s) => s.codec_type === 'subtitle')
  if (!vStream && aStreams.length === 0) {
    throw err('corrupt', 'No audio or video streams were found in this file.')
  }

  let duration = Number(raw.format?.duration ?? NaN)
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Number(vStream?.duration ?? aStreams[0]?.duration ?? NaN)
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw err('corrupt', "This file's duration could not be determined. It may be truncated or corrupt.")
  }

  let video: VideoStreamInfo | null = null
  if (vStream && vStream.width && vStream.height) {
    const rotRaw = vStream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(vStream.tags?.rotate ?? 0)
    const fps = parseFps(vStream.avg_frame_rate) || parseFps(vStream.r_frame_rate) || 30
    video = {
      codec: vStream.codec_name ?? 'unknown',
      width: vStream.width,
      height: vStream.height,
      fps,
      pixFmt: vStream.pix_fmt ?? '',
      bitrate: vStream.bit_rate ? Number(vStream.bit_rate) : null,
      rotation: Number.isFinite(rotRaw) ? Math.abs(Number(rotRaw)) % 360 : 0
    }
  }

  const audioTracks: AudioStreamInfo[] = aStreams.map((s, i) => ({
    index: i,
    codec: s.codec_name ?? 'unknown',
    sampleRate: Number(s.sample_rate ?? 0),
    channels: s.channels ?? 0,
    lang: s.tags?.language ?? null,
    title: s.tags?.title ?? null
  }))

  const ext = path.extname(filePath).slice(1).toLowerCase()
  const kind: 'video' | 'audio' = video ? 'video' : 'audio'

  // Decide how the preview player gets this file:
  //  direct   - the <video> element can play the original file
  //  remux    - codecs are fine, container is not; near-instant rewrap
  //  transcode- codecs unsupported; build a lightweight h264 proxy
  const containerOk = PLAYABLE_CONTAINERS.has(ext)
  const videoOk = !video || (PLAYABLE_VIDEO.has(video.codec) && EIGHT_BIT_PIX.test(video.pixFmt) && video.fps <= 121)
  const firstAudio = audioTracks[0]
  const audioOk = !firstAudio || PLAYABLE_AUDIO.has(firstAudio.codec)
  let playbackMode: PlaybackMode
  if (containerOk && videoOk && audioOk) playbackMode = 'direct'
  else if (videoOk && audioOk && video) playbackMode = 'remux'
  else playbackMode = 'transcode'

  const info: Omit<MediaInfo, 'playback'> = {
    id: await fileSignature(filePath),
    path: filePath,
    fileName: path.basename(filePath),
    dirName: path.dirname(filePath),
    sizeBytes: st.size,
    container: (raw.format?.format_name ?? ext).split(',')[0],
    durationSec: duration,
    kind,
    video,
    audioTracks,
    subtitleTrackCount: sStreams.length
  }
  return { info, playbackMode }
}
