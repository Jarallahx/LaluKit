import { useStore } from '@/state/store'
import type { SubtitleSegment } from '@shared/types'

// Drives the renderer into deterministic states for screenshot smoke tests.
// Wired only when the main process sends a smoke scenario; inert in normal use.

const FAKE_SEGMENTS: SubtitleSegment[] = [
  { id: 1, start: 0.4, end: 2.6, text: 'Welcome to LaluKit — precision editing for everyone.' },
  { id: 2, start: 2.9, end: 5.4, text: 'هذه ترجمة عربية لاختبار الاتجاه من اليمين إلى اليسار.' },
  { id: 3, start: 5.8, end: 8.1, text: 'Subtitles are generated locally with Whisper.' },
  { id: 4, start: 8.4, end: 11.2, text: 'Edit any line, then export SRT or burn it in.' }
]

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function installSmokeHooks(): void {
  window.lalu.system.onSmoke(({ scenario, testVideo }) => {
    // Automation bridge for synthetic heavy-DOM scenarios.
    ;(window as unknown as Record<string, unknown>).__lalu_smoke_setSegments =
      (segs: SubtitleSegment[]) => useStore.getState().setSegments(segs)
    ;(window as unknown as Record<string, unknown>).__lalu_store = useStore
    void runScenario(scenario, testVideo)
  })
}

async function runScenario(scenario: string, testVideo: string | null): Promise<void> {
  const s = useStore.getState()
  await waitFor(() => useStore.getState().hydrated)

  const openTest = async (): Promise<void> => {
    if (!testVideo) return
    await useStore.getState().openFile(testVideo, { force: true })
    await waitFor(() => !!useStore.getState().media)
    await waitFor(() => useStore.getState().thumbs.some((t) => t !== null), 6000)
    await waitFor(() => useStore.getState().peaks !== null, 6000)
  }

  const addRanges = (): void => {
    const st = useStore.getState()
    const dur = st.media?.durationSec ?? 10
    st.addRangeAt(dur * 0.12)
    st.markOut(dur * 0.3)
    st.addRangeAt(dur * 0.5)
    st.markOut(dur * 0.68)
    const first = [...useStore.getState().ranges].sort((a, b) => a.start - b.start)[0]
    if (first) st.selectRange(first.id)
  }

  switch (scenario) {
    case 'home':
      break
    case 'cut':
      await openTest()
      addRanges()
      break
    case 'cut-remove':
      await openTest()
      addRanges()
      useStore.getState().setCutMode('remove')
      break
    case 'subs':
      await openTest()
      useStore.getState().setWorkspace('subtitles')
      break
    case 'subs-transcript':
      await openTest()
      useStore.getState().setWorkspace('subtitles')
      useStore.getState().setSegments(FAKE_SEGMENTS)
      useStore.setState({ detectedLang: 'en', usedModelId: 'small' })
      break
    case 'style':
      await openTest()
      useStore.getState().setWorkspace('subtitles')
      useStore.getState().setSegments(FAKE_SEGMENTS)
      useStore.getState().openDialog({ kind: 'style' })
      break
    case 'merge':
      useStore.getState().setWorkspace('merge')
      if (testVideo) await useStore.getState().mergeAddPaths([testVideo])
      break
    case 'export':
      await openTest()
      addRanges()
      useStore.getState().openDialog({ kind: 'export-cut' })
      break
    case 'settings':
      useStore.getState().openDialog({ kind: 'settings' })
      break
    case 'palette':
      await openTest()
      addRanges()
      useStore.setState({ paletteOpen: true })
      break
    case 'subs-bilingual':
      await openTest()
      useStore.getState().setWorkspace('subtitles')
      useStore.getState().setSegments(FAKE_SEGMENTS.map((seg, i) => ({
        ...seg,
        translation: ['مرحبًا بكم في لالوكِت — تحرير دقيق للجميع.',
          'This is an English translation of the Arabic test line.',
          'تُنشأ الترجمة محليًا باستخدام Whisper.',
          'حرر أي سطر ثم صدّر SRT أو ادمجه في الصورة.'][i]
      })))
      useStore.setState({ detectedLang: 'ja', usedModelId: 'large-v3-turbo', subsViewMode: 'both', cleanedCount: 3 })
      break
    case 'settings-translation':
      useStore.getState().openDialog({ kind: 'settings', tab: 'translation' })
      break
    case 'light':
      s.patchSettings({ theme: 'light' })
      await openTest()
      addRanges()
      break
    case 'rtl':
      s.patchSettings({ locale: 'ar' })
      await openTest()
      addRanges()
      useStore.getState().setWorkspace('subtitles')
      useStore.getState().setSegments(FAKE_SEGMENTS)
      break
    // Full pipeline through the app's IPC + job system: real cut export.
    case 'do-export': {
      await openTest()
      addRanges()
      const st = useStore.getState()
      if (!st.media || !testVideo) break
      const out = testVideo.replace(/assets([\\/])[^\\/]+$/, 'out$1smoke-cut.mp4')
      await window.lalu.cut.export({
        inputPath: st.media.path,
        ranges: st.ranges.map((r) => ({ start: r.start, end: r.end })),
        mode: 'keep',
        engine: 'exact',
        quality: 'fast',
        useHardware: false,
        outputPath: out
      })
      await waitFor(
        () => Object.values(useStore.getState().jobs).some((j) => j.kind === 'cut' && j.state === 'done'),
        30000
      )
      break
    }
    // Full pipeline: real whisper transcription via the subtitles workspace.
    case 'do-transcribe': {
      await openTest()
      useStore.getState().setWorkspace('subtitles')
      useStore.getState().setSubsOption({ lastModelId: 'tiny', lastLanguage: 'auto', lastTranslate: false })
      await useStore.getState().refreshModels()
      await useStore.getState().startTranscribe()
      await waitFor(() => useStore.getState().segments.length > 0, 60000)
      break
    }
    default:
      break
  }
}
