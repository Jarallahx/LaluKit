import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Captions, FileDown, FileUp, Film, Flame, FolderOpen, Image as ImageIcon, Keyboard,
  Languages, Layers, Magnet, Moon, Music, Redo2, RotateCcw, Save, Scissors,
  ScissorsLineDashed, Settings, Sparkles, SunMedium, Undo2
} from 'lucide-react'
import { useStore } from '@/state/store'
import { useT, type I18nKey } from '@/i18n'
import { playerCtl } from '@/lib/player-ctl'
import { Kbd } from '@/ui/primitives'

interface Command {
  id: string
  labelKey: I18nKey
  icon: typeof Scissors
  kbd?: string
  enabled: boolean
  run: () => void
}

// Light fuzzy match: every query char must appear in order.
function fuzzy(query: string, text: string): boolean {
  const q = query.toLowerCase().replace(/\s/g, '')
  const t = text.toLowerCase()
  let i = 0
  for (const c of t) {
    if (c === q[i]) i++
    if (i === q.length) return true
  }
  return q.length === 0
}

export function CommandPalette(): ReactNode {
  const t = useT()
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const media = useStore((s) => s.media)
  const segments = useStore((s) => s.segments)
  const ranges = useStore((s) => s.ranges)
  const past = useStore((s) => s.past)
  const future = useStore((s) => s.future)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      window.setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  const s = useStore.getState
  const commands: Command[] = useMemo(() => {
    const hasMedia = !!media
    const hasVideo = !!media?.video
    const hasSegs = segments.length > 0
    return [
      {
        id: 'open', labelKey: 'cmd.openFile', icon: FolderOpen, kbd: 'Ctrl+O', enabled: true,
        run: () => void window.lalu.system.chooseOpen(false).then((p) => { if (p[0]) void s().openFile(p[0]) })
      },
      { id: 'undo', labelKey: 'cmd.undo', icon: Undo2, kbd: 'Ctrl+Z', enabled: past.length > 0, run: () => s().undo() },
      { id: 'redo', labelKey: 'cmd.redo', icon: Redo2, kbd: 'Ctrl+Shift+Z', enabled: future.length > 0, run: () => s().redo() },
      { id: 'go-cut', labelKey: 'cmd.goCut', icon: Scissors, enabled: true, run: () => s().setWorkspace('cut') },
      { id: 'go-merge', labelKey: 'cmd.goMerge', icon: Layers, enabled: true, run: () => s().setWorkspace('merge') },
      { id: 'go-subs', labelKey: 'cmd.goSubtitles', icon: Captions, enabled: true, run: () => s().setWorkspace('subtitles') },
      { id: 'add-range', labelKey: 'cmd.addRange', icon: Film, kbd: 'N', enabled: hasMedia, run: () => s().addRangeAt(playerCtl.currentTime) },
      { id: 'split', labelKey: 'cmd.splitRange', icon: ScissorsLineDashed, kbd: 'S', enabled: hasMedia && ranges.length > 0, run: () => s().splitRangeAt(playerCtl.currentTime) },
      { id: 'export-cut', labelKey: 'cmd.exportCut', icon: FileDown, enabled: hasMedia && ranges.length > 0, run: () => s().openDialog({ kind: 'export-cut' }) },
      { id: 'transcribe', labelKey: 'cmd.transcribe', icon: Sparkles, enabled: hasMedia && !s().noAudio, run: () => { s().setWorkspace('subtitles'); void s().startTranscribe() } },
      { id: 'srt', labelKey: 'cmd.exportSrt', icon: FileDown, enabled: hasSegs, run: () => void s().exportSubtitles('srt') },
      { id: 'vtt', labelKey: 'cmd.exportVtt', icon: FileDown, enabled: hasSegs, run: () => void s().exportSubtitles('vtt') },
      { id: 'translate', labelKey: 'cmd.translate', icon: Languages, enabled: hasSegs, run: () => { s().setWorkspace('subtitles'); void s().startTranslate() } },
      { id: 'burn', labelKey: 'cmd.burnIn', icon: Flame, enabled: hasSegs && hasVideo, run: () => s().openDialog({ kind: 'style', thenBurn: true }) },
      { id: 'attach', labelKey: 'cmd.attach', icon: Captions, enabled: hasSegs && hasVideo, run: () => s().openDialog({ kind: 'attach' }) },
      { id: 'extract', labelKey: 'cmd.extractAudio', icon: Music, enabled: hasMedia && !s().noAudio, run: () => s().openDialog({ kind: 'extract-audio' }) },
      { id: 'gif', labelKey: 'cmd.exportGif', icon: ImageIcon, enabled: hasVideo, run: () => s().openDialog({ kind: 'gif' }) },
      { id: 'reverse', labelKey: 'cmd.reverse', icon: RotateCcw, enabled: hasMedia, run: () => s().openDialog({ kind: 'reverse' }) },
      { id: 'save-project', labelKey: 'cmd.saveProject', icon: Save, kbd: 'Ctrl+S', enabled: hasMedia, run: () => void s().saveProjectAs() },
      {
        id: 'open-project', labelKey: 'cmd.openProject', icon: FileUp, enabled: true,
        run: () => void window.lalu.system.chooseOpen(false).then((p) => { if (p[0]) void s().openProject(p[0]) })
      },
      { id: 'snap', labelKey: 'cmd.toggleSnapping', icon: Magnet, kbd: 'G', enabled: true, run: () => s().patchSettings({ snapping: !s().snapping }) },
      {
        id: 'theme', labelKey: 'cmd.toggleTheme', icon: s().theme === 'dark' ? SunMedium : Moon, enabled: true,
        run: () => s().patchSettings({ theme: s().theme === 'dark' ? 'light' : 'dark' })
      },
      { id: 'lang', labelKey: 'cmd.toggleLanguage', icon: Languages, enabled: true, run: () => s().patchSettings({ locale: s().locale === 'en' ? 'ar' : 'en' }) },
      { id: 'settings', labelKey: 'cmd.settings', icon: Settings, enabled: true, run: () => s().openDialog({ kind: 'settings' }) },
      { id: 'shortcuts', labelKey: 'cmd.shortcuts', icon: Keyboard, kbd: '?', enabled: true, run: () => s().openDialog({ kind: 'shortcuts' }) },
      { id: 'log', labelKey: 'cmd.openLog', icon: FileUp, enabled: true, run: () => void window.lalu.system.openLog() }
    ]
  }, [media, segments.length, ranges.length, past.length, future.length, s])

  const filtered = commands.filter((c) => c.enabled && fuzzy(query, t(c.labelKey)))
  const sel = Math.min(index, Math.max(0, filtered.length - 1))

  useEffect(() => {
    const el = listRef.current?.querySelector('.palette-item.is-on')
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel, query])

  const runSelected = (): void => {
    const cmd = filtered[sel]
    if (!cmd) return
    setOpen(false)
    cmd.run()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
        >
          <motion.div
            className="palette"
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.1 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <input
              ref={inputRef}
              className="palette-input"
              placeholder={t('palette.placeholder')}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
                if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
                if (e.key === 'Enter') runSelected()
              }}
            />
            <div className="palette-list" ref={listRef}>
              {filtered.map((c, i) => (
                <button
                  key={c.id}
                  className={`palette-item ${i === sel ? 'is-on' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={runSelected}
                >
                  <c.icon size={14} className="palette-icon" />
                  <span className="palette-label">{t(c.labelKey)}</span>
                  {c.kbd && <Kbd>{c.kbd}</Kbd>}
                </button>
              ))}
              {filtered.length === 0 && <div className="palette-empty">{t('palette.empty')}</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
