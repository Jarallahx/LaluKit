import { useEffect } from 'react'
import { useStore } from '@/state/store'
import { playerCtl } from '@/lib/player-ctl'

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

// Global shortcuts. Ctrl-combos (palette, undo, project) work everywhere;
// bare editing keys need media loaded, no open modal, focus outside inputs.
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const lower = e.key.toLowerCase()

      // App-wide chords
      if ((e.ctrlKey || e.metaKey) && !isTyping(e)) {
        switch (lower) {
          case 'k':
            e.preventDefault()
            s.setPaletteOpen(!s.paletteOpen)
            return
          case 'z':
            e.preventDefault()
            if (e.shiftKey) s.redo()
            else s.undo()
            return
          case 'y':
            e.preventDefault()
            s.redo()
            return
          case 's':
            e.preventDefault()
            void s.saveProjectAs()
            return
          case 'o':
            e.preventDefault()
            void window.lalu.system.chooseOpen(false).then((paths) => {
              if (!paths[0]) return
              if (paths[0].toLowerCase().endsWith('.lalukit')) void s.openProject(paths[0])
              else void s.openFile(paths[0])
            })
            return
        }
      }

      if (!s.media || s.dialog !== null || s.paletteOpen || isTyping(e)) return
      const k = e.key

      const seek = (delta: number): void => {
        playerCtl.seek(playerCtl.currentTime + delta)
      }

      switch (true) {
        case k === ' ':
          e.preventDefault()
          playerCtl.toggle()
          break
        case lower === 'k':
          playerCtl.pause()
          break
        case lower === 'l':
          playerCtl.shuttleForward()
          break
        case lower === 'j':
          playerCtl.shuttleBack()
          break
        case k === 'ArrowLeft':
          e.preventDefault()
          seek(e.shiftKey ? -5 : -1)
          break
        case k === 'ArrowRight':
          e.preventDefault()
          seek(e.shiftKey ? 5 : 1)
          break
        case k === '[':
          playerCtl.stepFrames(-1)
          break
        case k === ']':
          playerCtl.stepFrames(1)
          break
        case k === 'Home':
          e.preventDefault()
          playerCtl.seek(0)
          break
        case k === 'End':
          e.preventDefault()
          playerCtl.seek(s.media.durationSec)
          break
        case lower === 'i':
          s.markIn(playerCtl.currentTime)
          break
        case lower === 'o':
          s.markOut(playerCtl.currentTime)
          break
        case lower === 'n':
          s.addRangeAt(playerCtl.currentTime)
          break
        case lower === 's':
          s.splitRangeAt(playerCtl.currentTime)
          break
        case k === 'Delete' || k === 'Backspace':
          s.removeSelectedRanges()
          break
        case lower === 'g':
          s.patchSettings({ snapping: !s.snapping })
          break
        case lower === 'm':
          s.patchSettings({ muted: !s.muted })
          break
        case k === '?':
          s.openDialog({ kind: 'shortcuts' })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
