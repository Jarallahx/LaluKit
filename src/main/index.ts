import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import log, { initLogger } from './logger'
import { getStore } from './settings'
import { installMediaProtocol, registerMediaSchemePrivileges } from './protocol'
import { setupIpc } from './ipc'
import { detectHwEncoders } from './system'

registerMediaSchemePrivileges()

const smokeArgEarly = process.argv.find((a) => a.startsWith('--smoke'))

// Smoke/automation runs are fully isolated: own userData (settings, cache,
// logs) and no single-instance lock, so they never collide with a live app.
if (smokeArgEarly) {
  const dir = process.env.LALU_SMOKE_USERDATA ?? path.join(os.tmpdir(), 'lalukit-smoke')
  app.setPath('userData', dir)
  void main()
} else {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    void main()
  }
}

let win: BrowserWindow | null = null

function mediaArgFrom(argv: string[]): string | null {
  const candidates = argv.slice(1).filter((a) => !a.startsWith('-') && a !== '.' && existsSync(a))
  return candidates.length > 0 ? candidates[candidates.length - 1] : null
}

const smokeScenario = smokeArgEarly ? (smokeArgEarly.split('=')[1] ?? 'home') : null

async function main(): Promise<void> {
  await app.whenReady()
  initLogger()
  log.info(`LaluKit ${app.getVersion()} starting (packaged: ${app.isPackaged})`)
  installMediaProtocol()
  Menu.setApplicationMenu(null)
  createWindow()

  app.on('second-instance', (_e, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const file = mediaArgFrom(argv)
    if (file) win.webContents.send('app:open-file', file)
  })

  app.on('window-all-closed', () => {
    getStore().flush()
    app.quit()
  })

  // Warm the hardware-encoder probe so export dialogs answer instantly.
  void detectHwEncoders()
}

function createWindow(): void {
  const store = getStore()
  const bounds = store.windowBounds
  const dark = store.settings.theme === 'dark'

  win = new BrowserWindow({
    width: bounds?.width ?? 1360,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    backgroundColor: dark ? '#0a0c10' : '#f2f4f8',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: dark ? '#9aa3b3' : '#5a6372',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  setupIpc(win)

  win.once('ready-to-show', () => win?.show())

  const saveBounds = (): void => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    const b = win.getBounds()
    getStore().setWindowBounds(b)
  }
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The app is a single page: block every navigation, including the mouse
  // back/forward side buttons, which would otherwise unload the UI and leave
  // an unresponsive window.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward' || cmd === 'browser-forward') e.preventDefault()
  })

  // F12 toggles devtools in development.
  win.webContents.on('before-input-event', (_e, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') {
      win?.webContents.toggleDevTools()
    }
  })

  const rendererErrors: string[] = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      rendererErrors.push(event.message)
      log.warn(`[renderer] ${event.message}`)
    } else if (event.level === 'warning') {
      log.info(`[renderer] ${event.message}`)
    }
  })

  win.webContents.on('did-finish-load', () => {
    const file = mediaArgFrom(process.argv)
    if (file && !smokeScenario) win?.webContents.send('app:open-file', file)
    if (smokeScenario) void runSmoke(rendererErrors)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// Smoke harness: loads a scenario in the renderer, waits, screenshots, exits
// non-zero when the renderer logged console errors. Scenarios prefixed with
// "auto:" run synthesized-input automation instead (see automation.ts).
async function runSmoke(rendererErrors: string[]): Promise<void> {
  if (!win) return
  const outPath = process.env.LALU_SMOKE_OUT ?? path.join(app.getAppPath(), 'shots', `${smokeScenario}.png`)
  const waitMs = Number(process.env.LALU_SMOKE_WAIT ?? 3500)
  if (smokeScenario?.startsWith('auto:')) {
    const { runAutomation } = await import('./automation')
    const res = await runAutomation(win, smokeScenario.slice(5), process.env.LALU_TEST_VIDEO ?? null)
    // GUI-subsystem stdout is unreliable on Windows; persist results to a file.
    if (process.env.LALU_SMOKE_RESULT) {
      await writeFile(process.env.LALU_SMOKE_RESULT, JSON.stringify(res, null, 2)).catch(() => {})
    }
    if (!res.ok) rendererErrors.push(...res.errors)
  } else {
    win.webContents.send('smoke:scenario', {
      scenario: smokeScenario,
      testVideo: process.env.LALU_TEST_VIDEO ?? null
    })
  }
  await new Promise((r) => setTimeout(r, smokeScenario?.startsWith('auto:') ? 400 : waitMs))
  try {
    const image = await win.webContents.capturePage()
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, image.toPNG())
    log.info(`[smoke] screenshot saved: ${outPath}`)
  } catch (e) {
    log.error('[smoke] capture failed:', e)
    rendererErrors.push(String(e))
  }
  // Surface renderer errors to the harness via exit code + stdout.
  if (rendererErrors.length > 0) {
    process.stdout.write(`SMOKE_ERRORS ${JSON.stringify(rendererErrors.slice(0, 20))}\n`)
  } else {
    process.stdout.write('SMOKE_OK\n')
  }
  app.exit(rendererErrors.length > 0 ? 1 : 0)
}
