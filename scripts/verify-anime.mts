// Real-world hallucination verification against the user's Japanese anime
// episode: transcribe an 8-minute slice (includes the musical OP — the
// hallucination trigger) with the same large-v3-turbo model the bug was
// reported on, with VAD off vs on, and count repetition loops.
//
//   npx tsx scripts/verify-anime.mts [path-to-video]

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeFile } from '../src/main/engine/probe'
import { transcribe } from '../src/main/engine/whisper'
import { isHallucinatedRepetition, repetitionScore } from '../src/main/engine/repetition'
import { buildSrt } from '../src/main/engine/subtitles'
import type { EngineCtx } from '../src/main/engine/util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binDir = path.join(root, 'resources', 'bin')
const work = path.join(root, 'scripts', 'e2e', '.work', 'anime')
const cudaCli = path.join(binDir, 'whisper-cuda', 'whisper-cli.exe')

const ctx: EngineCtx = {
  ffmpeg: path.join(binDir, 'ffmpeg.exe'),
  ffprobe: path.join(binDir, 'ffprobe.exe'),
  whisperCli: path.join(binDir, 'whisper', 'whisper-cli.exe'),
  whisperCliCuda: existsSync(cudaCli) ? cudaCli : null,
  vadModel: ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin']
    .map((n) => path.join(binDir, 'whisper', n))
    .find((p) => existsSync(p)) ?? null,
  fontsDir: null,
  tempDir: path.join(work, 'tmp'),
  log: () => {}
}

const DEFAULT_SOURCE = 'D:\\jarallah1\\VIDEO SSD\\Anime\\S\\[Anime4up.com] NNTINF EP 13 HD.mp4'
const modelsDir = path.join(process.env.APPDATA ?? '', 'lalukit', 'models')

async function main(): Promise<void> {
  const source = process.argv[2] ?? DEFAULT_SOURCE
  const full = process.argv.includes('--full')
  if (!existsSync(source)) {
    console.error(`source video not found: ${source}`)
    process.exit(2)
  }
  if (!existsSync(path.join(modelsDir, 'ggml-large-v3-turbo.bin'))) {
    console.error('large-v3-turbo model not installed in the app models dir')
    process.exit(2)
  }
  await mkdir(ctx.tempDir, { recursive: true })

  const tag = path.basename(source).replace(/[^a-z0-9]+/gi, '').slice(0, 16)
  const slice = path.join(work, full ? `full-${tag}.mp4` : `slice-${tag}.mp4`)
  if (!existsSync(slice)) {
    console.log(`extracting ${full ? 'FULL episode audio' : '8-minute slice'} (stream copy)…`)
    const args = ['-hide_banner', '-v', 'error', '-y', '-ss', '0']
    if (!full) args.push('-t', '480')
    args.push('-i', source, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', slice)
    execFileSync(ctx.ffmpeg, args, { windowsHide: true })
  }
  const { info } = await probeFile(ctx, slice)
  console.log(`slice: ${info.durationSec.toFixed(0)}s, audio ${info.audioTracks[0]?.codec}\n`)

  // Stricter prospective detector: surfaces what the shipped filter misses.
  const strictFlag = (text: string, dur: number): string | null => {
    const t = [...text.replace(/\s+/g, '')]
    // Mirror the shipped classifier's guard: short bursts ("うわあああ")
    // are real screams/interjections, not hallucination loops.
    if (t.length < 8) return null
    for (let n = 1; n <= 3; n++) {
      if (t.length < n * 3) break
      let covered = 0
      let i = 0
      while (i + n <= t.length) {
        const gram = t.slice(i, i + n).join('')
        let j = i + n
        let run = 1
        while (j + n <= t.length && t.slice(j, j + n).join('') === gram) { run++; j += n }
        if (run >= 3) { covered += run * n; i = j } else i++
      }
      if (covered / t.length > 0.25) return `ngram${n}=${(covered / t.length * 100).toFixed(0)}%`
    }
    const cps = t.length / Math.max(0.1, dur)
    if (cps > 25 && t.length > 30) return `cps=${cps.toFixed(0)}`
    return null
  }

  const run = async (vad: boolean): Promise<{ n: number; cleaned: number; survivors: { s: number; e: number; why: string; text: string }[] }> => {
    const started = Date.now()
    const res = await transcribe(ctx, {
      opts: { inputPath: slice, audioTrack: 0, modelId: 'large-v3-turbo', language: 'auto', translate: false, vad },
      media: info,
      modelsDir
    })
    const survivors = res.segments
      .map((s) => ({ s: s.start, e: s.end, why: strictFlag(s.text, s.end - s.start) ?? (isHallucinatedRepetition(s.text) ? 'shipped-40%' : ''), text: s.text }))
      .filter((x) => x.why !== '')
    console.log(`VAD=${vad ? 'ON ' : 'OFF'}  ${res.segments.length} lines  auto-cleaned=${res.cleanedCount}  strict-flagged-survivors=${survivors.length}  (${((Date.now() - started) / 1000).toFixed(0)}s)`)
    for (const l of survivors.slice(0, 12)) {
      console.log(`   SURVIVOR [${l.s.toFixed(1)}–${l.e.toFixed(1)}] ${l.why}: ${l.text.slice(0, 70)}`)
    }
    if (vad) await writeFile(path.join(work, `${path.basename(slice)}.vad.srt`), buildSrt(res.segments), 'utf8')
    return { n: res.segments.length, cleaned: res.cleanedCount, survivors }
  }

  const on = await run(true)
  const off = full ? { n: 0, cleaned: 0, survivors: [] } : await run(false)

  const pass = on.survivors.length === 0 && off.survivors.length === 0
  console.log(`\nresult: ${pass ? 'PASS' : 'INVESTIGATE'} — VAD-on survivors: ${on.survivors.length}; VAD-off survivors: ${off.survivors.length}`)
  void repetitionScore
  process.exit(pass ? 0 : 1)
}

void main()
