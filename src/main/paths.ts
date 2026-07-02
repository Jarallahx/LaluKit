import { app } from 'electron'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import log from './logger'
import type { EngineCtx } from './engine/util'

// Resolves the bundled binaries: <resources>/bin in production,
// <project>/resources/bin in development.
export function binRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin')
}

export function ffmpegPath(): string {
  return path.join(binRoot(), 'ffmpeg.exe')
}

export function ffprobePath(): string {
  return path.join(binRoot(), 'ffprobe.exe')
}

export function whisperCliPath(): string {
  return path.join(binRoot(), 'whisper', 'whisper-cli.exe')
}

export function whisperCudaCliPath(): string {
  return path.join(binRoot(), 'whisper-cuda', 'whisper-cli.exe')
}

export function fontsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(app.getAppPath(), 'resources', 'fonts')
}

export function binsOk(): boolean {
  return existsSync(ffmpegPath()) && existsSync(ffprobePath()) && existsSync(whisperCliPath())
}

export function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function cacheDir(sub?: string): string {
  const dir = sub
    ? path.join(app.getPath('userData'), 'cache', sub)
    : path.join(app.getPath('userData'), 'cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function tempDir(): string {
  const dir = path.join(app.getPath('temp'), 'lalukit')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function vadModelPath(): string {
  // Prefer the latest bundled silero; tolerate an older cache.
  for (const name of ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin']) {
    const p = path.join(binRoot(), 'whisper', name)
    if (existsSync(p)) return p
  }
  return path.join(binRoot(), 'whisper', 'ggml-silero-v6.2.0.bin')
}

export function engineCtx(): EngineCtx {
  return {
    ffmpeg: ffmpegPath(),
    ffprobe: ffprobePath(),
    whisperCli: whisperCliPath(),
    whisperCliCuda: existsSync(whisperCudaCliPath()) ? whisperCudaCliPath() : null,
    vadModel: existsSync(vadModelPath()) ? vadModelPath() : null,
    fontsDir: existsSync(fontsDir()) ? fontsDir() : null,
    tempDir: tempDir(),
    log: (m) => log.info(`[engine] ${m}`)
  }
}
