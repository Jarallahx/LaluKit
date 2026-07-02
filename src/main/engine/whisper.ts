import path from 'node:path'
import os from 'node:os'
import { readFile, stat } from 'node:fs/promises'
import { runExe, runFfmpeg } from './run'
import { CancelledError, err, mapFfmpegError } from './errors'
import { makeWorkDir, removeQuiet, type EngineCtx, type ProgressFn } from './util'
import { modelFilePath } from './models'
import { classifySegment, triageSegments } from './repetition'
import { buildLinesFromWords, detectSpeechRegions, tightenToSpeech } from './timing'
import type { MediaInfo, SubtitleSegment, TranscribeOptions, TranscribeResult } from '@shared/types'

interface WhisperJson {
  result?: { language?: string }
  transcription?: {
    text?: string
    offsets?: { from?: number; to?: number }
  }[]
}

export interface TranscribeRequest {
  opts: TranscribeOptions
  media: Pick<MediaInfo, 'durationSec' | 'audioTracks' | 'path'>
  modelsDir: string
  signal?: AbortSignal
  onProgress?: ProgressFn
}

// Once the CUDA binary fails to initialize on this machine, stay on CPU for
// the rest of the session instead of failing every job twice.
let cudaBroken = false

export function whisperBackendFor(ctx: Pick<EngineCtx, 'whisperCliCuda'>): 'cuda' | 'cpu' {
  return ctx.whisperCliCuda && !cudaBroken ? 'cuda' : 'cpu'
}

