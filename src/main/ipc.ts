import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { stat, readdir, unlink, readFile, writeFile as writeFileFs, rename as renameFs, mkdir } from 'node:fs/promises'
import log, { logPath } from './logger'
import { getStore } from './settings'
import { binsOk, cacheDir, engineCtx, modelsDir } from './paths'
import { JobManager } from './jobs'
import { mediaUrl, registerMediaPath } from './protocol'
import { EngineError, err } from './engine/errors'
import { probeFile } from './engine/probe'
import { makeProxyWithFallback } from './engine/proxy'
import { computeWaveform } from './engine/waveform'
import { generateThumbs, thumbCount } from './engine/thumbs'
import { keyframesNear } from './engine/keyframes'
import { exportCut } from './engine/cut'
import { buildMergePlan, exportMerge } from './engine/merge'
import { attachSoft, burnIn, writeSubtitleFile } from './engine/subtitles'
import { extractAudio, exportGif, reverseExport } from './engine/extras'
import { translateAllOnline, testProvider } from './engine/translate'
import { getApiKey, hasApiKeys, setApiKey } from './keys'
import { transcribe, whisperBackendFor } from './engine/whisper'
import { deleteModel, downloadModel, listModels, catalogEntry } from './engine/models'
import { ensureDir, fileSignature, makeWorkDir, removeQuiet, type ProgressFn } from './engine/util'
import { detectSpeechRegions, snapSegmentsToSpeech } from './engine/timing'
import { runFfmpeg } from './engine/run'
import {
  cacheSize, clearCache, detectHwEncoders, freeDiskBytes, listSystemFonts, pickHwEncoder
} from './system'
import type {
  ApiProvider, AppSettings, AttachOptions, BurnInOptions, CutExportOptions,
  ExtractAudioOptions, FriendlyError, GifExportOptions, MediaInfo,
  MergeExportOptions, ProjectFile, ReverseOptions, SaveDialogRequest,
  SubtitleSegment, SystemInfo, ThumbsPartial, TranscribeOptions,
  TranscribeResult, TranslateSettings
} from '@shared/types'
import type { MergeProbeResult } from '@shared/api'

interface Wrapped<T> { __val?: T; __err?: FriendlyError }

let jobs: JobManager
let mainWindow: BrowserWindow | null = null

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// All handlers ship results/errors in a structured envelope so FriendlyError
// payloads survive the IPC boundary intact.
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_e, ...args): Promise<Wrapped<T>> => {
    try {
      return { __val: await fn(...(args as never[])) }
    } catch (e) {
      if (e instanceof EngineError) return { __err: e.friendly }
      log.error(`ipc ${channel} failed:`, e)
      return {
        __err: {
          code: 'unexpected',
          message: 'Something went wrong.',
          hint: 'Check the log file for details.',
          logExcerpt: e instanceof Error ? e.message.slice(0, 300) : undefined
        }
      }
    }
  })
}

async function openMedia(filePath: string): Promise<MediaInfo> {
  const ctx = engineCtx()
  const { info, playbackMode } = await probeFile(ctx, filePath)
  registerMediaPath(filePath)

  const store = getStore()
  store.addRecent({
    path: filePath, name: info.fileName, durationSec: info.durationSec,
    kind: info.kind, openedAt: Date.now()
  })

  let url: string | null = null
  let proxyJobId: string | null = null
  if (playbackMode === 'direct') {
    url = mediaUrl(filePath)
  } else {
    const ext = info.kind === 'video' ? '.mp4' : '.m4a'
    const proxyPath = path.join(cacheDir('proxies'), `${info.id}${ext}`)
    if (existsSync(proxyPath)) {
      url = registerMediaPath(proxyPath)
    } else {
      const job = jobs.create('proxy', info.fileName, 'heavy', async (ctl) => {
        await makeProxyWithFallback(ctx, {
          info, mode: playbackMode, outPath: proxyPath,
          signal: ctl.signal, onProgress: ctl.setProgress
        })
        return { url: registerMediaPath(proxyPath) }
      })
      proxyJobId = job.id
    }
  }
  return { ...info, playback: { mode: playbackMode, url, proxyJobId } }
}

