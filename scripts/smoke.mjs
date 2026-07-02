// UI smoke runner: boots the built app into deterministic scenarios, captures
// a screenshot of each, and fails when the renderer logged console errors.
//
//   npm run smoke              -> all scenarios
//   npm run smoke -- cut rtl   -> selected scenarios
//
// Screenshots land in shots/<scenario>.png.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron') // path to electron.exe
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ALL = ['home', 'cut', 'cut-remove', 'subs', 'subs-transcript', 'style', 'merge', 'export', 'settings', 'light', 'rtl', 'do-export', 'do-transcribe']
const scenarios = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const list = scenarios.length > 0 ? scenarios : ALL

const testVideo = path.join(root, 'scripts', 'e2e', '.work', 'assets', 'testA.mp4')
if (!existsSync(testVideo)) {
  console.log('generating smoke test video')
  mkdirSync(path.dirname(testVideo), { recursive: true })
  execFileSync(path.join(root, 'resources', 'bin', 'ffmpeg.exe'), [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', testVideo
  ], { windowsHide: true })
}

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/ missing — run "npx electron-vite build" first')
  process.exit(1)
}

mkdirSync(path.join(root, 'shots'), { recursive: true })
mkdirSync(path.join(root, 'scripts', 'e2e', '.work', 'out'), { recursive: true })

// Smoke runs are isolated from any live LaluKit instance: dedicated userData
// (settings/cache/logs/models) under the e2e work directory.
const smokeUserData = path.join(root, 'scripts', 'e2e', '.work', 'smoke-userdata')
mkdirSync(smokeUserData, { recursive: true })

// Speech clip + tiny model come from the e2e suite; the do-transcribe
// scenario needs the model in the smoke profile's models dir.
const speechVideo = path.join(root, 'scripts', 'e2e', '.work', 'assets', 'speech.mp4')
const e2eModel = path.join(root, 'scripts', 'e2e', '.work', 'models', 'ggml-tiny.bin')
const appModelsDir = path.join(smokeUserData, 'models')
const appModel = path.join(appModelsDir, 'ggml-tiny.bin')

function prepareScenario(scenario) {
  if (scenario === 'auto:translate-nllb') {
    if (!existsSync(speechVideo) || !existsSync(e2eModel)) {
      console.log(`  SKIP  ${scenario} (run "npm run e2e" first for speech assets + tiny model)`)
      return null
    }
    const nllbSrc = path.join(root, 'scripts', 'e2e', '.work', 'nllb-cache')
    if (!existsSync(nllbSrc)) {
      console.log(`  SKIP  ${scenario} (NLLB cache missing — run e2e with LALU_E2E_NLLB=1 once)`)
      return null
    }
    mkdirSync(appModelsDir, { recursive: true })
    if (!existsSync(appModel)) execFileSync('cmd.exe', ['/c', 'copy', '/y', e2eModel, appModel], { windowsHide: true })
    const nllbDst = path.join(smokeUserData, 'models', 'nllb-cache')
    if (!existsSync(nllbDst)) {
      try {
        execFileSync('robocopy', [nllbSrc, nllbDst, '/e', '/njh', '/njs', '/ndl', '/nfl'], { windowsHide: true, stdio: 'ignore' })
      } catch (e) {
        // robocopy exits 1 on successful copy; only >=8 is a real failure.
        if ((e.status ?? 99) >= 8) throw e
      }
    }
    return { video: speechVideo, wait: 300000 }
  }
  if (scenario === 'do-transcribe') {
    if (!existsSync(speechVideo)) {
      console.log(`  SKIP  ${scenario} (run "npm run e2e" first to create speech assets)`)
      return null
    }
    if (!existsSync(appModel)) {
      if (!existsSync(e2eModel)) {
        console.log(`  SKIP  ${scenario} (tiny model missing — run "npm run e2e" first)`)
        return null
      }
      mkdirSync(appModelsDir, { recursive: true })
      execFileSync('cmd.exe', ['/c', 'copy', '/y', e2eModel, appModel], { windowsHide: true })
    }
    return { video: speechVideo, wait: 60000 }
  }
  if (scenario === 'do-export') return { video: testVideo, wait: 25000 }
  if (scenario === 'home' || scenario === 'settings') return { video: testVideo, wait: 2500 }
  return { video: testVideo, wait: 5000 }
}

let failures = 0
for (const scenario of list) {
  const prep = prepareScenario(scenario)
  if (!prep) continue
  const outPng = path.join(root, 'shots', `${scenario.replace(/[:]/g, '-')}.png`)
  const resultFile = path.join(root, 'shots', `${scenario.replace(/[:]/g, '-')}.json`)
  const code = await new Promise((resolve) => {
    const child = spawn(electron, ['.', `--smoke=${scenario}`], {
      cwd: root,
      env: {
        ...process.env,
        LALU_SMOKE_OUT: outPng,
        LALU_SMOKE_WAIT: String(prep.wait),
        LALU_SMOKE_RESULT: resultFile,
        LALU_SMOKE_USERDATA: smokeUserData,
        LALU_TEST_VIDEO: prep.video
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c.toString() })
    child.stderr.on('data', () => {})
    const timeout = setTimeout(() => child.kill(), prep.wait + 30000)
    child.on('close', (c) => {
      clearTimeout(timeout)
      const errLine = out.split('\n').find((l) => l.startsWith('SMOKE_ERRORS'))
      if (errLine) console.error(`  ${scenario}: renderer errors -> ${errLine.slice(13, 400)}`)
      if (existsSync(resultFile)) {
        try {
          const res = JSON.parse(readFileSync(resultFile, 'utf8'))
          console.log(`  ${scenario}: ${JSON.stringify(res.details)}${res.errors.length ? ' errors: ' + res.errors.join(' | ') : ''}`)
        } catch { /* unreadable result file */ }
      }
      resolve(c ?? 1)
    })
  })
  let ok = code === 0
  if (scenario === 'do-export') {
    const produced = path.join(root, 'scripts', 'e2e', '.work', 'out', 'smoke-cut.mp4')
    if (!existsSync(produced)) {
      ok = false
      console.error(`  ${scenario}: expected output missing (${produced})`)
    }
  }
  if (ok) {
    console.log(`  OK    ${scenario}`)
  } else {
    failures++
    console.error(`  FAIL  ${scenario} (exit ${code})`)
  }
}

console.log(failures === 0 ? '\nsmoke: all scenarios clean' : `\nsmoke: ${failures} scenario(s) reported errors`)
process.exit(failures === 0 ? 0 : 1)
