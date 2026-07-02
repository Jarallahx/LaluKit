import { runExe } from './run'
import { CancelledError, mapFfmpegError } from './errors'
import type { EngineCtx } from './util'
import type { WaveformData } from '@shared/types'

const SAMPLE_RATE = 4000
const BUCKETS = 2048

// Decodes one audio track to mono 16-bit PCM and folds it into min/max peak
// buckets for the timeline waveform.
export async function computeWaveform(
  ctx: EngineCtx,
  filePath: string,
  track: number,
  durationSec: number,
  signal?: AbortSignal
): Promise<WaveformData> {
  const totalSamples = Math.max(1, Math.floor(durationSec * SAMPLE_RATE))
  const samplesPerBucket = Math.max(1, totalSamples / BUCKETS)
  const mins = new Float32Array(BUCKETS).fill(0)
  const maxs = new Float32Array(BUCKETS).fill(0)
  const touched = new Uint8Array(BUCKETS)

  let sampleIndex = 0
  let carry: Buffer | null = null

  const res = await runExe(
    ctx.ffmpeg,
    ['-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-map', `0:a:${track}`,
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', '-'],
    {
      signal,
      onStdoutChunk: (chunk) => {
        let buf = carry ? Buffer.concat([carry, chunk]) : chunk
        const usable = buf.length - (buf.length % 2)
        carry = usable < buf.length ? buf.subarray(usable) : null
        for (let i = 0; i < usable; i += 2) {
          const v = buf.readInt16LE(i) / 32768
          const b = Math.min(BUCKETS - 1, Math.floor(sampleIndex / samplesPerBucket))
          if (!touched[b]) { mins[b] = v; maxs[b] = v; touched[b] = 1 }
          else { if (v < mins[b]) mins[b] = v; if (v > maxs[b]) maxs[b] = v }
          sampleIndex++
        }
      }
    }
  )
  if (signal?.aborted) throw new CancelledError()
  if (res.code !== 0) throw mapFfmpegError(res.stderrTail, res.code)

  const peaks: number[] = new Array(BUCKETS * 2)
  for (let i = 0; i < BUCKETS; i++) {
    peaks[i * 2] = Math.round(mins[i] * 1000) / 1000
    peaks[i * 2 + 1] = Math.round(maxs[i] * 1000) / 1000
  }
  return { buckets: BUCKETS, peaks }
}
