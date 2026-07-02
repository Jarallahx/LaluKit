// Downloads the engine binaries LaluKit bundles: FFmpeg/FFprobe (BtbN GPL build)
// and whisper.cpp (whisper-cli). No npm deps — uses global fetch + PowerShell unzip.
import { createWriteStream } from 'node:fs'
import { mkdir, rm, readdir, stat, copyFile, writeFile, access } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binDir = path.join(root, 'resources', 'bin')
const whisperDir = path.join(binDir, 'whisper')
const whisperCudaDir = path.join(binDir, 'whisper-cuda')
const fontsDir = path.join(root, 'resources', 'fonts')
const ifMissing = process.argv.includes('--if-missing')
const skipCuda = process.argv.includes('--no-cuda')

// Bundled fonts: Arabic-capable subtitle rendering that never depends on the
// user's installed font set.
const FONT_URLS = {
  'NotoSansArabic-Regular.ttf': 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Regular.ttf',
  'NotoSansArabic-Bold.ttf': 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Bold.ttf',
  'NotoSans-Regular.ttf': 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf',
  'NotoSans-Bold.ttf': 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf'
}

const FFMPEG_URLS = [
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
]
const WHISPER_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
// Silero VAD v6 (ggml port) — whisper.cpp's native voice-activity filter.
const VAD_MODEL_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin'
const VAD_MODEL_NAME = 'ggml-silero-v6.2.0.bin'

const log = (m) => console.log(`[setup] ${m}`)

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

async function download(url, dest) {
  log(`downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'LaluKit-setup' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0, lastPct = -10
  const counter = new TransformStreamCounter((n) => {
    got += n
    if (total) {
      const pct = Math.floor((got / total) * 100)
      if (pct >= lastPct + 10) { lastPct = pct; log(`  ${pct}% of ${(total / 1048576).toFixed(0)} MB`) }
    }
  })
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest))
}

// Tiny Transform stream that reports chunk sizes.
import { Transform } from 'node:stream'
function TransformStreamCounter(onChunk) {
  return new Transform({
    transform(chunk, _enc, cb) { onChunk(chunk.length); cb(null, chunk) }
  })
}

function unzip(zipPath, destDir) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`
  ], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`unzip failed for ${zipPath}`)
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

// Names are tried in priority order: all files are scanned for names[0] first,
// then names[1], etc. (the whisper zip ships a deprecated "main.exe" shim that
// must lose to the real "whisper-cli.exe").
async function findFile(dir, names) {
  const all = []
  for await (const p of walk(dir)) all.push(p)
  for (const name of names) {
    const hit = all.find((p) => path.basename(p).toLowerCase() === name.toLowerCase())
    if (hit) return hit
  }
  return null
}

function verify(exe, args, label) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (r.status !== 0) throw new Error(`${label} failed verification (exit ${r.status}): ${(r.stderr || '').slice(0, 400)}`)
  const line = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/)[0]
  log(`${label} OK — ${line}`)
  return line
}

async function fetchFfmpeg(tmp) {
  const zip = path.join(tmp, 'ffmpeg.zip')
  let lastErr = null
  for (const url of FFMPEG_URLS) {
    try {
      await download(url, zip)
      lastErr = null
      break
    } catch (e) { lastErr = e; log(`ffmpeg source failed, trying fallback: ${e.message}`) }
  }
  if (lastErr) throw lastErr
  const ex = path.join(tmp, 'ffmpeg-x')
  unzip(zip, ex)
  const ffmpeg = await findFile(ex, ['ffmpeg.exe'])
  const ffprobe = await findFile(ex, ['ffprobe.exe'])
  if (!ffmpeg || !ffprobe) throw new Error('ffmpeg.exe / ffprobe.exe not found in archive')
  await copyFile(ffmpeg, path.join(binDir, 'ffmpeg.exe'))
  await copyFile(ffprobe, path.join(binDir, 'ffprobe.exe'))
}

