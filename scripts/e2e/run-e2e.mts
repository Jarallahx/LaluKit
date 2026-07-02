// End-to-end engine tests. Drives the exact modules the app uses (no mocks):
// generates real media with ffmpeg, synthesizes speech with Windows SAPI,
// cuts, merges, transcribes with whisper, burns subtitles and checks pixels.
//
// Run: npm run e2e        (add --verbose for engine logs)

import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile, readFile, stat, readdir, copyFile as copyFileFs } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EngineCtx } from '../../src/main/engine/util'
import { complementRanges, normalizeRanges } from '../../src/main/engine/util'
import { probeFile } from '../../src/main/engine/probe'
import { exportCut, effectiveRanges } from '../../src/main/engine/cut'
import { buildMergePlan, exportMerge } from '../../src/main/engine/merge'
import { computeWaveform } from '../../src/main/engine/waveform'
import { generateThumbs } from '../../src/main/engine/thumbs'
import { keyframesNear } from '../../src/main/engine/keyframes'
import { buildSrt, buildVtt, burnIn, attachSoft, writeSubtitleFile } from '../../src/main/engine/subtitles'
import { extractAudio, exportGif, reverseExport } from '../../src/main/engine/extras'
import { transcribe } from '../../src/main/engine/whisper'
import { downloadModel, listModels, modelFilePath } from '../../src/main/engine/models'
import { CancelledError, EngineError, mapFfmpegError } from '../../src/main/engine/errors'
import { runExe } from '../../src/main/engine/run'
import type { SubtitleSegment, SubtitleStyle } from '../../src/shared/types'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const binDir = path.join(root, 'resources', 'bin')
const work = path.join(root, 'scripts', 'e2e', '.work')
const outDir = path.join(work, 'out')
const assetDir = path.join(work, 'assets')
const modelsDir = path.join(work, 'models') // survives reruns so tiny.bin downloads once
const verbose = process.argv.includes('--verbose')

const cudaCli = path.join(binDir, 'whisper-cuda', 'whisper-cli.exe')
const vadModel = ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin']
  .map((n) => path.join(binDir, 'whisper', n))
  .find((p) => existsSync(p)) ?? path.join(binDir, 'whisper', 'ggml-silero-v6.2.0.bin')
