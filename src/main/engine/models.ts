import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { stat, rename, unlink, readdir, mkdir } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CancelledError, err } from './errors'
import type { ProgressFn } from './util'
import type { ModelsState, WhisperModel } from '@shared/types'

export const MODEL_CATALOG: WhisperModel[] = [
  { id: 'tiny', label: 'Tiny', sizeMB: 78, ramGB: 0.5, speed: 5, quality: 1, multilingual: true },
  { id: 'tiny.en', label: 'Tiny (English-only)', sizeMB: 78, ramGB: 0.5, speed: 5, quality: 1, multilingual: false },
  { id: 'base', label: 'Base', sizeMB: 148, ramGB: 0.7, speed: 4, quality: 2, multilingual: true },
  { id: 'base.en', label: 'Base (English-only)', sizeMB: 148, ramGB: 0.7, speed: 4, quality: 2, multilingual: false },
  { id: 'small', label: 'Small', sizeMB: 488, ramGB: 1.2, speed: 3, quality: 3, multilingual: true, recommended: true },
  { id: 'small.en', label: 'Small (English-only)', sizeMB: 488, ramGB: 1.2, speed: 3, quality: 3, multilingual: false },
  { id: 'medium', label: 'Medium', sizeMB: 1530, ramGB: 2.8, speed: 2, quality: 4, multilingual: true },
  { id: 'medium.en', label: 'Medium (English-only)', sizeMB: 1530, ramGB: 2.8, speed: 2, quality: 4, multilingual: false },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', sizeMB: 1620, ramGB: 3.0, speed: 3, quality: 5, multilingual: true, recommended: true },
  { id: 'large-v3', label: 'Large v3', sizeMB: 3095, ramGB: 4.7, speed: 1, quality: 5, multilingual: true }
]

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export function modelFilePath(modelsDir: string, id: string): string {
  return path.join(modelsDir, `ggml-${id}.bin`)
}

export function catalogEntry(id: string): WhisperModel {
  const m = MODEL_CATALOG.find((m) => m.id === id)
  if (!m) throw err('model-unknown', `Unknown model "${id}".`)
  return m
}

export async function listModels(modelsDir: string): Promise<ModelsState> {
  let installed: string[] = []
  try {
    const files = await readdir(modelsDir)
    installed = MODEL_CATALOG
      .filter((m) => files.includes(`ggml-${m.id}.bin`))
      .map((m) => m.id)
  } catch { /* models dir not created yet */ }
  return { catalog: MODEL_CATALOG, installed }
}

export async function deleteModel(modelsDir: string, id: string): Promise<void> {
  await unlink(modelFilePath(modelsDir, id)).catch(() => {})
}

export interface DownloadModelRequest {
  modelsDir: string
  id: string
  signal?: AbortSignal
  onProgress?: ProgressFn
}

// Streams the model from Hugging Face with HTTP-Range resume: an interrupted
// download keeps its .part file and continues where it stopped.
export async function downloadModel(req: DownloadModelRequest): Promise<string> {
  const model = catalogEntry(req.id)
  await mkdir(req.modelsDir, { recursive: true })
  const finalPath = modelFilePath(req.modelsDir, req.id)
  const partPath = finalPath + '.part'
  const url = `${BASE_URL}/ggml-${req.id}.bin`

  const existing = await stat(partPath).catch(() => null)
  let offset = existing?.size ?? 0

  const headers: Record<string, string> = { 'User-Agent': 'LaluKit/1.0' }
  if (offset > 0) headers.Range = `bytes=${offset}-`

  let res: Response
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: req.signal })
  } catch (e) {
    if (req.signal?.aborted) throw new CancelledError()
    throw err('download-failed', 'The model download could not start.', 'Check your internet connection and try again — the download resumes where it stopped.')
  }
  if (res.status === 416) {
    // Stale .part larger than the file; start over.
    await unlink(partPath).catch(() => {})
    offset = 0
    res = await fetch(url, { headers: { 'User-Agent': 'LaluKit/1.0' }, redirect: 'follow', signal: req.signal })
  }
  if (offset > 0 && res.status === 200) {
    // Server ignored the Range header; restart from scratch.
    await unlink(partPath).catch(() => {})
    offset = 0
  }
  if (!res.ok || !res.body) {
    throw err('download-failed', `The model server replied with HTTP ${res.status}.`, 'Try again in a moment.')
  }

  const remaining = Number(res.headers.get('content-length') || 0)
  const total = remaining > 0 ? offset + remaining : model.sizeMB * 1024 * 1024
  let got = offset
  let lastT = Date.now()
  let lastGot = got
  let speed = 0 // bytes/sec, exponentially smoothed

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length
      const now = Date.now()
      if (now - lastT >= 500) {
        const inst = ((got - lastGot) / (now - lastT)) * 1000
        speed = speed === 0 ? inst : speed * 0.7 + inst * 0.3
        lastT = now
        lastGot = got
        const eta = speed > 1 ? (total - got) / speed : null
        req.onProgress?.(Math.min(got / total, 0.999), eta, `${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`)
      }
      cb(null, chunk)
    }
  })

  try {
    await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' }))
  } catch (e) {
    if (req.signal?.aborted) throw new CancelledError()
    const ee = e as NodeJS.ErrnoException
    if (ee.code === 'ENOSPC') {
      throw err('disk-full', 'Not enough disk space to download this model.', `It needs about ${model.sizeMB} MB.`)
    }
    throw err('download-failed', 'The model download was interrupted.', 'Check your connection and try again — it resumes where it stopped.')
  }

  const final = await stat(partPath).catch(() => null)
  if (!final || final.size < model.sizeMB * 1024 * 1024 * 0.85) {
    throw err('download-failed', 'The downloaded model file looks incomplete.', 'Try the download again.')
  }
  await rename(partPath, finalPath)
  req.onProgress?.(1, 0, null)
  return finalPath
}