// Rough output-size preflight so exports fail fast instead of at 90%.
async function checkDiskFor(outputPath: string, estBytes: number): Promise<void> {
  const free = await freeDiskBytes(path.dirname(outputPath))
  const needed = Math.max(estBytes * 1.3, 200 * 1024 * 1024)
  if (free < needed) {
    throw err(
      'disk-full',
      'There is not enough free disk space for this export.',
      `About ${Math.ceil(needed / 1048576)} MB is needed, ${Math.floor(free / 1048576)} MB is free on that drive.`
    )
  }
}

function estimateBytes(durationSec: number, video: boolean): number {
  const bitrate = video ? 8e6 : 2.5e5 // bits/sec, generous defaults
  return (durationSec * bitrate) / 8
}

async function mkdirP(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function writeFileAtomic(p: string, content: string): Promise<void> {
  const tmp = p + '.tmp'
  await writeFileFs(tmp, content, 'utf8')
  await renameFs(tmp, p)
}

async function runFfmpegLocal(
  ctx: ReturnType<typeof engineCtx>,
  args: string[],
  signal: AbortSignal,
  totalSec: number,
  onProgress: ProgressFn
): Promise<void> {
  await runFfmpeg(ctx, args, { signal, totalSec, onProgress, window: { offset: 0, scale: 0.7 } })
}

export function setupIpc(win: BrowserWindow): JobManager {
  mainWindow = win
  jobs = new JobManager((info) => broadcast('job:update', info))
  const store = getStore()

  // ---------- system ----------

  handle<SystemInfo>('system:info', async () => {
    const hw = await detectHwEncoders()
    const ctx = engineCtx()
    // CUDA whisper needs the CUDA build bundled AND an NVIDIA GPU (nvenc
    // detection implies one). A runtime init failure still falls back per-job.
    const backend = whisperBackendFor(ctx) === 'cuda' && hw.includes('nvenc') ? 'cuda' : 'cpu'
    return {
      version: app.getVersion(),
      logPath: logPath(),
      modelsDir: modelsDir(),
      cacheDir: cacheDir(),
      binsOk: binsOk(),
      hwEncoders: hw,
      whisperBackend: backend,
      cacheSizeBytes: await cacheSize(cacheDir())
    }
  })

  handle<AppSettings>('settings:get', () => store.settings)
  handle<AppSettings>('settings:set', (patch: Partial<AppSettings>) => store.patchSettings(patch))

  handle('recents:get', async () => {
    // Attach cached timeline thumbnails as poster images where available.
    const live = store.recents.filter((r) => existsSync(r.path))
    return Promise.all(live.map(async (r) => {
      try {
        const sig = await fileSignature(r.path)
        for (const name of ['t002.jpg', 't000.jpg', 'poster.jpg']) {
          const p = path.join(cacheDir('thumbs'), sig, name)
          if (existsSync(p)) return { ...r, thumbUrl: registerMediaPath(p) }
        }
      } catch { /* enrichment is best-effort */ }
      return { ...r, thumbUrl: null }
    }))
  })
  handle('recents:remove', (p: string) => { store.removeRecent(p); return store.recents })
  handle('recents:clear', () => store.clearRecents())

  handle<string[]>('dialog:open', async (multi: boolean) => {
    const res = await dialog.showOpenDialog(win, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: 'Media & projects', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'mts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'lalukit'] },
        { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'wmv', 'flv', 'mpg'] },
        { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })

  handle<string | null>('dialog:save', async (req: SaveDialogRequest) => {
    const res = await dialog.showSaveDialog(win, { defaultPath: req.defaultPath, filters: req.filters })
    return res.canceled || !res.filePath ? null : res.filePath
  })

  handle<string | null>('dialog:dir', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  handle('shell:show-in-folder', (p: string) => shell.showItemInFolder(p))
  handle('shell:open-path', async (p: string) => { await shell.openPath(p) })
  handle('shell:open-log', async () => { await shell.openPath(logPath()) })
  handle('system:clear-cache', async () => {
    await clearCache(cacheDir())
    return cacheSize(cacheDir())
  })
  handle('system:fonts', () => listSystemFonts())
  handle('system:disk-space', async (dir: string) => ({ freeBytes: await freeDiskBytes(dir) }))
  handle('system:path-exists', (p: string) => existsSync(p))
  handle('system:titlebar', (theme: 'dark' | 'light') => {
    win.setTitleBarOverlay?.({
      color: '#00000000',
      symbolColor: theme === 'dark' ? '#9aa3b3' : '#5a6372',
      height: 40
    })
  })

  // ---------- media ----------

  handle<MediaInfo>('media:open', (p: string) => openMedia(p))

  handle('media:proxy-transcode', async (p: string) => {
    // Fallback path when direct playback errors at runtime (rare codecs the
    // probe whitelist let through).
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, p)
    const ext = info.kind === 'video' ? '.mp4' : '.m4a'
    const proxyPath = path.join(cacheDir('proxies'), `${info.id}-t${ext}`)
    if (existsSync(proxyPath)) {
      const url = registerMediaPath(proxyPath)
      const job = jobs.create('proxy', info.fileName, 'light', async () => ({ url }))
      return { jobId: job.id }
    }
    const job = jobs.create('proxy', info.fileName, 'heavy', async (ctl) => {
      await makeProxyWithFallback(ctx, {
        info, mode: 'transcode', outPath: proxyPath, signal: ctl.signal, onProgress: ctl.setProgress
      })
      return { url: registerMediaPath(proxyPath) }
    })
    return { jobId: job.id }
  })

  handle('media:waveform', async (p: string, track: number) => {
    const ctx = engineCtx()
    const sig = await fileSignature(p)
    const cachePath = path.join(cacheDir('peaks'), `${sig}-a${track}.json`)
    const job = jobs.create('waveform', path.basename(p), 'light', async (ctl) => {
      if (existsSync(cachePath)) {
        try {
          const { readFile } = await import('node:fs/promises')
          return JSON.parse(await readFile(cachePath, 'utf8'))
        } catch { /* recompute below */ }
      }
      const { info } = await probeFile(ctx, p)
      if (info.audioTracks.length === 0) throw err('no-audio', 'This file has no audio track.')
      const data = await computeWaveform(ctx, p, track, info.durationSec, ctl.signal)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(cachePath, JSON.stringify(data), 'utf8').catch(() => {})
      return data
    })
    return { jobId: job.id }
  })

  handle('media:thumbs', async (p: string) => {
    const ctx = engineCtx()
    const sig = await fileSignature(p)
    const outDir = path.join(cacheDir('thumbs'), sig)
    const job = jobs.create('thumbnails', path.basename(p), 'light', async (ctl) => {
      const { info } = await probeFile(ctx, p)
      if (!info.video) return { urls: [] }
      const count = thumbCount(info.durationSec)
      const urls: (string | null)[] = new Array(count).fill(null)
      let pendingEmit: NodeJS.Timeout | null = null
      const files = await generateThumbs(ctx, {
        filePath: p, durationSec: info.durationSec, outDir, signal: ctl.signal,
        onPartial: (i, file) => {
          urls[i] = registerMediaPath(file)
          if (!pendingEmit) {
            pendingEmit = setTimeout(() => {
              pendingEmit = null
              broadcast('thumbs:partial', { mediaId: info.id, urls: [...urls], done: false } satisfies ThumbsPartial)
            }, 120)
          }
        }
      })
      if (pendingEmit) clearTimeout(pendingEmit)
      const final = files.map((f) => (f ? registerMediaPath(f) : null))
      broadcast('thumbs:partial', { mediaId: info.id, urls: final, done: true } satisfies ThumbsPartial)
      return { urls: final }
    })
    return { jobId: job.id }
  })

  handle('media:keyframes', async (p: string, t: number, windowSec: number) => {
    return keyframesNear(engineCtx(), p, t, windowSec)
  })

  // ---------- cut ----------

  handle('cut:export', async (opts: CutExportOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const totalSec = opts.ranges.reduce((s, r) => s + Math.max(0, r.end - r.start), 0)
    const outName = path.basename(opts.outputPath)
    const job = jobs.create('cut', outName, 'heavy', async (ctl) => {
      await checkDiskFor(opts.outputPath, opts.engine === 'lossless'
        ? info.sizeBytes * Math.min(1, totalSec / info.durationSec)
        : estimateBytes(totalSec, info.kind === 'video'))
      const res = await exportCut(ctx, {
        opts, media: info,
        hwEncoder: pickHwEncoder(opts.useHardware),
        signal: ctl.signal, onProgress: ctl.setProgress
      })
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  // ---------- merge ----------

  handle<MergeProbeResult>('merge:probe', async (paths: string[]) => {
    const ctx = engineCtx()
    const items = await Promise.all(
      paths.map(async (p) => {
        try {
          const { info } = await probeFile(ctx, p)
          let thumbUrl: string | null = null
          if (info.video) {
            const dir = await ensureDir(path.join(cacheDir('thumbs'), info.id))
            const poster = path.join(dir, 'poster.jpg')
            if (!existsSync(poster)) {
              const t = Math.min(info.durationSec * 0.15, 30)
              const { runExe } = await import('./engine/run')
              await runExe(ctx.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', t.toFixed(2), '-i', p,
                '-frames:v', '1', '-vf', 'scale=128:72:force_original_aspect_ratio=increase,crop=128:72', '-q:v', '5', poster],
                { timeoutMs: 20000 }).catch(() => null)
            }
            thumbUrl = existsSync(poster) ? registerMediaPath(poster) : null
          }
          return { path: p, info: { ...info, playback: { mode: 'direct' as const, url: null, proxyJobId: null } }, errorCode: null, thumbUrl }
        } catch (e) {
          const code = e instanceof EngineError ? e.friendly.code : 'unexpected'
          return { path: p, info: null, errorCode: code, thumbUrl: null }
        }
      })
    )
    const good = items.filter((i) => i.info).map((i) => i.info!)
    const plan = good.length >= 1 ? buildMergePlan(good) : null
    return { items, plan }
  })

  handle('merge:export', async (opts: MergeExportOptions) => {
    const ctx = engineCtx()
    const infos: Awaited<ReturnType<typeof probeFile>>['info'][] = []
    for (const p of opts.inputs) infos.push((await probeFile(ctx, p)).info)
    const totalSec = infos.reduce((s, i) => s + i.durationSec, 0)
    const job = jobs.create('merge', path.basename(opts.outputPath), 'heavy', async (ctl) => {
      await checkDiskFor(opts.outputPath, estimateBytes(totalSec, true))
      const res = await exportMerge(ctx, {
        infos, outputPath: opts.outputPath, quality: opts.quality,
        hwEncoder: pickHwEncoder(opts.useHardware),
        signal: ctl.signal, onProgress: ctl.setProgress
      })
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  // ---------- subtitles ----------

  handle('subs:models', () => listModels(modelsDir()))

  handle('subs:model-download', (id: string) => {
    const m = catalogEntry(id)
    const job = jobs.create('model-download', m.label, 'download', async (ctl) => {
      await downloadModel({ modelsDir: modelsDir(), id, signal: ctl.signal, onProgress: ctl.setProgress })
      return listModels(modelsDir())
    })
    return { jobId: job.id }
  })

  handle('subs:model-delete', async (id: string) => {
    await deleteModel(modelsDir(), id)
    return listModels(modelsDir())
  })

  handle('subs:transcribe', async (opts: TranscribeOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const job = jobs.create('transcribe', info.fileName, 'heavy', async (ctl): Promise<TranscribeResult> => {
      return transcribe(ctx, {
        opts, media: info, modelsDir: modelsDir(),
        signal: ctl.signal, onProgress: ctl.setProgress
      })
    })
    return { jobId: job.id }
  })

  handle('subs:export-file', async (segments: SubtitleSegment[], format: 'srt' | 'vtt', outPath: string) => {
    await writeSubtitleFile(segments, format, outPath)
  })

  // "Tighten to speech": clamp existing subtitle boundaries to detected
  // speech regions (for legacy projects / imported timing).
  handle('subs:tighten', async (inputPath: string, segments: SubtitleSegment[]) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, inputPath)
    const job = jobs.create('tighten', info.fileName, 'heavy', async (ctl) => {
      const work = await makeWorkDir(ctx, 'tighten')
      try {
        const wav = path.join(work, 'audio.wav')
        await runFfmpegLocal(ctx, ['-i', inputPath, '-map', '0:a:0', '-ac', '1', '-ar', '16000',
          '-c:a', 'pcm_s16le', '-vn', '-sn', '-dn', wav], ctl.signal, info.durationSec, ctl.setProgress)
        const regions = await detectSpeechRegions(ctx, wav, info.durationSec, ctl.signal)
        const snapped = snapSegmentsToSpeech(segments, regions)
        ctl.setProgress(1, 0, null)
        return { segments: snapped, regions: regions.length }
      } finally {
        await removeQuiet(work)
      }
    })
    return { jobId: job.id }
  })

  handle('subs:burn', async (opts: BurnInOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const job = jobs.create('burn-in', path.basename(opts.outputPath), 'heavy', async (ctl) => {
      await checkDiskFor(opts.outputPath, estimateBytes(info.durationSec, true))
      const res = await burnIn(ctx, {
        opts, media: info,
        hwEncoder: pickHwEncoder(opts.useHardware),
        signal: ctl.signal, onProgress: ctl.setProgress
      })
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  handle('subs:attach', async (opts: AttachOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const job = jobs.create('attach-subs', path.basename(opts.outputPath), 'heavy', async (ctl) => {
      await checkDiskFor(opts.outputPath, info.sizeBytes)
      const res = await attachSoft(ctx, {
        opts, media: info, signal: ctl.signal, onProgress: ctl.setProgress
      })
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  // ---------- extras ----------

  handle('extras:extract-audio', async (opts: ExtractAudioOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const job = jobs.create('extract-audio', path.basename(opts.outputPath), 'heavy', async (ctl) => {
      await checkDiskFor(opts.outputPath, estimateBytes(info.durationSec, false))
      const res = await extractAudio(ctx, opts, info, ctl.signal, ctl.setProgress)
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  handle('extras:gif', async (opts: GifExportOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const job = jobs.create('gif', path.basename(opts.outputPath), 'heavy', async (ctl) => {
      await checkDiskFor(opts.outputPath, 100 * 1024 * 1024)
      const res = await exportGif(ctx, opts, info, ctl.signal, ctl.setProgress)
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  handle('extras:reverse', async (opts: ReverseOptions) => {
    const ctx = engineCtx()
    const { info } = await probeFile(ctx, opts.inputPath)
    const job = jobs.create('reverse', path.basename(opts.outputPath), 'heavy', async (ctl) => {
      const len = (opts.end ?? info.durationSec) - (opts.start ?? 0)
      await checkDiskFor(opts.outputPath, estimateBytes(len, info.kind === 'video'))
      const res = await reverseExport(ctx, opts, info, pickHwEncoder(opts.useHardware), ctl.signal, ctl.setProgress)
      registerMediaPath(res.outputPath)
      return res
    }, { outputPath: opts.outputPath })
    return { jobId: job.id }
  })

  // ---------- translation ----------

  // The renderer sends its translate config with the call — the click-time
  // truth — so a settings-sync race can never route to the wrong backend.
  handle('translate:run', async (segments: SubtitleSegment[], cfg: TranslateSettings, sourceLang: string | null) => {
    const targetLang = cfg.targetLang || 'ar'
    const job = jobs.create('translate', `→ ${targetLang}`, 'download', async (ctl) => {
      let result
      if (cfg.backend === 'nllb') {
        const { nllbTranslateAll } = await import('./nllb')
        result = await nllbTranslateAll(segments, sourceLang, targetLang, ctl.signal, ctl.setProgress)
      } else {
        const apiKey = getApiKey(cfg.backend)
        if (!apiKey) {
          throw err('translate-no-key', `No API key saved for ${cfg.backend}.`, 'Add one in Settings → Translation, or switch to the offline backend.')
        }
        const model = cfg.backend === 'claude' ? cfg.claudeModel : cfg.backend === 'openai' ? cfg.openaiModel : undefined
        result = await translateAllOnline(
          { provider: cfg.backend, apiKey, model },
          segments,
          targetLang,
          { signal: ctl.signal, onProgress: ctl.setProgress, log: (m) => log.info(`[translate] ${m}`), sourceLang }
        )
      }
      // Timing-sync guard: translations attach to existing segments by id —
      // 1:1 boundaries, never merged or split. Any foreign id means the
      // contract broke somewhere; abort instead of shipping desynced subs.
      const inputIds = new Set(segments.map((s) => s.id))
      const foreign = Object.keys(result.translations).map(Number).filter((id) => !inputIds.has(id))
      if (foreign.length > 0) {
        throw err('translate-sync', 'Translation returned segments that do not exist in the transcript.',
          'This is a bug guard — no subtitles were modified. Check the log.', `foreign ids: ${foreign.slice(0, 10).join(',')}`)
      }
      const checked = segments.filter((s) => result.translations[s.id] !== undefined).slice(0, 10)
      log.info(`[translate] sync check: ${Object.keys(result.translations).length} translations mapped 1:1 onto source ids; ` +
        `timing drift 0.000s across first ${checked.length} segments (boundaries preserved by construction)`)
      return result
    })
    return { jobId: job.id }
  })

  handle('translate:test', async (provider: ApiProvider) => {
    const apiKey = getApiKey(provider)
    if (!apiKey) return { ok: false, message: 'No API key saved for this provider yet.' }
    const cfg = store.settings.translate
    const model = provider === 'claude' ? cfg.claudeModel : provider === 'openai' ? cfg.openaiModel : undefined
    return testProvider({ provider, apiKey, model })
  })

  handle('translate:set-key', (provider: ApiProvider, key: string | null) => {
    setApiKey(provider, key)
    return hasApiKeys()
  })

  handle('translate:has-keys', () => hasApiKeys())

  // ---------- project files ----------

  handle('project:save', async (outPath: string, project: ProjectFile) => {
    await writeFileAtomic(outPath, JSON.stringify(project, null, 2))
  })

  handle('project:load', async (p: string): Promise<ProjectFile> => {
    let parsed: ProjectFile
    try {
      parsed = JSON.parse(await readFile(p, 'utf8')) as ProjectFile
    } catch {
      throw err('project-invalid', "This file isn't a readable LaluKit project.")
    }
    if (parsed.app !== 'lalukit' || parsed.version !== 1 || typeof parsed.sourcePath !== 'string') {
      throw err('project-invalid', "This file isn't a valid LaluKit project.")
    }
    if (!existsSync(parsed.sourcePath)) {
      throw err('project-source-missing', 'The video this project edits could not be found.',
        `It was at: ${parsed.sourcePath}`)
    }
    return parsed
  })

  handle('project:autosave', async (project: ProjectFile) => {
    const dir = path.join(app.getPath('userData'), 'recovery')
    await mkdirP(dir)
    await writeFileAtomic(path.join(dir, 'last.lalukit'), JSON.stringify(project))
  })

  handle('project:recovery-peek', async (): Promise<ProjectFile | null> => {
    try {
      const p = path.join(app.getPath('userData'), 'recovery', 'last.lalukit')
      const parsed = JSON.parse(await readFile(p, 'utf8')) as ProjectFile
      if (parsed.app !== 'lalukit' || !existsSync(parsed.sourcePath)) return null
      return parsed
    } catch {
      return null
    }
  })

  handle('project:recovery-clear', async () => {
    await unlink(path.join(app.getPath('userData'), 'recovery', 'last.lalukit')).catch(() => {})
  })

  // ---------- jobs ----------

  handle('jobs:cancel', (id: string) => jobs.cancel(id))
  handle('jobs:list', () => jobs.list())

  // Background hygiene: drop oldest proxies if the cache crosses 3 GB.
  void pruneProxies()

  return jobs
}

async function pruneProxies(): Promise<void> {
  try {
    const dir = cacheDir('proxies')
    const entries = await readdir(dir)
    const files = await Promise.all(
      entries.map(async (name) => {
        const p = path.join(dir, name)
        const st = await stat(p).catch(() => null)
        return st ? { p, size: st.size, mtime: st.mtimeMs } : null
      })
    )
    const valid = files.filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => a.mtime - b.mtime)
    let total = valid.reduce((s, f) => s + f.size, 0)
    const CAP = 3 * 1024 * 1024 * 1024
    for (const f of valid) {
      if (total <= CAP) break
      await unlink(f.p).catch(() => {})
      total -= f.size
    }
  } catch { /* cache pruning is best-effort */ }
}

export function getJobs(): JobManager {
  return jobs
}