// Two stages: extract 16 kHz mono WAV (fast, ~5% of the bar), then run
// whisper-cli with --print-progress and parse its percentage lines.
export async function transcribe(ctx: EngineCtx, req: TranscribeRequest): Promise<TranscribeResult> {
  const { opts, media } = req
  if (media.audioTracks.length === 0) {
    throw err('no-audio', 'This file has no audio track to transcribe.')
  }
  const track = Math.min(Math.max(0, opts.audioTrack), media.audioTracks.length - 1)
  const modelPath = modelFilePath(req.modelsDir, opts.modelId)
  const modelStat = await stat(modelPath).catch(() => null)
  if (!modelStat) {
    throw err('model-missing', `The "${opts.modelId}" model is not downloaded yet.`, 'Download it from the model picker first.')
  }

  // Work files stay ASCII-named inside our temp dir, so source files with any
  // Unicode name (Arabic, emoji...) never hit whisper's path handling.
  const workDir = await makeWorkDir(ctx, 'stt')
  try {
    const wavPath = path.join(workDir, 'audio.wav')
    const WAV_SHARE = 0.05
    try {
      await runFfmpeg(
        ctx,
        ['-i', media.path, '-map', `0:a:${track}`, '-ac', '1', '-ar', '16000',
          '-c:a', 'pcm_s16le', '-vn', '-sn', '-dn', wavPath],
        {
          signal: req.signal,
          totalSec: media.durationSec,
          onProgress: req.onProgress,
          window: { offset: 0, scale: WAV_SHARE }
        }
      )
    } catch (e) {
      throw e instanceof CancelledError ? e : mapToAudioError(e)
    }

    const outBase = path.join(workDir, 'result')
    const threads = Math.max(2, Math.min(16, os.cpus().length - 2))
    // Anti-hallucination decode flags, passed EXPLICITLY so the logged command
    // line is the verification: no cross-segment conditioning (-mc 0),
    // temperature 0 with the 0.2 fallback ladder, entropy threshold 2.4
    // (whisper.cpp's analog of OpenAI's compression-ratio check), logprob
    // -1.0, no-speech 0.6, non-speech tokens suppressed.
    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-oj', '-of', outBase,
      '-l', opts.language || 'auto',
      '-t', String(threads),
      '-mc', '0',
      '-tp', '0.0',
      '-tpi', '0.2',
      '-et', '2.4',
      '-lpt', '-1.0',
      '-nth', '0.6',
      '-sns',
      '--print-progress', '--no-prints'
    ]
    if (opts.translate) args.push('-tr')

    // Precise timing: word-level segments (split-on-word, max length 1) that
    // get regrouped into broadcast-tight lines after decoding.
    const precise = opts.preciseTiming !== false
    if (precise) args.push('-ml', '1', '-sow', '-wt', '0.01')

    // Silero VAD (v6): whisper only ever sees detected speech; silence and
    // music produce gaps instead of hallucinated loops. Aggressive threshold
    // (0.60), 250ms minimum speech, 200ms padding so word edges survive.
    // whisper.cpp maps timestamps back to the original timeline itself.
    const vadUsed = opts.vad !== false && !!ctx.vadModel
    if (vadUsed) {
      args.push(
        '--vad', '--vad-model', ctx.vadModel!,
        '-vt', '0.60',
        '-vspd', '250',
        '-vsd', '300',
        '-vp', '200'
      )
    }

    const runWhisper = async (exe: string, label: string): Promise<{ code: number | null; stderrTail: string }> => {
      ctx.log(`whisper-cli (${label}) ${args.join(' ')}`)
      const started = Date.now()
      let lastPct = 0
      const onLine = (line: string): void => {
        if (/ggml_cuda_init: found \d+ CUDA device/.test(line)) ctx.log(`whisper: ${line.trim()}`)
        const m = /progress\s*=\s*(\d+)%/.exec(line)
        if (!m) return
        const pct = Math.min(100, Number(m[1]))
        if (pct <= lastPct) return
        lastPct = pct
        const frac = pct / 100
        const elapsed = (Date.now() - started) / 1000
        const eta = frac > 0.03 ? (elapsed / frac) * (1 - frac) : null
        req.onProgress?.(WAV_SHARE + frac * (0.98 - WAV_SHARE), eta)
      }
      return runExe(exe, args, { signal: req.signal, onStderrLine: onLine, onStdoutLine: onLine })
    }

    // CUDA first when available; any CUDA-side failure falls back to the CPU
    // build once and pins CPU for the session.
    let backend = whisperBackendFor(ctx)
    let res = await runWhisper(backend === 'cuda' ? ctx.whisperCliCuda! : ctx.whisperCli, backend)
    if (res.code !== 0 && backend === 'cuda' && !req.signal?.aborted) {
      ctx.log(`CUDA whisper failed (exit ${res.code}); falling back to CPU build. stderr: ${res.stderrTail.slice(-300)}`)
      cudaBroken = true
      backend = 'cpu'
      res = await runWhisper(ctx.whisperCli, 'cpu-fallback')
    }
    if (res.code !== 0) {
      const tail = res.stderrTail
      if (/failed to load model|invalid model|failed to initialize whisper context/i.test(tail)) {
        throw err('model-corrupt', 'The speech model file appears to be damaged.', 'Delete the model in Settings and download it again.', tail.slice(-400))
      }
      if (/out of memory|failed to allocate|bad_alloc/i.test(tail)) {
        throw err('oom', 'The computer ran out of memory while transcribing.', 'Try a smaller model (Small or Base), or close other apps.', tail.slice(-400))
      }
      throw err('whisper-failed', 'Speech recognition stopped unexpectedly.', 'Check the log for details.', tail.slice(-400))
    }

    let json: WhisperJson
    try {
      json = JSON.parse(await readFile(outBase + '.json', 'utf8')) as WhisperJson
    } catch {
      throw err('whisper-failed', 'Speech recognition finished but produced no readable result.', 'Check the log for details.')
    }

    const entries = (json.transcription ?? [])
      .map((t) => ({
        start: Math.max(0, (t.offsets?.from ?? 0) / 1000),
        end: Math.max(0, (t.offsets?.to ?? 0) / 1000),
        text: t.text ?? ''
      }))
      .filter((e) => e.text.trim().length > 0 && e.end > e.start)
      // whisper emits "[BLANK_AUDIO]" / music tags on silence; drop them.
      .filter((e) => !/^[\[(♪♫].*[\])♪♫]$/.test(e.text.trim()))

    let raw: SubtitleSegment[]
    if (precise) {
      // Words -> readable lines -> hard-clamped to detected speech, so text
      // on/off mirrors voice on/off.
      const words = entries.map((e) => ({ start: e.start, end: e.end, text: e.text }))
      const lines = buildLinesFromWords(words)
      const regions = await detectSpeechRegions(ctx, wavPath, media.durationSec, req.signal)
      const tightened = tightenToSpeech(lines, regions)
      raw = tightened.map((l, i) => ({ id: i + 1, start: l.start, end: l.end, text: l.text }))
      ctx.log(`precise timing: ${words.length} words -> ${lines.length} lines -> ${tightened.length} after speech clamp (${regions.length} speech regions)`)
    } else {
      raw = entries.map((e, i) => ({ id: i + 1, start: e.start, end: e.end, text: e.text.trim() }))
    }

    const detectedLang = json.result?.language ?? (opts.language === 'auto' ? 'en' : opts.language)

    // Hallucination triage: hard rejects are dropped; suspicious spans get ONE
    // re-transcription at higher temperature — repaired if the retry reads
    // clean, dropped if it hallucinates again. Counts surface in the UI.
    const triage = triageSegments(raw)
    const dropped: SubtitleSegment[] = [...triage.cleaned]
    let repairedCount = 0
    const replacements = new Map<number, string>()
    const REPAIR_CAP = 32

    for (let k = 0; k < triage.suspicious.length; k++) {
      if (req.signal?.aborted) throw new CancelledError()
      const seg = triage.suspicious[k]
      if (k >= REPAIR_CAP) {
        dropped.push(seg)
        continue
      }
      const fixed = await reTranscribeSpan(ctx, {
        exe: backend === 'cuda' ? ctx.whisperCliCuda! : ctx.whisperCli,
        wavPath, workDir, modelPath, threads,
        lang: detectedLang, translate: opts.translate,
        start: seg.start, end: seg.end, signal: req.signal
      })
      const verdict = fixed === null ? 'reject' : classifySegment(fixed, seg.end - seg.start)
      if (fixed !== null && verdict === 'ok') {
        replacements.set(seg.id, fixed)
        repairedCount++
      } else {
        dropped.push(seg)
      }
    }

    const droppedIds = new Set(dropped.map((d) => d.id))
    const segments = triage.segments
      .filter((s) => !droppedIds.has(s.id))
      .map((s) => (replacements.has(s.id) ? { ...s, text: replacements.get(s.id)! } : s))

    if (dropped.length > 0 || repairedCount > 0) {
      ctx.log(`hallucination filter: dropped=${dropped.length} repaired=${repairedCount} ` +
        `examples: ${dropped.slice(0, 3).map((c) => `[${c.start.toFixed(1)}s] ${JSON.stringify(c.text.slice(0, 40))}`).join(', ')}${dropped.length > 3 ? ', …' : ''}`)
    }

    if (segments.length === 0) {
      throw err('no-speech', 'No speech was detected in this audio.', 'If there is speech, try a larger model or pick the language manually.')
    }

    // Renumber after cleanup so ids stay dense.
    segments.forEach((s, i) => { s.id = i + 1 })

    req.onProgress?.(1, 0, null)
    return {
      segments,
      language: detectedLang,
      modelId: opts.modelId,
      backend,
      cleanedCount: dropped.length,
      repairedCount,
      vadUsed
    }
  } finally {
    await removeQuiet(workDir)
  }
}

