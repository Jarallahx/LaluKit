import path from 'node:path'
import { writeFile, stat, readdir, copyFile, mkdir } from 'node:fs/promises'
import { runFfmpeg } from './run'
import { EngineError, err } from './errors'
import { videoEncodeArgs, containerExtras, type HwEncoder } from './encode'
import { iso639_2, makeWorkDir, removeQuiet, type EngineCtx, type ProgressFn } from './util'
import type { AttachOptions, BurnInOptions, MediaInfo, SubtitleSegment, SubtitleStyle } from '@shared/types'

// ---------- text formats ----------

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function srtTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(ss)},${pad(ms, 3)}`
}

function vttTime(sec: number): string {
  return srtTime(sec).replace(',', '.')
}

function cleanText(text: string): string {
  // Strip ASCII control characters; keep \n for intentional line breaks.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
}

function orderedSegments(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments
    .map((s) => ({ ...s, text: cleanText(s.text) }))
    .filter((s) => s.text.length > 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start)
}

export function buildSrt(segments: SubtitleSegment[]): string {
  const segs = orderedSegments(segments)
  const blocks = segs.map((s, i) => `${i + 1}\r\n${srtTime(s.start)} --> ${srtTime(s.end)}\r\n${s.text.replace(/\n/g, '\r\n')}\r\n`)
  // BOM keeps legacy Windows players happy with Arabic and other non-ASCII text.
  return '\uFEFF' + blocks.join('\r\n')
}

export function buildVtt(segments: SubtitleSegment[]): string {
  const segs = orderedSegments(segments)
  const blocks = segs.map((s) => `${vttTime(s.start)} --> ${vttTime(s.end)}\n${s.text}\n`)
  return 'WEBVTT\n\n' + blocks.join('\n')
}

export async function writeSubtitleFile(
  segments: SubtitleSegment[],
  format: 'srt' | 'vtt',
  outPath: string
): Promise<void> {
  if (orderedSegments(segments).length === 0) {
    throw err('no-segments', 'There are no subtitle lines to export.')
  }
  const content = format === 'srt' ? buildSrt(segments) : buildVtt(segments)
  await writeFile(outPath, content, 'utf8')
}

// ---------- ASS (burn-in styling) ----------

function assColor(hex: string, alphaByte = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const rgb = m ? m[1] : 'ffffff'
  const r = rgb.slice(0, 2)
  const g = rgb.slice(2, 4)
  const b = rgb.slice(4, 6)
  const alpha = alphaByte.toString(16).padStart(2, '0')
  return `&H${alpha}${b}${g}${r}`.toUpperCase()
}

function assTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.round((s - Math.floor(s)) * 100)
  return `${h}:${pad(m)}:${pad(ss)}.${pad(cs)}`
}

function assEscape(text: string): string {
  // Braces start ASS override blocks; swap them for lookalikes.
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N')
}

export function buildAss(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
  videoW: number,
  videoH: number
): string {
  const segs = orderedSegments(segments)
  // Style sizes are authored against a 720p canvas and scaled to the video.
  const scale = videoH / 720
  const fontSize = Math.max(8, Math.round(style.fontSize * scale))
  const outline = Math.round(style.outlineWidth * scale * 10) / 10
  const marginV = Math.max(10, Math.round(style.marginV * scale))
  const alignment = style.position === 'bottom' ? 2 : style.position === 'middle' ? 5 : 8
  const borderStyle = style.background ? 3 : 1
  const backColor = style.background ? assColor('#000000', 0x60) : assColor('#000000', 0)
  const marginH = Math.round(40 * scale)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${videoW}`,
    `PlayResY: ${videoH}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.fontFamily},${fontSize},${assColor(style.color)},&H000000FF,${assColor(style.outlineColor)},${backColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const events = segs.map(
    (s) => `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Default,,0,0,0,,${assEscape(s.text)}`
  )
  return header.concat(events).join('\n') + '\n'
}

// ---------- burn-in ----------

export interface BurnRequest {
  opts: BurnInOptions
  media: Pick<MediaInfo, 'durationSec' | 'video' | 'audioTracks' | 'path'>
  hwEncoder: HwEncoder | null
  signal?: AbortSignal
  onProgress?: ProgressFn
}

const MP4_AUDIO_COPY_OK = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac'])

export async function burnIn(ctx: EngineCtx, req: BurnRequest): Promise<{ outputPath: string }> {
  const { opts, media } = req
  if (!media.video) throw err('no-video', 'Subtitles can only be burned into a video file.')
  if (orderedSegments(opts.segments).length === 0) throw err('no-segments', 'There are no subtitle lines to burn in.')

  const workDir = await makeWorkDir(ctx, 'burn')
  try {
    const assPath = path.join(workDir, 'subs.ass')
    await writeFile(assPath, buildAss(opts.segments, opts.style, media.video.width, media.video.height), 'utf8')

    // Bundled fonts (Noto Sans + Noto Sans Arabic) are copied next to the ASS
    // file so rendering never depends on the user's installed fonts. Relative
    // paths + cwd dodge the Windows drive-colon filtergraph escaping mess.
    let subFilter = 'ass=subs.ass'
    if (ctx.fontsDir) {
      try {
        const fonts = (await readdir(ctx.fontsDir)).filter((f) => /\.(ttf|otf)$/i.test(f))
        if (fonts.length > 0) {
          await mkdir(path.join(workDir, 'fonts'), { recursive: true })
          for (const f of fonts) {
            await copyFile(path.join(ctx.fontsDir, f), path.join(workDir, 'fonts', f))
          }
          subFilter = 'ass=subs.ass:fontsdir=fonts'
        }
      } catch (e) {
        ctx.log(`bundled fonts unavailable (${(e as Error).message}); falling back to system fonts`)
      }
    }

    const outExt = path.extname(opts.outputPath).toLowerCase()
    const audioCodec = media.audioTracks[0]?.codec ?? ''
    const canCopyAudio =
      media.audioTracks.length > 0 &&
      (outExt === '.mkv' || MP4_AUDIO_COPY_OK.has(audioCodec))

    const build = (hw: HwEncoder | null): string[] => {
      const args = ['-i', media.path, '-map', '0:v:0']
      if (media.audioTracks.length > 0) args.push('-map', '0:a')
      args.push('-vf', subFilter, ...videoEncodeArgs(opts.quality, hw))
      if (media.audioTracks.length > 0) {
        args.push(...(canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']))
      }
      args.push('-sn', '-dn', ...containerExtras(opts.outputPath), opts.outputPath)
      return args
    }

    try {
      await runFfmpeg(ctx, build(req.hwEncoder), {
        signal: req.signal, totalSec: media.durationSec, onProgress: req.onProgress, cwd: workDir
      })
    } catch (e) {
      if (req.hwEncoder && e instanceof EngineError && e.friendly.code === 'hw-encoder') {
        ctx.log('hardware encoder failed during burn-in, retrying with libx264')
        await removeQuiet(opts.outputPath)
        await runFfmpeg(ctx, build(null), {
          signal: req.signal, totalSec: media.durationSec, onProgress: req.onProgress, cwd: workDir
        })
      } else {
        throw e
      }
    }
    const st = await stat(opts.outputPath).catch(() => null)
    if (!st || st.size === 0) throw err('ffmpeg-failed', 'Burn-in produced no output file.')
    req.onProgress?.(1, 0, null)
    return { outputPath: opts.outputPath }
  } catch (e) {
    await removeQuiet(opts.outputPath)
    throw e
  } finally {
    await removeQuiet(workDir)
  }
}

// ---------- soft subtitles ----------

export interface AttachRequest {
  opts: AttachOptions
  media: Pick<MediaInfo, 'durationSec' | 'subtitleTrackCount' | 'path' | 'video'>
  signal?: AbortSignal
  onProgress?: ProgressFn
}

export async function attachSoft(ctx: EngineCtx, req: AttachRequest): Promise<{ outputPath: string }> {
  const { opts, media } = req
  if (!media.video) throw err('no-video', 'Soft subtitles can only be attached to a video file.')
  if (orderedSegments(opts.segments).length === 0) throw err('no-segments', 'There are no subtitle lines to attach.')

  const outExt = path.extname(opts.outputPath).toLowerCase()
  const subCodec = outExt === '.mkv' ? 'srt' : outExt === '.webm' ? 'webvtt' : 'mov_text'
  const workDir = await makeWorkDir(ctx, 'attach')
  try {
    const srtPath = path.join(workDir, 'subs.srt')
    await writeFile(srtPath, buildSrt(opts.segments), 'utf8')
    const newSubIndex = media.subtitleTrackCount // appended after existing subtitle streams
    const lang = iso639_2(opts.language)
    const args = [
      '-i', media.path, '-i', srtPath,
      '-map', '0', '-map', '1:0',
      '-c', 'copy', '-c:s', subCodec,
      `-metadata:s:s:${newSubIndex}`, `language=${lang}`,
      `-disposition:s:${newSubIndex}`, 'default',
      ...containerExtras(opts.outputPath), opts.outputPath
    ]
    try {
      await runFfmpeg(ctx, args, { signal: req.signal, totalSec: media.durationSec, onProgress: req.onProgress })
    } catch (e) {
      if (e instanceof EngineError && media.subtitleTrackCount > 0) {
        // Existing subtitle streams (e.g. PGS bitmaps) may refuse conversion;
        // retry keeping only A/V from the source.
        ctx.log('attach with existing subs failed, retrying without source subtitle streams')
        await removeQuiet(opts.outputPath)
        const args2 = [
          '-i', media.path, '-i', srtPath,
          '-map', '0:v', '-map', '0:a?', '-map', '1:0',
          '-c', 'copy', '-c:s', subCodec,
          '-metadata:s:s:0', `language=${lang}`,
          '-disposition:s:0', 'default',
          ...containerExtras(opts.outputPath), opts.outputPath
        ]
        await runFfmpeg(ctx, args2, { signal: req.signal, totalSec: media.durationSec, onProgress: req.onProgress })
      } else {
        throw e
      }
    }
    const st = await stat(opts.outputPath).catch(() => null)
    if (!st || st.size === 0) throw err('ffmpeg-failed', 'Attaching subtitles produced no output file.')
    req.onProgress?.(1, 0, null)
    return { outputPath: opts.outputPath }
  } catch (e) {
    await removeQuiet(opts.outputPath)
    throw e
  } finally {
    await removeQuiet(workDir)
  }
}