const ctx: EngineCtx = {
  ffmpeg: path.join(binDir, 'ffmpeg.exe'),
  ffprobe: path.join(binDir, 'ffprobe.exe'),
  whisperCli: path.join(binDir, 'whisper', 'whisper-cli.exe'),
  whisperCliCuda: existsSync(cudaCli) ? cudaCli : null,
  vadModel: existsSync(vadModel) ? vadModel : null,
  fontsDir: existsSync(path.join(root, 'resources', 'fonts')) ? path.join(root, 'resources', 'fonts') : null,
  tempDir: path.join(work, 'tmp'),
  log: (m) => { if (verbose) console.log(`    [engine] ${m}`) }
}

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now()
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${msg}`)
    console.error(`  FAIL  ${name}: ${msg}`)
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert(Math.abs(actual - expected) <= tol, `${what}: expected ${expected}±${tol}, got ${actual.toFixed(3)}`)
}

async function ff(args: string[]): Promise<void> {
  const res = await runExe(ctx.ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args])
  if (res.code !== 0) throw new Error(`asset ffmpeg failed: ${res.stderrTail.slice(-300)}`)
}

interface ProbeLite {
  duration: number
  vCodec: string | null
  aCodec: string | null
  width: number
  height: number
  fps: number
  nbFrames: number
  subCodecs: string[]
  subLangs: string[]
  audioRate: number
}

async function probeLite(file: string): Promise<ProbeLite> {
  const res = await runExe(ctx.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file])
  if (res.code !== 0) throw new Error(`ffprobe failed: ${res.stderrTail.slice(-200)}`)
  const j = JSON.parse(res.stdout)
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'video')
  const a = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'audio')
  const subs = (j.streams ?? []).filter((s: { codec_type: string }) => s.codec_type === 'subtitle')
  const fpsParts = (v?.avg_frame_rate ?? '0/1').split('/')
  return {
    duration: Number(j.format?.duration ?? 0),
    vCodec: v?.codec_name ?? null,
    aCodec: a?.codec_name ?? null,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: Number(fpsParts[0]) / Math.max(1, Number(fpsParts[1])),
    nbFrames: Number(v?.nb_read_frames ?? v?.nb_frames ?? 0),
    subCodecs: subs.map((s: { codec_name?: string }) => s.codec_name ?? '?'),
    subLangs: subs.map((s: { tags?: { language?: string } }) => s.tags?.language ?? '?'),
    audioRate: Number(a?.sample_rate ?? 0)
  }
}

// Bottom quarter of a frame as raw grayscale bytes (for burn-in pixel checks).
async function bottomStrip(file: string, t: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  const res = await runExe(ctx.ffmpeg, [
    '-hide_banner', '-v', 'error', '-ss', t.toFixed(3), '-i', file,
    '-frames:v', '1', '-vf', 'crop=iw:ih/4:0:3*ih/4,scale=160:40,format=gray',
    '-f', 'rawvideo', '-'
  ], { onStdoutChunk: (c) => { chunks.push(c) } })
  if (res.code !== 0) throw new Error(`frame extract failed: ${res.stderrTail.slice(-200)}`)
  return Buffer.concat(chunks)
}

// Fraction of pixels that changed materially (robust against encode noise,
// unlike a mean which gets diluted by unchanged background).
function changedFraction(a: Buffer, b: Buffer, minDelta = 40): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let changed = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > minDelta) changed++
  }
  return changed / n
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('LaluKit engine e2e\n')
  assert(existsSync(ctx.ffmpeg) && existsSync(ctx.ffprobe) && existsSync(ctx.whisperCli),
    'binaries missing — run npm run setup:bins first')

  await rm(outDir, { recursive: true, force: true })
  await rm(path.join(work, 'tmp'), { recursive: true, force: true })
  for (const d of [outDir, assetDir, modelsDir, ctx.tempDir]) await mkdir(d, { recursive: true })

  // ---- assets ----
  console.log('· generating test media')
  const A = path.join(assetDir, 'testA.mp4') // 640x360 @30, sine 440
  const B = path.join(assetDir, 'testB.mp4') // 1280x720 @25, sine 880
  const C = path.join(assetDir, 'testC.mkv') // A remuxed to mkv
  const D = path.join(assetDir, 'testD-silent.mp4') // no audio
  const CORRUPT = path.join(assetDir, 'corrupt.mp4')
  const SPEECH_WAV = path.join(assetDir, 'speech.wav')
  const SPEECH = path.join(assetDir, 'speech.mp4')

  if (!existsSync(A)) {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', A])
  }
  if (!existsSync(B)) {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=5:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-b:a', '96k', '-shortest', B])
  }
  if (!existsSync(C)) await ff(['-i', A, '-c', 'copy', C])
  if (!existsSync(D)) {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-an', D])
  }
  const noise = Buffer.alloc(64 * 1024)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 197 + 13) % 256
  await writeFile(CORRUPT, noise)

  if (!existsSync(SPEECH_WAV)) {
    console.log('· synthesizing speech via Windows SAPI')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type -AssemblyName System.Speech;
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
      $s.Rate = -1;
      $s.SetOutputToWaveFile('${SPEECH_WAV.replace(/'/g, "''")}');
      $s.Speak('The quick brown fox jumps over the lazy dog. The five boxing wizards jump quickly.');
      $s.Dispose();
    `], { windowsHide: true, timeout: 60000 })
  }
  if (!existsSync(SPEECH)) {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=60', '-i', SPEECH_WAV,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', SPEECH])
  }
  console.log('· assets ready\n')

  const infoA = (await probeFile(ctx, A)).info

  // ---- unit-ish: range math + error mapping ----
  await test('range math: normalize/merge/complement', async () => {
    const norm = normalizeRanges([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 2.5, end: 4 }], 10)
    assert(norm.length === 2, `expected 2 merged ranges, got ${norm.length}`)
    near(norm[0].start, 1, 0.001, 'norm[0].start')
    near(norm[0].end, 4, 0.001, 'norm[0].end')
    const comp = complementRanges(norm, 10)
    assert(comp.length === 3, `expected 3 complement ranges, got ${comp.length}`)
    near(comp[0].start, 0, 0.001, 'comp[0].start')
    near(comp[2].end, 10, 0.001, 'comp[2].end')
    const eff = effectiveRanges([{ start: 2, end: 6 }], 'remove', 8)
    assert(eff.length === 2 && Math.abs(eff[0].end - 2) < 0.01 && Math.abs(eff[1].start - 6) < 0.01, 'remove-mode complement wrong')
  })

  await test('error mapping: disk-full / corrupt / hw', async () => {
    assert(mapFfmpegError('No space left on device', 1).friendly.code === 'disk-full', 'disk-full not mapped')
    assert(mapFfmpegError('xx Invalid data found when processing input yy', 1).friendly.code === 'corrupt', 'corrupt not mapped')
    assert(mapFfmpegError('Cannot load nvcuda.dll', 1).friendly.code === 'hw-encoder', 'hw not mapped')
  })

  // ---- probe ----
  await test('probe: valid video', async () => {
    assert(infoA.video !== null, 'no video stream found')
    assert(infoA.video!.codec === 'h264', `codec ${infoA.video!.codec}`)
    assert(infoA.video!.width === 640 && infoA.video!.height === 360, 'wrong dimensions')
    near(infoA.video!.fps, 30, 0.1, 'fps')
    near(infoA.durationSec, 8, 0.2, 'duration')
    assert(infoA.audioTracks.length === 1 && infoA.audioTracks[0].codec === 'aac', 'audio track wrong')
  })

  await test('probe: corrupt file raises friendly error', async () => {
    try {
      await probeFile(ctx, CORRUPT)
      throw new Error('probe accepted a corrupt file')
    } catch (e) {
      assert(e instanceof EngineError, `unexpected error type: ${e}`)
      assert((e as EngineError).friendly.code === 'corrupt', `code ${(e as EngineError).friendly.code}`)
    }
  })

  // ---- cutting ----
  await test('cut exact: single range is frame-accurate', async () => {
    const out = path.join(outDir, 'cut-single.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 2, end: 4 }], mode: 'keep', engine: 'exact', quality: 'fast', useHardware: false, outputPath: out },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 2, 0.05, 'output duration')
    near(p.nbFrames, 60, 1, 'frame count')
    assert(p.aCodec === 'aac', 'audio missing from cut')
  })

  await test('cut exact: multi-range keep concatenates', async () => {
    const out = path.join(outDir, 'cut-multi.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 1, end: 2 }, { start: 5, end: 6.5 }], mode: 'keep', engine: 'exact', quality: 'fast', useHardware: false, outputPath: out },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 2.5, 0.1, 'concat duration')
    near(p.nbFrames, 75, 3, 'concat frames')
  })

  await test('cut exact: remove mode inverts selection', async () => {
    const out = path.join(outDir, 'cut-remove.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 2, end: 6 }], mode: 'remove', engine: 'exact', quality: 'fast', useHardware: false, outputPath: out },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 4, 0.1, 'remove-mode duration')
  })

  await test('cut lossless: keyframe-aligned stream copy', async () => {
    const kfs = await keyframesNear(ctx, A, 2, 4)
    assert(kfs.length > 0, 'no keyframes found near 2s')
    const kf = kfs.reduce((best, k) => (Math.abs(k - 2) < Math.abs(best - 2) ? k : best))
    const out = path.join(outDir, 'cut-lossless.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: kf, end: kf + 3 }], mode: 'keep', engine: 'lossless', quality: 'fast', useHardware: false, outputPath: out },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 3, 0.6, 'lossless duration (GOP tolerance)')
    assert(p.vCodec === 'h264', 'lossless changed the codec')
  })

  await test('cut: empty selection raises friendly error', async () => {
    try {
      await exportCut(ctx, {
        opts: { inputPath: A, ranges: [], mode: 'keep', engine: 'exact', quality: 'fast', useHardware: false, outputPath: path.join(outDir, 'nope.mp4') },
        media: infoA, hwEncoder: null
      })
      throw new Error('empty selection was accepted')
    } catch (e) {
      assert(e instanceof EngineError && e.friendly.code === 'empty-selection', `unexpected: ${e}`)
    }
  })

  await test('cut: cancellation kills ffmpeg and cleans output', async () => {
    // Heavy clip + slow preset so the encode reliably outlives the abort.
    const HEAVY = path.join(assetDir, 'heavy1080.mp4')
    if (!existsSync(HEAVY)) {
      await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=25',
        '-f', 'lavfi', '-i', 'sine=frequency=330:duration=25',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', HEAVY])
    }
    const infoH = (await probeFile(ctx, HEAVY)).info
    const out = path.join(outDir, 'cut-cancelled.mp4')
    const ac = new AbortController()
    const promise = exportCut(ctx, {
      opts: { inputPath: HEAVY, ranges: [{ start: 0, end: 25 }], mode: 'keep', engine: 'exact', quality: 'best', useHardware: false, outputPath: out },
      media: infoH, hwEncoder: null, signal: ac.signal
    })
    setTimeout(() => ac.abort(), 800)
    try {
      await promise
      throw new Error('cancelled export resolved')
    } catch (e) {
      assert(e instanceof CancelledError, `expected CancelledError, got ${e}`)
    }
    await new Promise((r) => setTimeout(r, 500))
    assert(!existsSync(out), 'partial output not cleaned up')
  })

  // ---- merge ----
  await test('cut exact: NVENC hardware encode (skipped without NVIDIA)', async () => {
    // Probe encoder availability the same way the app does.
    const probe = await runExe(ctx.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
      '-frames:v', '8', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeoutMs: 20000 })
    if (probe.code !== 0) {
      console.log('        (skipped: NVENC not available on this machine)')
      return
    }
    const out = path.join(outDir, 'cut-nvenc.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 1, end: 5 }], mode: 'keep', engine: 'exact', quality: 'balanced', useHardware: true, outputPath: out },
      media: infoA, hwEncoder: 'nvenc'
    })
    const p = await probeLite(out)
    near(p.duration, 4, 0.1, 'nvenc cut duration')
    assert(p.vCodec === 'h264', `nvenc output codec ${p.vCodec}`)
  })

  await test('cut effects: 2x speed halves duration, audio stays in sync', async () => {
    const out = path.join(outDir, 'cut-speed.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 1, end: 5, speed: 2 }], mode: 'keep', engine: 'exact', quality: 'fast', useHardware: false, outputPath: out },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 2, 0.15, '2x-speed duration')
    assert(p.aCodec === 'aac', 'audio lost in speed export')
  })

  await test('cut effects: 0.5x slow motion doubles duration', async () => {
    const out = path.join(outDir, 'cut-slow.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 1, end: 3, speed: 0.5 }], mode: 'keep', engine: 'exact', quality: 'fast', useHardware: false, outputPath: out },
      media: infoA, hwEncoder: null
    })
    near((await probeLite(out)).duration, 4, 0.2, '0.5x duration')
  })

  await test('cut effects: volume + loudnorm produce valid audio', async () => {
    const out = path.join(outDir, 'cut-vol.mp4')
    await exportCut(ctx, {
      opts: { inputPath: A, ranges: [{ start: 1, end: 3, volume: 0.4 }], mode: 'keep', engine: 'exact', quality: 'fast', useHardware: false, outputPath: out, loudnorm: true },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 2, 0.15, 'volume export duration')
    assert(p.aCodec === 'aac', 'audio lost')
  })

  await test('cut effects: crop 1:1 with pan yields square output', async () => {
    const out = path.join(outDir, 'cut-crop.mp4')
    await exportCut(ctx, {
      opts: {
        inputPath: A, ranges: [{ start: 1, end: 3 }], mode: 'keep', engine: 'exact', quality: 'fast',
        useHardware: false, outputPath: out, crop: { ratio: '1:1', panX: 0.5, panY: 0, customW: 1, customH: 1 }
      },
      media: infoA, hwEncoder: null
    })
    const p = await probeLite(out)
    assert(p.width === 360 && p.height === 360, `crop produced ${p.width}x${p.height}, expected 360x360`)
  })

  await test('cut effects: arabic text watermark visibly drawn', async () => {
    const out = path.join(outDir, 'cut-wm.mp4')
    await exportCut(ctx, {
      opts: {
        inputPath: D, ranges: [{ start: 0.5, end: 3.5 }], mode: 'keep', engine: 'exact', quality: 'fast',
        useHardware: false, outputPath: out,
        watermark: { kind: 'text', text: 'لالوكِت LaluKit', position: 'br', opacity: 0.85, scale: 30 }
      },
      media: (await probeFile(ctx, D)).info, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 3, 0.15, 'watermark export duration')
    // bottom-right corner must differ from the un-watermarked source
    const src = await bottomStrip(D, 1.6)
    const wm = await bottomStrip(out, 1.1)
    assert(changedFraction(src, wm) > 0.005, 'no watermark pixels detected')
  })

  await test('cut effects: image watermark overlays', async () => {
    // Render a small solid png with ffmpeg to use as the watermark
    const wmPng = path.join(assetDir, 'wm.png')
    if (!existsSync(wmPng)) {
      await ff(['-f', 'lavfi', '-i', 'color=c=white:s=120x40:d=1', '-frames:v', '1', wmPng])
    }
    const out = path.join(outDir, 'cut-wm-img.mp4')
    await exportCut(ctx, {
      opts: {
        inputPath: D, ranges: [{ start: 0.5, end: 2.5 }], mode: 'keep', engine: 'exact', quality: 'fast',
        useHardware: false, outputPath: out,
        watermark: { kind: 'image', imagePath: wmPng, position: 'tl', opacity: 0.7, scale: 0.2 }
      },
      media: (await probeFile(ctx, D)).info, hwEncoder: null
    })
    near((await probeLite(out)).duration, 2, 0.15, 'image watermark duration')
  })

  await test('extras: extract audio to mp3 and wav', async () => {
    const mp3 = path.join(outDir, 'audio.mp3')
    const wav = path.join(outDir, 'audio.wav')
    await extractAudio(ctx, { inputPath: A, format: 'mp3', outputPath: mp3 }, infoA)
    await extractAudio(ctx, { inputPath: A, format: 'wav', outputPath: wav }, infoA)
    const pm = await probeLite(mp3)
    const pw = await probeLite(wav)
    assert(pm.aCodec === 'mp3', `mp3 codec ${pm.aCodec}`)
    assert(pw.aCodec === 'pcm_s16le', `wav codec ${pw.aCodec}`)
    near(pm.duration, 8, 0.3, 'mp3 duration')
  })

  await test('extras: GIF export (two-pass palette)', async () => {
    const gif = path.join(outDir, 'clip.gif')
    await exportGif(ctx, { inputPath: A, start: 1, end: 3.5, fps: 15, maxWidth: 480, loop: 0, outputPath: gif }, infoA)
    const p = await probeLite(gif)
    assert(p.vCodec === 'gif', `gif codec ${p.vCodec}`)
    assert(p.width === 480, `gif width ${p.width}`)
    near(p.duration, 2.5, 0.3, 'gif duration')
  })

  await test('extras: reverse range plays backwards', async () => {
    const out = path.join(outDir, 'reversed.mp4')
    await reverseExport(ctx, { inputPath: A, start: 1, end: 4, quality: 'fast', useHardware: false, outputPath: out }, infoA, null)
    const p = await probeLite(out)
    near(p.duration, 3, 0.2, 'reverse duration')
    // testsrc2 has a burned-in frame counter: first frame of the reversed clip
    // must differ from the source's frame at t=1 (it should match t≈4).
    const srcStart = await bottomStrip(A, 1.05)
    const revStart = await bottomStrip(out, 0.05)
    const srcEnd = await bottomStrip(A, 3.9)
    assert(changedFraction(revStart, srcEnd) < changedFraction(revStart, srcStart), 'reversed start does not match source end')
  })

  await test('merge plan: identical clips -> fast concat', async () => {
    const infoC = (await probeFile(ctx, A)).info
    const plan = buildMergePlan([infoA, infoC])
    assert(plan.fastConcat, `expected fast path, reasons: ${plan.reasons.join(',')}`)
  })

  await test('merge fast: lossless concat of matching clips', async () => {
    const out = path.join(outDir, 'merge-fast.mp4')
    await exportMerge(ctx, { infos: [infoA, infoA], outputPath: out, quality: 'fast', hwEncoder: null })
    const p = await probeLite(out)
    near(p.duration, 16, 0.3, 'fast merge duration')
    assert(p.vCodec === 'h264' && p.width === 640, 'fast merge altered streams')
  })

  await test('merge normalize: mixed res/fps/rates', async () => {
    const infoB = (await probeFile(ctx, B)).info
    const plan = buildMergePlan([infoA, infoB])
    assert(!plan.fastConcat, 'mixed clips should not fast-concat')
    assert(plan.width === 1280 && plan.height === 720, `target ${plan.width}x${plan.height}`)
    const out = path.join(outDir, 'merge-norm.mp4')
    await exportMerge(ctx, { infos: [infoA, infoB], outputPath: out, quality: 'fast', hwEncoder: null })
    const p = await probeLite(out)
    near(p.duration, 13, 0.4, 'normalized merge duration')
    assert(p.width === 1280 && p.height === 720, `output ${p.width}x${p.height}`)
    near(p.fps, 30, 0.2, 'output fps')
    assert(p.audioRate === 48000, `audio rate ${p.audioRate}`)
  })

  await test('merge: silent clip gets silence injected', async () => {
    const infoD = (await probeFile(ctx, D)).info
    const out = path.join(outDir, 'merge-silent.mp4')
    await exportMerge(ctx, { infos: [infoA, infoD], outputPath: out, quality: 'fast', hwEncoder: null })
    const p = await probeLite(out)
    assert(p.aCodec === 'aac', 'merged output lost audio')
    near(p.duration, 12, 0.4, 'merge-with-silent duration')
  })

  await test('merge container: mkv input remux probe', async () => {
    const infoC2 = (await probeFile(ctx, C)).info
    assert(infoC2.video?.codec === 'h264', 'mkv probe failed')
  })

  // ---- waveform & thumbs ----
  await test('waveform: peaks computed', async () => {
    const wf = await computeWaveform(ctx, A, 0, infoA.durationSec)
    assert(wf.buckets === 2048 && wf.peaks.length === 4096, 'bucket layout wrong')
    const energy = wf.peaks.reduce((s, v) => s + Math.abs(v), 0)
    assert(energy > 100, `waveform looks empty (energy ${energy.toFixed(1)})`)
  })

  await test('thumbnails: progressive seek-based extraction', async () => {
    const dir = path.join(outDir, 'thumbs')
    let partials = 0
    const files = await generateThumbs(ctx, {
      filePath: A, durationSec: infoA.durationSec, outDir: dir,
      onPartial: () => { partials++ }
    })
    const present = files.filter((f) => f && existsSync(f))
    assert(present.length >= 14, `only ${present.length} thumbnails`)
    assert(partials >= present.length, 'no progressive callbacks')
  })

  // ---- whisper ----
  let segments: SubtitleSegment[] = []
  await test('whisper: tiny model download (resumable)', async () => {
    const models = await listModels(modelsDir)
    if (!models.installed.includes('tiny')) {
      let progressed = false
      await downloadModel({ modelsDir, id: 'tiny', onProgress: (p) => { if (p && p > 0) progressed = true } })
      assert(progressed, 'no download progress reported')
    }
    const after = await listModels(modelsDir)
    assert(after.installed.includes('tiny'), 'tiny model not installed after download')
  })

  await test('whisper: transcribes SAPI speech (en, auto-detect)', async () => {
    const infoS = (await probeFile(ctx, SPEECH)).info
    let sawProgress = false
    const res = await transcribe(ctx, {
      opts: { inputPath: SPEECH, audioTrack: 0, modelId: 'tiny', language: 'auto', translate: false },
      media: infoS, modelsDir,
      onProgress: (p) => { if (p && p > 0.1) sawProgress = true }
    })
    segments = res.segments
    assert(res.segments.length >= 1, 'no segments produced')
    assert(res.language === 'en', `detected language ${res.language}`)
    const text = res.segments.map((s) => s.text).join(' ').toLowerCase()
    const hits = ['quick', 'brown', 'fox', 'lazy', 'dog', 'wizard'].filter((w) => text.includes(w))
    assert(hits.length >= 3, `transcript missed keywords (got: "${text.slice(0, 160)}")`)
    assert(sawProgress, 'no transcription progress reported')
    if (ctx.whisperCliCuda) {
      assert(res.backend === 'cuda', `expected CUDA backend, got ${res.backend}`)
    }
  })

  await test('whisper CUDA: GPU device initializes (raw stderr proof)', async () => {
    if (!ctx.whisperCliCuda) {
      console.log('        (skipped: CUDA build not bundled)')
      return
    }
    const wav = path.join(assetDir, 'speech.wav')
    let cudaLine = ''
    const res = await runExe(ctx.whisperCliCuda, ['-m', modelFilePath(modelsDir, 'tiny'), '-f', wav, '-t', '8'], {
      onStderrLine: (l) => { if (/ggml_cuda_init: found \d+ CUDA device/.test(l)) cudaLine = l.trim() }
    })
    assert(res.code === 0, `CUDA whisper exited ${res.code}`)
    assert(cudaLine !== '', 'no ggml_cuda_init device line — GPU backend did not initialize')
    console.log(`        ${cudaLine}`)
  })

  await test('hallucination classifier: reject / suspicious / ok tiers', async () => {
    const { classifySegment, triageSegments } = await import('../../src/main/engine/repetition')
    // hard rejects
    assert(classifySegment('ぃ'.repeat(40), 3) === 'reject', 'single-char loop not rejected')
    assert(classifySegment('thank you thank you thank you thank you thank you thank you', 4) === 'reject', 'word loop not rejected')
    assert(classifySegment('ははははははははははははははははははははは', 2) === 'reject', 'laugh loop not rejected')
    // disproportionate text-per-duration: ~174 chars in 1s = hard reject;
    // ~58 chars in 1s = suspicious (re-transcribed, not silently dropped)
    const longLine = '実に様々な物語がこの世界には存在していてそれぞれの登場人物が異なる運命を辿りながら生きているのだという事実を我々は知る'
    assert(classifySegment(longLine.repeat(3), 1) === 'reject', 'cps runaway not rejected')
    assert(classifySegment(longLine, 1) === 'suspicious', 'fast-but-plausible line not suspicious')
    // suspicious tier: >25% short-gram coverage / moderate cps — retried, not dropped
    assert(classifySegment('だめだめだめだめ、やめろ!', 1.5) === 'suspicious', 'borderline repeat not suspicious')
    const ok40 = classifySegment('なあ、なあ、どうするんだよこれから先のこと', 2)
    assert(ok40 === 'ok', `normal repeated-interjection line classified ${ok40}`)
    // clean text stays ok
    assert(classifySegment('修行を終えたメリオダスの挑発を受ける形で行動を開始した。', 6) === 'ok', 'real japanese flagged')
    assert(classifySegment('The quick brown fox jumps over the lazy dog.', 3) === 'ok', 'real english flagged')
    assert(classifySegment('هذا اختبار للترجمة العربية الطبيعية في التطبيق', 3) === 'ok', 'real arabic flagged')
    // triage: rejects out, triple-duplicates collapsed, suspicious reported
    const segs = [
      { id: 1, start: 0, end: 1, text: 'صوت طبيعي' },
      { id: 2, start: 1, end: 2, text: 'ご視聴ありがとうございました' },
      { id: 3, start: 2, end: 3, text: 'ご視聴ありがとうございました' },
      { id: 4, start: 3, end: 4, text: 'ご視聴ありがとうございました' },
      { id: 5, start: 4, end: 5, text: 'ぃぃぃぃぃぃぃぃぃぃぃぃぃぃぃぃ' },
      { id: 6, start: 5, end: 6, text: 'だめだめだめだめ!' },
      { id: 7, start: 6, end: 7, text: 'normal ending line' }
    ]
    const tri = triageSegments(segs)
    assert(tri.cleaned.length === 2, `expected 2 hard-cleaned, got ${tri.cleaned.length}`)
    assert(tri.suspicious.length === 1 && tri.suspicious[0].id === 6, 'suspicious tier wrong')
    assert(tri.segments.length === 5, `expected 5 kept, got ${tri.segments.length}`)
  })

  await test('whisper: tuned decode flags + VAD params reach the binary', async () => {
    const logged: string[] = []
    const logCtx: EngineCtx = { ...ctx, log: (m) => logged.push(m) }
    const infoS = (await probeFile(ctx, SPEECH)).info
    await transcribe(logCtx, {
      opts: { inputPath: SPEECH, audioTrack: 0, modelId: 'tiny', language: 'auto', translate: false, vad: true },
      media: infoS, modelsDir
    })
    const cmd = logged.find((l) => l.startsWith('whisper-cli'))
    assert(!!cmd, 'whisper invocation not logged')
    for (const flag of ['-mc 0', '-tp 0.0', '-tpi 0.2', '-et 2.4', '-lpt -1.0', '-nth 0.6', '-sns', '--vad', '-vt 0.60', '-vspd 250', '-vp 200', '-ml 1', '-sow', '-wt 0.01']) {
      assert(cmd!.includes(flag), `flag "${flag}" missing from whisper command line`)
    }
    assert(/silero-v6/.test(cmd!), 'v6 VAD model not in use')
  })

  await test('precise timing: word grouping rules (gap / length / no overlap)', async () => {
    const { buildLinesFromWords, tightenToSpeech, snapSegmentsToSpeech } = await import('../../src/main/engine/timing')
    const w = (start: number, end: number, text: string) => ({ start, end, text })
    // 800ms gap forces a split; lead-in/trail-out applied; never overlapping.
    const lines = buildLinesFromWords([
      w(1.0, 1.3, ' Hello'), w(1.32, 1.6, ' there'),
      w(2.5, 2.8, ' second'), w(2.82, 3.1, ' line')
    ])
    assert(lines.length === 2, `gap split produced ${lines.length} lines`)
    near(lines[0].start, 0.97, 0.011, 'lead-in')
    near(lines[0].end, 1.68, 0.011, 'trail-out')
    assert(lines[0].end < lines[1].start, 'lines overlap')
    assert(lines[0].text === 'Hello there', `text join: "${lines[0].text}"`)
    // 42-char width split
    const many = Array.from({ length: 20 }, (_, i) => w(i * 0.3, i * 0.3 + 0.25, ` word${i}`))
    const wide = buildLinesFromWords(many)
    assert(wide.length >= 2, 'long text not split by width')
    // 6-second duration split
    const slow = buildLinesFromWords([w(0, 0.4, ' a'), w(3, 3.4, ' b'), w(6.5, 6.9, ' c')])
    assert(slow.length >= 2, 'long-duration line not split')

    // A single coarse word — whisper smears a brief utterance (a shout, or a CJK
    // phrase --split-on-word can't break) across a long musical span — must be
    // capped to the readable max, anchored at its (reliable) start, not parked
    // on screen for tens of seconds. Real case from NNTINF EP13: 26.4s.
    const smeared = buildLinesFromWords([w(188.1, 214.5, ' バンデッドバン!')])
    assert(smeared.length === 1, `single coarse word should stay one line (${smeared.length})`)
    near(smeared[0].start, 188.07, 0.02, 'coarse word start should be preserved')
    assert(smeared[0].end - smeared[0].start <= 6.01, `coarse word not capped (${(smeared[0].end - smeared[0].start).toFixed(2)}s)`)

    // tighten: snap trailing stretch back to speech end; split across silence
    const regions = [{ start: 0.9, end: 1.7 }, { start: 3.0, end: 4.0 }]
    const loose = buildLinesFromWords([w(1.0, 1.3, ' aa'), w(1.32, 2.6, ' bb')])
    const tight = tightenToSpeech(loose, regions)
    assert(tight[0].end <= 1.77, `end not snapped to speech (${tight[0].end})`)
    const spanning = [{ start: 1.0, end: 3.8, text: 'aa bb', words: [w(1.0, 1.6, ' aa'), w(3.1, 3.8, ' bb')] }]
    const split = tightenToSpeech(spanning, regions)
    assert(split.length === 2, `silence-spanning line not split (${split.length})`)
    assert(split[0].text === 'aa' && split[1].text === 'bb', `split texts wrong: ${split.map((l) => l.text).join('|')}`)
    assert(split[1].start >= 2.9, 'second half not snapped to next region')

    // "Tighten to speech" button path: existing segments (no word data) snap to
    // the speech regions and the count is preserved 1:1 (translation/edits keep
    // their alignment after the user tightens).
    const snapped = snapSegmentsToSpeech(
      [{ id: 1, start: 0.8, end: 2.4, text: 'aa' }, { id: 2, start: 2.7, end: 4.6, text: 'bb' }],
      regions
    )
    assert(snapped.length === 2, `snap must preserve count 1:1 (${snapped.length})`)
    assert(snapped[0].id === 1 && snapped[1].id === 2, 'snap must preserve ids')
    assert(snapped[0].end <= 1.77, `snap should pull the trailing stretch to speech (${snapped[0].end})`)
    assert(snapped[1].start >= 2.9 && snapped[1].end <= 4.07, 'snap should clamp the second line to its region')
  })

  await test('precise timing: real audio boundaries hug the speech', async () => {
    const SILSPEECH = path.join(assetDir, 'silence-speech.mp4')
    const infoSS = (await probeFile(ctx, SILSPEECH)).info
    const res = await transcribe(ctx, {
      opts: { inputPath: SILSPEECH, audioTrack: 0, modelId: 'tiny', language: 'auto', translate: false, vad: true, preciseTiming: true },
      media: infoSS, modelsDir
    })
    const first = res.segments[0]
    const last = res.segments[res.segments.length - 1]
    // Speech physically starts at 4.0s and ends ≈11s (then 3s of silence).
    assert(first.start >= 3.85, `first line starts ${first.start.toFixed(2)}s — leading silence not trimmed`)
    assert(last.end <= infoSS.durationSec - 2.0, `last line ends ${last.end.toFixed(2)}s — trailing silence not trimmed`)
    for (const s of res.segments) {
      assert(s.end - s.start <= 6.3, `line longer than 6s cap (${(s.end - s.start).toFixed(1)}s)`)
    }
    for (let i = 1; i < res.segments.length; i++) {
      assert(res.segments[i].start >= res.segments[i - 1].end, 'precise lines overlap')
    }
    const text = res.segments.map((s) => s.text).join(' ').toLowerCase()
    assert(['quick', 'fox', 'wizard'].filter((k) => text.includes(k)).length >= 2, `text lost in regrouping: "${text.slice(0, 100)}"`)
  })

  await test('whisper VAD: silence produces gaps, speech timestamps preserved', async () => {
    // 4s silence + speech + 3s silence
    const SILSPEECH = path.join(assetDir, 'silence-speech.mp4')
    if (!existsSync(SILSPEECH)) {
      await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60',
        '-f', 'lavfi', '-t', '4', '-i', 'anullsrc=channel_layout=mono:sample_rate=22050',
        '-i', path.join(assetDir, 'speech.wav'),
        '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=channel_layout=mono:sample_rate=22050',
        '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]',
        '-map', '0:v:0', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', SILSPEECH])
    }
    const infoSS = (await probeFile(ctx, SILSPEECH)).info
    assert(ctx.vadModel !== null, 'VAD model missing — run npm run setup:bins')
    const res = await transcribe(ctx, {
      opts: { inputPath: SILSPEECH, audioTrack: 0, modelId: 'tiny', language: 'auto', translate: false, vad: true },
      media: infoSS, modelsDir
    })
    assert(res.vadUsed, 'VAD was not engaged')
    assert(res.segments.length >= 1, 'no segments with VAD')
    const first = res.segments[0]
    const last = res.segments[res.segments.length - 1]
    assert(first.start >= 3.0, `first segment at ${first.start.toFixed(2)}s — silence not skipped`)
    assert(last.end <= infoSS.durationSec - 1.5, `last segment ends ${last.end.toFixed(2)}s — trailing silence not skipped`)
    const text = res.segments.map((s) => s.text).join(' ').toLowerCase()
    const hits = ['quick', 'brown', 'fox', 'lazy', 'dog', 'wizard'].filter((w) => text.includes(w))
    assert(hits.length >= 3, `speech lost under VAD (got "${text.slice(0, 120)}")`)
  })

  await test('whisper: no-audio file raises friendly error', async () => {
    const infoD = (await probeFile(ctx, D)).info
    try {
      await transcribe(ctx, {
        opts: { inputPath: D, audioTrack: 0, modelId: 'tiny', language: 'auto', translate: false },
        media: infoD, modelsDir
      })
      throw new Error('transcribe accepted silent file')
    } catch (e) {
      assert(e instanceof EngineError && e.friendly.code === 'no-audio', `unexpected: ${e}`)
    }
  })

  await test('whisper: missing model raises friendly error', async () => {
    const infoS = (await probeFile(ctx, SPEECH)).info
    try {
      await transcribe(ctx, {
        opts: { inputPath: SPEECH, audioTrack: 0, modelId: 'medium', language: 'auto', translate: false },
        media: infoS, modelsDir
      })
      throw new Error('transcribe ran without its model')
    } catch (e) {
      assert(e instanceof EngineError && e.friendly.code === 'model-missing', `unexpected: ${e}`)
    }
  })

  // ---- subtitles ----
  // Bundled font family — exercises the fontsdir path end to end.
  const style: SubtitleStyle = {
    fontFamily: 'Noto Sans Arabic', fontSize: 52, bold: true, color: '#ffffff',
    outlineColor: '#000000', outlineWidth: 2, background: false, position: 'bottom', marginV: 40
  }
  const arabicSegments: SubtitleSegment[] = [
    { id: 1, start: 0.5, end: 3.5, text: 'هذا اختبار للترجمة العربية' },
    { id: 2, start: 4.0, end: 7.0, text: 'Second line in English' }
  ]

  await test('srt/vtt: builders produce valid files', async () => {
    const srtPath = path.join(outDir, 'subs.srt')
    const vttPath = path.join(outDir, 'subs.vtt')
    await writeSubtitleFile(arabicSegments, 'srt', srtPath)
    await writeSubtitleFile(arabicSegments, 'vtt', vttPath)
    const srt = await readFile(srtPath, 'utf8')
    const vtt = await readFile(vttPath, 'utf8')
    assert(srt.charCodeAt(0) === 0xfeff, 'SRT missing BOM')
    assert(srt.includes('1\r\n00:00:00,500 --> 00:00:03,500'), 'SRT cue malformed')
    assert(srt.includes('هذا اختبار'), 'SRT lost arabic text')
    assert(vtt.startsWith('WEBVTT\n\n'), 'VTT header malformed')
    assert(vtt.includes('00:00:00.500 --> 00:00:03.500'), 'VTT cue malformed')
    try {
      await writeSubtitleFile([], 'srt', path.join(outDir, 'empty.srt'))
      throw new Error('empty subtitle export accepted')
    } catch (e) {
      assert(e instanceof EngineError && e.friendly.code === 'no-segments', `unexpected: ${e}`)
    }
  })

  await test('burn-in: subtitles visibly drawn (pixel check, arabic)', async () => {
    const out = path.join(outDir, 'burned.mp4')
    const infoD2 = (await probeFile(ctx, D)).info
    await burnIn(ctx, {
      opts: { inputPath: D, segments: arabicSegments, style, quality: 'fast', useHardware: false, outputPath: out },
      media: infoD2, hwEncoder: null
    })
    const p = await probeLite(out)
    near(p.duration, 4, 0.2, 'burned duration')
    // While a subtitle is on screen, a chunk of the bottom strip must differ
    // from the original; after it ends (3.5s), almost nothing should.
    const during = changedFraction(await bottomStrip(D, 1.5), await bottomStrip(out, 1.5))
    const afterEnd = changedFraction(await bottomStrip(D, 3.8), await bottomStrip(out, 3.8))
    assert(during > 0.01, `no visible subtitle pixels (changed ${(during * 100).toFixed(2)}%)`)
    assert(during > afterEnd * 3 + 0.005, `subtitle region not distinct (during ${(during * 100).toFixed(2)}% vs after ${(afterEnd * 100).toFixed(2)}%)`)
  })

  await test('burn-in: libass picks the BUNDLED Noto Sans Arabic file', async () => {
    assert(ctx.fontsDir !== null, 'fonts dir missing — run npm run setup:bins')
    // Raw ffmpeg run (info loglevel) so libass fontselect lines are visible.
    const workFonts = path.join(outDir, 'fontsel')
    await mkdir(path.join(workFonts, 'fonts'), { recursive: true })
    for (const f of await readdir(ctx.fontsDir!)) {
      await copyFileFs(path.join(ctx.fontsDir!, f), path.join(workFonts, 'fonts', f))
    }
    const { buildAss } = await import('../../src/main/engine/subtitles')
    await writeFile(path.join(workFonts, 's.ass'), buildAss(arabicSegments, style, 640, 360), 'utf8')
    let picked = ''
    const res = await runExe(ctx.ffmpeg, ['-hide_banner', '-v', 'debug', '-y', '-i', D, '-vf', 'ass=s.ass:fontsdir=fonts',
      '-frames:v', '5', '-f', 'null', '-'], {
      cwd: workFonts,
      onStderrLine: (l) => { if (/Loading font file '.*NotoSansArabic/i.test(l)) picked = l.trim() }
    })
    assert(res.code === 0, `fontsel run failed: ${res.stderrTail.slice(-200)}`)
    assert(picked !== '', 'libass did not load the bundled Noto Sans Arabic file')
    console.log(`        ${picked.replace(/^\[[^\]]+\] /, '').slice(0, 110)}`)
  })

  await test('attach: soft subtitle track with language tag', async () => {
    const out = path.join(outDir, 'attached.mp4')
    await attachSoft(ctx, {
      opts: { inputPath: A, segments: arabicSegments, language: 'ar', outputPath: out },
      media: infoA
    })
    const p = await probeLite(out)
    assert(p.subCodecs.length === 1 && p.subCodecs[0] === 'mov_text', `sub streams: ${p.subCodecs.join(',')}`)
    assert(p.subLangs[0] === 'ara', `language tag: ${p.subLangs[0]}`)
    near(p.duration, 8, 0.2, 'attached duration')
  })

  await test('attach: mkv output uses srt codec', async () => {
    const out = path.join(outDir, 'attached.mkv')
    await attachSoft(ctx, {
      opts: { inputPath: C, segments: arabicSegments, language: 'en', outputPath: out },
      media: (await probeFile(ctx, C)).info
    })
    const p = await probeLite(out)
    assert(p.subCodecs[0] === 'subrip' || p.subCodecs[0] === 'srt', `mkv sub codec: ${p.subCodecs[0]}`)
  })

  await test('subtitle build sanity from real transcript', async () => {
    assert(segments.length > 0, 'no transcript from earlier test')
    const srt = buildSrt(segments)
    const vtt = buildVtt(segments)
    assert(srt.split('-->').length - 1 === segments.length, 'SRT cue count mismatch')
    assert(vtt.split('-->').length - 1 === segments.length, 'VTT cue count mismatch')
  })

  // ---- translation (mock providers over real HTTP) ----
  await test('translate: Claude adapter — batching, context, retry, meaning protocol', async () => {
    const { translateAllOnline } = await import('../../src/main/engine/translate')
    const http = await import('node:http')
    let requests = 0
    let sawContext = false
    let sawSystemPrompt = false
    let injected429 = false
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        requests++
        const parsed = JSON.parse(body)
        if (!injected429) {
          injected429 = true
          res.writeHead(429, { 'retry-after': '0' })
          res.end('{"error":"rate limited"}')
          return
        }
        if (req.headers['x-api-key'] === 'bad-key') {
          res.writeHead(401)
          res.end('{"error":{"type":"authentication_error"}}')
          return
        }
        const sys: string = parsed.system ?? ''
        if (/preserve meaning/i.test(sys) && /romanization/i.test(sys)) sawSystemPrompt = true
        const user = JSON.parse(parsed.messages[0].content)
        if (user.context_before.length > 0 || user.context_after.length > 0) sawContext = true
        const items = user.segments.map((s: { id: number; text: string }) => ({ id: s.id, t: `AR«${s.text}»` }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ items }) }] }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const segs = Array.from({ length: 34 }, (_, i) => ({ id: i + 1, start: i, end: i + 1, text: `Line number ${i + 1}` }))
      let lastDetail = ''
      const res = await translateAllOnline(
        { provider: 'claude', apiKey: 'good-key', model: 'claude-sonnet-4-6', baseUrl: base },
        segs, 'ar',
        { log: () => {}, sourceLang: 'ja', onProgress: (_p, _e, d) => { if (d) lastDetail = d } }
      )
      assert(Object.keys(res.translations).length === 34, `translated ${Object.keys(res.translations).length}/34`)
      assert(res.translations[7] === 'AR«Line number 7»', 'id mapping broken')
      assert(res.failedIds.length === 0, `unexpected failures: ${res.failedIds.join(',')}`)
      assert(sawContext, 'no surrounding-segment context sent')
      assert(sawSystemPrompt, 'meaning-preserving system prompt missing')
      assert(injected429 && requests >= 4, '429 retry path not exercised')
      assert(lastDetail === '34/34', `progress detail ${lastDetail}`)
      // bad key -> friendly auth error
      try {
        await translateAllOnline({ provider: 'claude', apiKey: 'bad-key', baseUrl: base }, segs.slice(0, 2), 'ar', { log: () => {} })
        throw new Error('bad key accepted')
      } catch (e) {
        assert((e as EngineError).friendly?.code === 'translate-auth', `auth error not mapped: ${e}`)
      }
    } finally {
      server.close()
    }
  })

  await test('translate: off-by-one id reply is NEVER applied (sync guard)', async () => {
    const { translateAllOnline } = await import('../../src/main/engine/translate')
    const http = await import('node:http')
    let mode: 'always-shifted' | 'fixed-on-retry' = 'always-shifted'
    let calls = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        calls++
        const parsed = JSON.parse(body)
        const user = JSON.parse(parsed.messages[0].content)
        const shift = mode === 'always-shifted' || calls === 1 ? -1 : 0
        const items = user.segments.map((s: { id: number; text: string }) => ({ id: s.id + shift, t: `AR«${s.text}»` }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ items }) }] }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const segs = Array.from({ length: 5 }, (_, i) => ({ id: i + 10, start: i, end: i + 1, text: `Line ${i + 10}` }))
    try {
      // persistent off-by-one -> the whole batch must FAIL, nothing applied
      try {
        await translateAllOnline({ provider: 'claude', apiKey: 'k', baseUrl: base }, segs, 'ar', { log: () => {} })
        throw new Error('misaligned batch was accepted')
      } catch (e) {
        const msg = (e as Error).message
        assert(/No segments could be translated|id contract/i.test(msg), `unexpected error: ${msg}`)
      }
      assert(calls === 2, `expected exactly 1 corrective retry (got ${calls} calls)`)
      // one bad reply then a correct one -> retry succeeds with exact mapping
      mode = 'fixed-on-retry'
      calls = 0
      const ok = await translateAllOnline({ provider: 'claude', apiKey: 'k', baseUrl: base }, segs, 'ar', { log: () => {} })
      assert(calls === 2, `retry path made ${calls} calls`)
      assert(ok.failedIds.length === 0, 'retry path left failures')
      assert(ok.translations[12] === 'AR«Line 12»', 'retry path mapping wrong')
      // ids returned as numeric strings are coerced, not dropped
      const server2 = http.createServer((req2, res2) => {
        let b = ''
        req2.on('data', (c) => { b += c })
        req2.on('end', () => {
          const u = JSON.parse(JSON.parse(b).messages[0].content)
          const items = u.segments.map((s: { id: number; text: string }) => ({ id: String(s.id), t: `S«${s.text}»` }))
          res2.writeHead(200, { 'content-type': 'application/json' })
          res2.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ items }) }] }))
        })
      })
      await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r))
      const base2 = `http://127.0.0.1:${(server2.address() as { port: number }).port}`
      try {
        const coerced = await translateAllOnline({ provider: 'claude', apiKey: 'k', baseUrl: base2 }, segs, 'ar', { log: () => {} })
        assert(coerced.translations[10] === 'S«Line 10»', 'string ids not coerced')
      } finally {
        server2.close()
      }
    } finally {
      server.close()
    }
  })

  await test('translate: bilingual burn — Arabic appears exactly in speech windows', async () => {
    const { composeSegments } = await import('../../src/renderer/src/lib/subs-compose')
    // Synthetic translated transcript on the silent 4s testD clip:
    // one segment at [0.8, 1.8]; gap until a second at [2.6, 3.4].
    const segs = [
      { id: 1, start: 0.8, end: 1.8, text: 'first line', translation: 'السطر الأول من الترجمة' },
      { id: 2, start: 2.6, end: 3.4, text: 'second line', translation: 'السطر الثاني من الترجمة' }
    ]
    const both = composeSegments(segs, 'both')
    assert(both[0].start === segs[0].start && both[0].end === segs[0].end, 'compose changed timestamps')
    assert(both[0].text.startsWith('السطر الأول') && both[0].text.includes('first line'), 'compose order wrong')
    const out = path.join(outDir, 'burned-bilingual.mp4')
    await burnIn(ctx, {
      opts: { inputPath: D, segments: both, style, quality: 'fast', useHardware: false, outputPath: out },
      media: (await probeFile(ctx, D)).info, hwEncoder: null
    })
    // Pixels present mid-segment, absent mid-gap — i.e. timing preserved.
    const inSeg = changedFraction(await bottomStrip(D, 1.3), await bottomStrip(out, 1.3))
    const inGap = changedFraction(await bottomStrip(D, 2.2), await bottomStrip(out, 2.2))
    const inSeg2 = changedFraction(await bottomStrip(D, 3.0), await bottomStrip(out, 3.0))
    assert(inSeg > 0.01, `no subtitle pixels during segment 1 (${(inSeg * 100).toFixed(2)}%)`)
    assert(inSeg2 > 0.01, `no subtitle pixels during segment 2 (${(inSeg2 * 100).toFixed(2)}%)`)
    assert(inGap < inSeg / 4 && inGap < 0.01, `subtitle pixels leaked into the gap (${(inGap * 100).toFixed(2)}%)`)
  })

  await test('translate: OpenAI / DeepL / Google adapters', async () => {
    const { translateAllOnline } = await import('../../src/main/engine/translate')
    const http = await import('node:http')
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url?.includes('/chat/completions')) {
          const user = JSON.parse(parsed.messages[1].content)
          const items = user.segments.map((s: { id: number; text: string }) => ({ id: s.id, t: `AI:${s.text}` }))
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }))
        } else if (req.url?.includes('/v2/translate')) {
          assert(parsed.target_lang === 'AR', `deepl target ${parsed.target_lang}`)
          res.end(JSON.stringify({ translations: parsed.text.map((t: string) => ({ text: `DL:${t}` })) }))
        } else {
          res.end(JSON.stringify({ data: { translations: parsed.q.map((t: string) => ({ translatedText: `GG:${t}` })) } }))
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const segs = [
        { id: 1, start: 0, end: 1, text: 'Hello there' },
        { id: 2, start: 1, end: 2, text: 'General Kenobi' }
      ]
      const oa = await translateAllOnline({ provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini', baseUrl: base }, segs, 'ar', { log: () => {} })
      assert(oa.translations[2] === 'AI:General Kenobi', 'openai mapping broken')
      const dl = await translateAllOnline({ provider: 'deepl', apiKey: 'k:fx', baseUrl: base }, segs, 'ar', { log: () => {} })
      assert(dl.translations[1] === 'DL:Hello there', 'deepl mapping broken')
      const gg = await translateAllOnline({ provider: 'google', apiKey: 'k', baseUrl: base }, segs, 'ar', { log: () => {} })
      assert(gg.translations[2] === 'GG:General Kenobi', 'google mapping broken')
    } finally {
      server.close()
    }
  })

  await test('translate: NLLB offline ja→ar (set LALU_E2E_NLLB=1; ~600MB first run)', async () => {
    if (process.env.LALU_E2E_NLLB !== '1') {
      console.log('        (skipped: set LALU_E2E_NLLB=1 to run the offline model)')
      return
    }
    // nllb.ts imports electron for paths; reimplement the thin wrapper here.
    const tf = await import('@huggingface/transformers')
    tf.env.cacheDir = path.join(work, 'nllb-cache')
    const pipe = await tf.pipeline('translation', 'Xenova/nllb-200-distilled-600M', { dtype: 'q8' })
    const out = await (pipe as never as (t: string, o: object) => Promise<{ translation_text: string }[]>)(
      'あ、おさらばだ。なあ、なあ、どうする?', { src_lang: 'jpn_Jpan', tgt_lang: 'arb_Arab' }
    )
    const ar = out[0].translation_text
    console.log(`        ja→ar: ${ar}`)
    assert(/[؀-ۿ]/.test(ar), 'output is not Arabic script')
    assert(!/[a-zA-Z]{6,}/.test(ar), 'output looks romanized')
  })

  // ---- summary ----
  const tmpLeft = await readdir(ctx.tempDir).catch(() => [])
  if (tmpLeft.length > 0) console.log(`\n  note: ${tmpLeft.length} temp dirs left behind (cancel test timing) — cleaned now`)
  await rm(ctx.tempDir, { recursive: true, force: true }).catch(() => {})

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.error('\nFailures:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('e2e harness crashed:', e)
  process.exit(1)
})