interface RepairReq {
  exe: string
  wavPath: string
  workDir: string
  modelPath: string
  threads: number
  lang: string
  translate: boolean
  start: number
  end: number
  signal?: AbortSignal
}

// Re-transcribes one suspicious span (±0.25s context) at temperature 0.4.
// Returns the joined text, or null when the retry produced nothing usable.
async function reTranscribeSpan(ctx: EngineCtx, r: RepairReq): Promise<string | null> {
  const from = Math.max(0, r.start - 0.25)
  const dur = Math.max(0.3, r.end - r.start + 0.5)
  const spanWav = path.join(r.workDir, `repair-${r.start.toFixed(2).replace('.', '_')}.wav`)
  const outBase = path.join(r.workDir, `repair-${r.start.toFixed(2).replace('.', '_')}`)
  try {
    const cut = await runExe(ctx.ffmpeg, ['-hide_banner', '-v', 'error', '-y',
      '-ss', from.toFixed(3), '-t', dur.toFixed(3), '-i', r.wavPath,
      '-c:a', 'pcm_s16le', spanWav], { signal: r.signal, timeoutMs: 30000 })
    if (cut.code !== 0) return null
    const args = ['-m', r.modelPath, '-f', spanWav, '-oj', '-of', outBase,
      '-l', r.lang || 'auto', '-t', String(r.threads),
      '-tp', '0.4', '-tpi', '0.2', '-et', '2.4', '-lpt', '-1.0', '-nth', '0.6',
      '-mc', '0', '-sns', '--no-prints']
    if (r.translate) args.push('-tr')
    ctx.log(`whisper repair [${r.start.toFixed(1)}–${r.end.toFixed(1)}s]`)
    const res = await runExe(r.exe, args, { signal: r.signal, timeoutMs: 120000 })
    if (res.code !== 0) return null
    const json = JSON.parse(await readFile(outBase + '.json', 'utf8')) as WhisperJson
    const text = (json.transcription ?? [])
      .map((t) => (t.text ?? '').trim())
      .filter((t) => t.length > 0 && !/^[\[(♪♫].*[\])♪♫]$/.test(t))
      .join(' ')
      .trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

function mapToAudioError(e: unknown): unknown {
  if (e && typeof e === 'object' && 'friendly' in e) return e
  return mapFfmpegError(String(e), 1)
}
