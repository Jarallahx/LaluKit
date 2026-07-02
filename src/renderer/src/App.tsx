import { useEffect, type ReactNode } from 'react'
import { useStore, wireGlobalEvents } from '@/state/store'
import { useShortcuts } from '@/lib/use-shortcuts'
import { TitleBar } from '@/components/TitleBar'
import { Home } from '@/components/Home'
import { Player } from '@/components/player/Player'
import { Timeline } from '@/components/timeline/Timeline'
import { CutPanel } from '@/components/panels/CutPanel'
import { SubsPanel } from '@/components/panels/SubsPanel'
import { MergeWorkspace } from '@/components/merge/MergeWorkspace'
import { JobCenter } from '@/components/JobCenter'
import { DropOverlay } from '@/components/DropOverlay'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ExportCutDialog, ExportMergeDialog, AttachDialog, ConfirmDialogs } from '@/components/dialogs/ExportDialogs'
import { ExtractAudioDialog, GifDialog, ReverseDialog } from '@/components/dialogs/ExtrasDialogs'
import { StyleDialog } from '@/components/dialogs/StyleDialog'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { ShortcutsDialog } from '@/components/dialogs/ShortcutsDialog'
import { StatusBar } from '@/components/StatusBar'
import { CommandPalette } from '@/components/CommandPalette'
import { installSmokeHooks } from '@/smoke'

export function App(): ReactNode {
  const hydrated = useStore((s) => s.hydrated)
  const workspace = useStore((s) => s.workspace)
  const media = useStore((s) => s.media)

  useShortcuts()

  useEffect(() => {
    wireGlobalEvents()
    installSmokeHooks()
    void useStore.getState().hydrate().then(() => {
      void useStore.getState().offerRecovery()
    })
  }, [])

  // Crash-recovery autosave every 60s while something is worth keeping.
  useEffect(() => {
    const id = window.setInterval(() => {
      void useStore.getState().autosaveNow()
    }, 60_000)
    return () => window.clearInterval(id)
  }, [])

  if (!hydrated) return <div className="app-main" />

  return (
    <ErrorBoundary>
      <TitleBar />
      <main className="app-main">
        {workspace === 'merge' ? (
          <MergeWorkspace />
        ) : media ? (
          <div className="editor">
            <div className="editor-stage-col">
              <Player />
            </div>
            <aside className="editor-side">
              {workspace === 'cut' ? <CutPanel /> : <SubsPanel />}
            </aside>
            <div className="editor-timeline">
              <Timeline />
            </div>
          </div>
        ) : (
          <Home />
        )}
      </main>
      <StatusBar />
      <JobCenter />
      <DropOverlay />
      <CommandPalette />
      <ExportCutDialog />
      <ExportMergeDialog />
      <AttachDialog />
      <ExtractAudioDialog />
      <GifDialog />
      <ReverseDialog />
      <StyleDialog />
      <SettingsDialog />
      <ShortcutsDialog />
      <ConfirmDialogs />
    </ErrorBoundary>
  )
}
