import path from 'node:path'
import { access } from 'node:fs/promises'
import { runExe } from './run'
import { CancelledError } from './errors'
import { ensureDir, type EngineCtx } from './util'

export interface ThumbsRequest {
  filePath: string
  durationSec: number
  outDir: string
  signal?: AbortSignal
  onPartial?: (index: number, file: string) => void
}

export function thumbCount(durationSec: number): number {
  return Math.max(16, Math.min(56, Math.round(durationSec / 4)))
}

// Seek-based thumbnail extraction: one fast-seek decode per thumbnail, four at
// a time. Far quicker than a single full decode on long files, and each frame
// can be surfaced progressively.
export async function generateThumbs(ctx: EngineCtx, req: ThumbsRequest): Promise<string[]> {
  const count = thumbCount(req.durationSec)
  await ensureDir(req.outDir)
  const outputs: string[] = new Array(count)
  const indices = Array.from({ length: count }, (_, i) => i)
  const workers = 4

  const renderOne = async (i: number): Promise<void> => {
    if (req.signal?.aborted) throw new CancelledError()
    const t = Math.min(req.durationSec * ((i + 0.5) / count), Math.max(0, req.durationSec - 0.05))
    const out = path.join(req.outDir, `t${String(i).padStart(3, '0')}.jpg`)
    try {
      await access(out)
      outputs[i] = out
      req.onPartial?.(i, out)
      return
    } catch { /* not cached yet */ }
    const res = await runExe(
      ctx.ffmpeg,
      ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', req.filePath,
        '-frames:v', '1', '-vf', 'scale=110:62:force_original_aspect_ratio=increase,crop=110:62',
        '-q:v', '5', out],
      { signal: req.signal, timeoutMs: 30000 }
    )
    if (req.signal?.aborted) throw new CancelledError()
    // A failed frame (e.g. seeking past EOF on VFR files) is not fatal — the
    // timeline just shows a blank tile there.
    if (res.code === 0) {
      outputs[i] = out
      req.onPartial?.(i, out)
    } else {
      ctx.log(`thumbnail ${i} failed: ${res.stderrTail.slice(-200)}`)
    }
  }

  const queue = [...indices]
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        const i = queue.shift()
        if (i === undefined) break
        await renderOne(i)
      }
    })
  )
  if (req.signal?.aborted) throw new CancelledError()
  return outputs.map((o) => o ?? '')
}
