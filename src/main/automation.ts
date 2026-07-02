import type { BrowserWindow } from 'electron'
import log from './logger'

// UI automation for smoke scenarios (--smoke=auto:<name>): drives the real
// renderer with synthesized mouse/keyboard input so interaction bugs
// (dead overlays, broken drags) reproduce exactly as a user sees them.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Rect { x: number; y: number; w: number; h: number; l: number; t: number }

export interface AutomationResult {
  name: string
  ok: boolean
  details: Record<string, unknown>
  errors: string[]
}

class Driver {
  constructor(private win: BrowserWindow) {}

  js<T>(expr: string): Promise<T> {
    return this.win.webContents.executeJavaScript(expr) as Promise<T>
  }

  async rect(selector: string): Promise<Rect | null> {
    return this.js<Rect | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, l: b.x, t: b.y } })()`
    )
  }

  async mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number): Promise<void> {
    this.win.webContents.sendInputEvent({
      type, x: Math.round(x), y: Math.round(y),
      button: 'left', clickCount: type === 'mouseMove' ? 0 : 1
    })
    await sleep(18)
  }

  async click(x: number, y: number): Promise<void> {
    await this.mouse('mouseMove', x, y)
    await this.mouse('mouseDown', x, y)
    await sleep(35)
    await this.mouse('mouseUp', x, y)
    await sleep(60)
  }

  async clickSel(selector: string): Promise<boolean> {
    const r = await this.rect(selector)
    if (!r) return false
    await this.click(r.x, r.y)
    return true
  }

  async key(keyCode: string): Promise<void> {
    this.win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    await sleep(25)
    this.win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(50)
  }

  async chord(keyCode: string, modifiers: ('control' | 'shift' | 'alt')[]): Promise<void> {
    this.win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    await sleep(25)
    this.win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(60)
  }

  async shiftClick(x: number, y: number): Promise<void> {
    this.win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    await sleep(20)
    this.win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: ['shift'] })
    await sleep(30)
    this.win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: ['shift'] })
    await sleep(80)
  }

  async waitFor(expr: string, timeoutMs = 10000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await this.js<boolean>(`!!(${expr})`)) return true
      await sleep(120)
    }
    return false
  }
}

export async function runAutomation(
  win: BrowserWindow,
  name: string,
  testVideo: string | null
): Promise<AutomationResult> {
  const d = new Driver(win)
  const result: AutomationResult = { name, ok: false, details: {}, errors: [] }
  const fail = (msg: string): void => { result.errors.push(msg) }

  const loadCutScenario = async (): Promise<boolean> => {
    win.webContents.send('smoke:scenario', { scenario: 'cut', testVideo })
    const ready = await d.waitFor(
      `document.querySelector('video.player-video') && document.querySelector('video.player-video').readyState >= 2 && document.querySelector('.tl-content')`,
      15000
    )
    if (!ready) fail('media did not load')
    await sleep(400)
    return ready
  }

  try {
    switch (name) {
      // Open/close the settings modal rapidly via every close path, then
      // prove the app still responds (no dead overlay eating clicks).
      case 'settings-stress': {
        await d.waitFor(`document.querySelector('[data-testid="btn-settings"]')`)
        let opens = 0
        for (let i = 0; i < 15; i++) {
          if (!(await d.clickSel('[data-testid="btn-settings"]'))) { fail(`open ${i}: settings button missing`); break }
          const opened = await d.waitFor(`document.querySelector('.modal')`, 3000)
          if (!opened) { fail(`open ${i}: modal did not appear`); break }
          opens++
          await sleep(60)
          if (i % 3 === 0) {
            await d.key('Escape')
          } else if (i % 3 === 1) {
            if (!(await d.clickSel('.modal-head .iconbtn'))) await d.key('Escape')
          } else {
            const bounds = win.getContentBounds()
            await d.click(30, bounds.height - 60) // backdrop click
          }
          const closed = await d.waitFor(`!document.querySelector('.modal')`, 3000)
          if (!closed) { fail(`close ${i}: modal stuck open`); break }
          await sleep(90)
        }
        result.details.opens = opens
        await sleep(500)
        const leftovers = await d.js<number>(
          `Array.from(document.querySelectorAll('.modal-backdrop')).filter((b) => b.classList.contains('is-open') || getComputedStyle(b).pointerEvents !== 'none').length`
        )
        result.details.leftoverBackdrops = leftovers
        if (leftovers > 0) fail(`${leftovers} orphaned backdrop(s) still in DOM`)
        // Responsiveness probe: theme must flip when the toggle is clicked.
        const themeBefore = await d.js<string>(`document.documentElement.dataset.theme`)
        await d.clickSel('[data-testid="btn-theme"]')
        await sleep(600)
        const themeAfter = await d.js<string>(`document.documentElement.dataset.theme`)
        result.details.themeToggled = themeBefore !== themeAfter
        if (themeBefore === themeAfter) fail('theme toggle unresponsive after settings stress')
        await d.clickSel('[data-testid="btn-theme"]') // restore
        result.ok = result.errors.length === 0 && opens === 15
        break
      }

      // Click-to-seek and drag-to-scrub on the timeline must move the video.
      case 'scrub': {
        if (!(await loadCutScenario())) break
        const tl = await d.rect('.tl-content')
        const dur = await d.js<number>(`document.querySelector('video.player-video').duration`)
        if (!tl || !dur) { fail('timeline or video missing'); break }
        const timeOf = (): Promise<number> => d.js<number>(`document.querySelector('video.player-video').currentTime`)
        const xAt = (frac: number): number => tl.l + tl.w * frac
        const yRuler = tl.t + 12 // empty ruler strip — ranges start below it

        // 1) click seeks
        await d.click(xAt(0.7), yRuler)
        await sleep(250)
        const t1 = await timeOf()
        result.details.clickSeek = { expected: 0.7 * dur, got: Number(t1.toFixed(2)) }
        if (Math.abs(t1 - 0.7 * dur) > 0.35) fail(`click-seek landed at ${t1.toFixed(2)} (expected ~${(0.7 * dur).toFixed(2)})`)

        // 2) drag on empty timeline scrubs continuously
        const samples: number[] = []
        await d.mouse('mouseMove', xAt(0.2), yRuler)
        await d.mouse('mouseDown', xAt(0.2), yRuler)
        for (const f of [0.25, 0.35, 0.45, 0.55, 0.65]) {
          await d.mouse('mouseMove', xAt(f), yRuler)
          await sleep(90)
          samples.push(await timeOf())
        }
        await d.mouse('mouseUp', xAt(0.65), yRuler)
        result.details.dragSamples = samples.map((s) => Number(s.toFixed(2)))
        const increasing = samples.every((s, i) => i === 0 || s >= samples[i - 1] - 0.01)
        const moved = samples[samples.length - 1] - samples[0] > dur * 0.25
        if (!increasing || !moved) fail(`drag did not scrub video (samples: ${samples.map((s) => s.toFixed(2)).join(', ')})`)
        const tEnd = await timeOf()
        if (Math.abs(tEnd - 0.65 * dur) > 0.4) fail(`drag release at ${tEnd.toFixed(2)} (expected ~${(0.65 * dur).toFixed(2)})`)

        // 3) the playhead cap itself is grabbable
        await sleep(150)
        const cap = await d.rect('.tl-playhead-cap')
        if (!cap) { fail('playhead cap not found'); break }
        await d.mouse('mouseMove', cap.x, cap.y)
        await d.mouse('mouseDown', cap.x, cap.y)
        await d.mouse('mouseMove', xAt(0.3), cap.y)
        await sleep(120)
        await d.mouse('mouseMove', xAt(0.4), cap.y)
        await sleep(120)
        await d.mouse('mouseUp', xAt(0.4), cap.y)
        await sleep(150)
        const tCap = await timeOf()
        result.details.playheadDrag = { expected: 0.4 * dur, got: Number(tCap.toFixed(2)) }
        if (Math.abs(tCap - 0.4 * dur) > 0.4) fail(`playhead drag landed at ${tCap.toFixed(2)} (expected ~${(0.4 * dur).toFixed(2)})`)
        result.ok = result.errors.length === 0
        break
      }

      // Harsher freeze hunt: heavy transcript DOM + walking every settings
      // tab + theme/language toggles + cache actions, repeatedly.
      case 'settings-stress-heavy': {
        if (!(await loadCutScenario())) break
        // Simulate a long real-world transcript (heavy DOM like a 25-min episode).
        await d.js(`(() => {
          const segs = Array.from({ length: 700 }, (_, i) => ({
            id: i + 1, start: i * 2, end: i * 2 + 1.8,
            text: i % 3 === 2 ? 'سطر عربي رقم ' + i + ' للاختبار الثقيل' : 'Heavy transcript line number ' + i
          }))
          window.__lalu_smoke_setSegments(segs)
        })()`)
        await sleep(400)
        let cycles = 0
        for (let i = 0; i < 6; i++) {
          if (!(await d.clickSel('[data-testid="btn-settings"]'))) { fail(`cycle ${i}: settings btn missing`); break }
          if (!(await d.waitFor(`document.querySelector('.settings')`, 3000))) { fail(`cycle ${i}: settings did not open`); break }
          // walk all tabs
          const tabs = await d.js<number>(`document.querySelectorAll('.settings-tab').length`)
          for (let tIdx = 0; tIdx < tabs; tIdx++) {
            const r = await d.rect(`.settings-tab:nth-child(${tIdx + 1})`)
            if (r) await d.click(r.x, r.y)
            await sleep(80)
          }
          // toggle theme twice from inside settings (General tab)
          const first = await d.rect('.settings-tab:nth-child(1)')
          if (first) await d.click(first.x, first.y)
          await sleep(80)
          for (let k = 0; k < 2; k++) {
            const seg = await d.rect('.settings-body .segmented .segment:nth-child(2)')
            if (seg) await d.click(seg.x, seg.y)
            await sleep(250)
            const seg1 = await d.rect('.settings-body .segmented .segment:nth-child(1)')
            if (seg1) await d.click(seg1.x, seg1.y)
            await sleep(250)
          }
          await d.key('Escape')
          // 5s: generous against machine load; the real deadlock never resolves.
          if (!(await d.waitFor(`!document.querySelector('.modal')`, 5000))) { fail(`cycle ${i}: modal stuck`); break }
          cycles++
          await sleep(120)
        }
        result.details.cycles = cycles
        // responsiveness probes after the storm
        const themeBefore = await d.js<string>(`document.documentElement.dataset.theme`)
        await d.clickSel('[data-testid="btn-theme"]')
        await sleep(700)
        const themeAfter = await d.js<string>(`document.documentElement.dataset.theme`)
        result.details.themeToggled = themeBefore !== themeAfter
        if (themeBefore === themeAfter) fail('theme toggle dead after heavy stress')
        const playBtn = await d.rect('.player-play')
        if (playBtn) {
          await d.click(playBtn.x, playBtn.y)
          await sleep(500)
          const playing = await d.js<boolean>(`!document.querySelector('video.player-video').paused`)
          result.details.playClickable = playing
          if (!playing) fail('play button dead after heavy stress')
        }
        const leftovers = await d.js<number>(
          `Array.from(document.querySelectorAll('.modal-backdrop')).filter((b) => b.classList.contains('is-open') || getComputedStyle(b).pointerEvents !== 'none').length`
        )
        result.details.leftoverBackdrops = leftovers
        if (leftovers > 0) fail(`${leftovers} orphaned backdrops`)
        result.ok = result.errors.length === 0 && cycles === 6
        break
      }

      // New editing ops end-to-end: split (S), undo/redo (Ctrl+Z/Ctrl+Shift+Z),
      // shift-click multi-select + Delete, command palette (Ctrl+K).
      case 'edit-ops': {
        if (!(await loadCutScenario())) break
        const countRanges = (): Promise<number> => d.js<number>(`document.querySelectorAll('.tl-range').length`)
        const r0 = await countRanges()
        result.details.initialRanges = r0
        if (r0 !== 2) { fail(`expected 2 scenario ranges, got ${r0}`) }

        // seek inside range 1 (scenario range ~[0.96, 2.4]) and split with S
        await d.js(`(() => { const v = document.querySelector('video.player-video'); v.pause(); v.currentTime = 1.7 })()`)
        await sleep(250)
        await d.key('S')
        await sleep(250)
        const afterSplit = await countRanges()
        result.details.afterSplit = afterSplit
        if (afterSplit !== r0 + 1) fail(`split did not create a range (have ${afterSplit})`)

        // undo restores, redo re-applies
        await d.chord('Z', ['control'])
        await sleep(250)
        const afterUndo = await countRanges()
        result.details.afterUndo = afterUndo
        if (afterUndo !== r0) fail(`undo did not restore (have ${afterUndo})`)
        await d.chord('Z', ['control', 'shift'])
        await sleep(250)
        const afterRedo = await countRanges()
        result.details.afterRedo = afterRedo
        if (afterRedo !== r0 + 1) fail(`redo did not re-apply (have ${afterRedo})`)

        // click first range, shift-click last, Delete removes both
        const firstRange = await d.rect('.tl-range')
        if (firstRange) await d.click(firstRange.x, firstRange.y)
        await sleep(120)
        const r2 = await d.js<{ x: number; y: number } | null>(
          `(() => { const els = document.querySelectorAll('.tl-range'); const el = els[els.length - 1];
            if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`
        )
        if (r2) {
          await d.shiftClick(r2.x, r2.y)
          await sleep(120)
          const selCount = await d.js<number>(`document.querySelectorAll('.tl-range.is-selected').length`)
          result.details.multiSelected = selCount
          if (selCount < 2) fail(`shift-click selected ${selCount} ranges`)
          await d.key('Delete')
          await sleep(250)
          const afterDel = await countRanges()
          result.details.afterMultiDelete = afterDel
          if (afterDel !== afterRedo - selCount) fail(`multi-delete removed wrong count (have ${afterDel})`)
        }

        // command palette opens with Ctrl+K and closes with Escape
        await d.chord('K', ['control'])
        const paletteUp = await d.waitFor(`document.querySelector('.palette-input')`, 2500)
        result.details.paletteOpens = paletteUp
        if (!paletteUp) fail('palette did not open on Ctrl+K')
        await d.key('Escape')
        const paletteGone = await d.waitFor(`!document.querySelector('.palette-input')`, 2500)
        if (!paletteGone) fail('palette did not close on Escape')

        result.ok = result.errors.length === 0
        break
      }

      // Full app-pipeline translation: transcribe real speech, translate via
      // the offline backend, verify 1:1 timestamp preservation + Both view.
      case 'translate-nllb': {
        win.webContents.send('smoke:scenario', { scenario: 'home', testVideo })
        await d.waitFor(`window.__lalu_smoke_setSegments`, 8000)
        const r = await d.js<{ ok: boolean; detail: string }>(`(async () => {
          const wait0 = async (pred, ms) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await new Promise(r2 => setTimeout(r2, 100)) } return true }
          await wait0(() => window.__lalu_store.getState().hydrated, 10000)
          const s = window.__lalu_store.getState()
          s.patchSettings({ translate: { ...window.__lalu_store.getState().translate, backend: 'nllb', targetLang: 'ar' } })
          await s.openFile(${JSON.stringify(testVideo)}, { force: true })
          s.setWorkspace('subtitles')
          s.setSubsOption({ lastModelId: 'tiny', lastLanguage: 'auto', lastTranslate: false })
          await s.refreshModels()
          await s.startTranscribe()
          const wait = async (pred, ms) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await new Promise(r2 => setTimeout(r2, 250)) } return true }
          if (!(await wait(() => window.__lalu_store.getState().segments.length > 0, 60000))) return { ok: false, detail: 'transcribe timeout' }
          const before = window.__lalu_store.getState().segments.map(x => ({ id: x.id, start: x.start, end: x.end }))
          await window.__lalu_store.getState().startTranslate()
          if (!(await wait(() => window.__lalu_store.getState().segments.some(x => x.translation), 240000))) {
            const js2 = Object.values(window.__lalu_store.getState().jobs).filter(j => j.kind === 'translate')
            return { ok: false, detail: 'translate timeout; job=' + JSON.stringify(js2.map(j => ({ s: j.state, p: j.progress, d: j.detail, e: j.error && j.error.message }))) }
          }
          const after = window.__lalu_store.getState().segments
          let drift = 0
          for (const b of before.slice(0, 10)) {
            const a = after.find(x => x.id === b.id)
            if (!a) return { ok: false, detail: 'segment id lost: ' + b.id }
            drift += Math.abs(a.start - b.start) + Math.abs(a.end - b.end)
          }
          const arabic = after.filter(x => x.translation && /[\\u0600-\\u06FF]/.test(x.translation)).length
          return {
            ok: drift === 0 && arabic > 0 && window.__lalu_store.getState().subsViewMode === 'both',
            detail: 'drift=' + drift.toFixed(4) + 's arabic=' + arabic + '/' + after.length + ' view=' + window.__lalu_store.getState().subsViewMode +
              ' sample=' + JSON.stringify((after.find(x => x.translation) || {}).translation || '').slice(0, 60)
          }
        })()`)
        result.details = r as unknown as Record<string, unknown>
        if (!r.ok) fail(`nllb pipeline: ${r.detail}`)
        result.ok = result.errors.length === 0
        await sleep(600)
        break
      }

      // Media pipeline diagnosis: does the media:// protocol honor Range
      // requests, and does the <video> element consider the source seekable?
      case 'diag-media': {
        if (!(await loadCutScenario())) break
        const diag = await d.js<Record<string, unknown>>(`(async () => {
          const v = document.querySelector('video.player-video')
          const src = v.currentSrc || v.src
          const out = { src: src.slice(0, 40), duration: v.duration, readyState: v.readyState }
          out.seekable = []
          for (let i = 0; i < v.seekable.length; i++) out.seekable.push([v.seekable.start(i), v.seekable.end(i)])
          try {
            const r = await fetch(src, { headers: { Range: 'bytes=100-199' } })
            out.rangeStatus = r.status
            out.contentRange = r.headers.get('content-range')
            out.acceptRanges = r.headers.get('accept-ranges')
            out.rangeLen = (await r.arrayBuffer()).byteLength
          } catch (e) { out.fetchError = String(e) }
          v.currentTime = 3
          await new Promise((res) => setTimeout(res, 600))
          out.afterSeek = v.currentTime
          return out
        })()`)
        result.details = diag
        result.ok = true // diagnosis always "passes"; we read the details
        break
      }

      default:
        fail(`unknown automation: ${name}`)
    }
  } catch (e) {
    fail(`automation crashed: ${(e as Error).message}`)
  }
  log.info(`[auto] ${name}: ${result.ok ? 'OK' : 'FAIL'} ${JSON.stringify(result.details)} ${result.errors.join(' | ')}`)
  return result
}
