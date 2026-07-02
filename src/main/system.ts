import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statfs, rm } from 'node:fs/promises'
import log from './logger'
import { runExe } from './engine/run'
import { dirSizeBytes } from './engine/util'
import { ffmpegPath } from './paths'
import type { HwEncoder } from './engine/encode'

const execFileP = promisify(execFile)

let fontsCache: string[] | null = null

const FALLBACK_FONTS = ['Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia', 'Impact']

export async function listSystemFonts(): Promise<string[]> {
  if (fontsCache) return fontsCache
  try {
    const { stdout } = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Drawing; ([System.Drawing.Text.InstalledFontCollection]::new()).Families | ForEach-Object { $_.Name }'],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
    )
    const fonts = stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
    fontsCache = fonts.length > 0 ? fonts : FALLBACK_FONTS
  } catch (e) {
    log.warn('font enumeration failed, using fallback list', e)
    fontsCache = FALLBACK_FONTS
  }
  return fontsCache
}

let hwCache: HwEncoder[] | null = null

// Each candidate encoder gets a 8-frame smoke encode; only ones that actually
// initialize on this machine are offered in the UI.
export async function detectHwEncoders(): Promise<HwEncoder[]> {
  if (hwCache) return hwCache
  const candidates: { id: HwEncoder; codec: string }[] = [
    { id: 'nvenc', codec: 'h264_nvenc' },
    { id: 'qsv', codec: 'h264_qsv' },
    { id: 'amf', codec: 'h264_amf' }
  ]
  const found: HwEncoder[] = []
  await Promise.all(
    candidates.map(async (c) => {
      try {
        const res = await runExe(
          ffmpegPath(),
          ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
            '-frames:v', '8', '-c:v', c.codec, '-f', 'null', '-'],
          { timeoutMs: 20000 }
        )
        if (res.code === 0) found.push(c.id)
      } catch { /* encoder not usable */ }
    })
  )
  // Stable preference order: nvenc > qsv > amf.
  hwCache = (['nvenc', 'qsv', 'amf'] as HwEncoder[]).filter((e) => found.includes(e))
  log.info(`hardware encoders detected: ${hwCache.join(', ') || 'none'}`)
  return hwCache
}

export function pickHwEncoder(useHardware: boolean): HwEncoder | null {
  if (!useHardware || !hwCache || hwCache.length === 0) return null
  return hwCache[0]
}

export async function freeDiskBytes(dir: string): Promise<number> {
  try {
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return Number.MAX_SAFE_INTEGER // unknown -> don't block the user
  }
}

export async function cacheSize(cacheRoot: string): Promise<number> {
  return dirSizeBytes(cacheRoot)
}

export async function clearCache(cacheRoot: string): Promise<void> {
  await rm(cacheRoot, { recursive: true, force: true }).catch(() => {})
}