async function whisperRelease() {
  log('querying whisper.cpp latest release')
  const res = await fetch(WHISPER_API, { headers: { 'User-Agent': 'LaluKit-setup', Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
  return res.json()
}

async function extractWhisperZip(tmp, asset, destDir, tag) {
  const zip = path.join(tmp, asset.name)
  await download(asset.browser_download_url, zip)
  const ex = path.join(tmp, asset.name.replace(/\.zip$/i, '-x'))
  unzip(zip, ex)
  const cli = await findFile(ex, ['whisper-cli.exe', 'main.exe'])
  if (!cli) throw new Error(`whisper-cli.exe not found in ${asset.name}`)
  await mkdir(destDir, { recursive: true })
  await copyFile(cli, path.join(destDir, 'whisper-cli.exe'))
  // Copy every DLL next to the exe (ggml, whisper, CUDA runtimes...).
  for await (const p of walk(ex)) {
    if (p.toLowerCase().endsWith('.dll')) await copyFile(p, path.join(destDir, path.basename(p)))
  }
  log(`whisper ${tag} -> ${path.basename(destDir)} ready`)
}

async function fetchWhisper(tmp, rel) {
  const assets = rel.assets || []
  const asset =
    assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name)) ||
    assets.find((a) => /bin.*x64.*\.zip$/i.test(a.name) && !/cublas|cuda|blas|arm|win32/i.test(a.name))
  if (!asset) throw new Error(`no suitable whisper asset in release ${rel.tag_name}; assets: ${assets.map((a) => a.name).join(', ')}`)
  log(`whisper release ${rel.tag_name}, asset ${asset.name}`)
  await extractWhisperZip(tmp, asset, whisperDir, rel.tag_name)
  return rel.tag_name
}

// CUDA build (cuBLAS): much faster transcription on NVIDIA GPUs. Optional —
// the app falls back to the CPU build when CUDA can't initialize.
async function fetchWhisperCuda(tmp, rel) {
  const assets = rel.assets || []
  const asset =
    assets.find((a) => /^whisper-cublas-12[\d.]*-bin-x64\.zip$/i.test(a.name)) ||
    assets.find((a) => /cublas.*12.*x64.*\.zip$/i.test(a.name))
  if (!asset) {
    log(`no CUDA 12 whisper asset in ${rel.tag_name} — GPU transcription disabled`)
    return null
  }
  log(`whisper CUDA asset ${asset.name} (${(asset.size / 1048576).toFixed(0)} MB)`)
  await extractWhisperZip(tmp, asset, whisperCudaDir, rel.tag_name)
  return asset.name
}

async function fetchVadModel() {
  const dest = path.join(whisperDir, VAD_MODEL_NAME)
  if (await exists(dest)) return
  await mkdir(whisperDir, { recursive: true })
  await download(VAD_MODEL_URL, dest)
  const st = await stat(dest)
  if (st.size < 200 * 1024) throw new Error(`VAD model looks wrong (${st.size} bytes)`)
  log('VAD model ready')
}

async function fetchFonts() {
  await mkdir(fontsDir, { recursive: true })
  for (const [name, url] of Object.entries(FONT_URLS)) {
    const dest = path.join(fontsDir, name)
    if (await exists(dest)) continue
    await download(url, dest)
    const st = await stat(dest)
    if (st.size < 50 * 1024) throw new Error(`font ${name} looks wrong (${st.size} bytes)`)
  }
  log('fonts ready')
}

function verifies(exe, args) {
  try {
    const r = spawnSync(exe, args, { windowsHide: true, timeout: 30000 })
    return r.status === 0
  } catch { return false }
}

async function main() {
  const ffmpegPath = path.join(binDir, 'ffmpeg.exe')
  const ffprobePath = path.join(binDir, 'ffprobe.exe')
  const whisperPath = path.join(whisperDir, 'whisper-cli.exe')
  const whisperCudaPath = path.join(whisperCudaDir, 'whisper-cli.exe')
  const force = process.argv.includes('--force')
  // Each component is skipped when its binary already exists AND runs.
  const haveFfmpeg = !force && (await exists(ffmpegPath)) && (await exists(ffprobePath)) &&
    verifies(ffmpegPath, ['-version']) && verifies(ffprobePath, ['-version'])
  const haveWhisper = !force && (await exists(whisperPath)) && verifies(whisperPath, ['--help'])
  const haveCuda = skipCuda || (!force && (await exists(whisperCudaPath)) && verifies(whisperCudaPath, ['--help']))
  const haveFonts = !force && (await Promise.all(Object.keys(FONT_URLS).map((n) => exists(path.join(fontsDir, n))))).every(Boolean)
  const haveVad = !force && (await exists(path.join(whisperDir, VAD_MODEL_NAME)))
  if (haveFfmpeg && haveWhisper && haveCuda && haveFonts && haveVad) {
    log('binaries and fonts already present, skipping (use --force to refetch)')
    return
  }
  await mkdir(binDir, { recursive: true })
  await mkdir(whisperDir, { recursive: true })
  const tmp = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'lalukit-setup-')))
  try {
    if (!haveFonts) await fetchFonts()
    if (!haveVad) await fetchVadModel()
    if (!haveFfmpeg) await fetchFfmpeg(tmp)
    let whisperTag = 'existing'
    if (!haveWhisper || !haveCuda) {
      const rel = await whisperRelease()
      if (!haveWhisper) whisperTag = await fetchWhisper(tmp, rel)
      if (!haveCuda) await fetchWhisperCuda(tmp, rel)
    }
    const lines = [
      `fetched: ${new Date().toISOString()}`,
      `ffmpeg: ${verify(ffmpegPath, ['-version'], 'ffmpeg')}`,
      `ffprobe: ${verify(ffprobePath, ['-version'], 'ffprobe')}`,
      `whisper: ${whisperTag} — ${verify(whisperPath, ['--help'], 'whisper-cli')}`,
      `whisper-cuda: ${(await exists(whisperCudaPath)) ? verify(whisperCudaPath, ['--help'], 'whisper-cli (CUDA)') : 'not bundled'}`
    ]
    await writeFile(path.join(binDir, 'VERSIONS.txt'), lines.join('\n') + '\n')
    log('all binaries ready')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((e) => { console.error(`[setup] FAILED: ${e.message}`); process.exit(1) })
