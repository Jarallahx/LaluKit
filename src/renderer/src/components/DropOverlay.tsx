import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FileVideo, Layers, Sparkles } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'

// Window-level drag & drop. Multiple files (or dropping while in the merge
// workspace) land in the merge list; a single file opens as the source.
export function DropOverlay(): ReactNode {
  const t = useT()
  const workspace = useStore((s) => s.workspace)
  const [active, setActive] = useState(false)
  const [count, setCount] = useState(0)

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setCount(e.dataTransfer.items?.length ?? 1)
      setActive(true)
    }
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onOver = (e: DragEvent): void => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setActive(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      const paths = files
        .map((f) => window.lalu.system.pathForFile(f))
        .filter((p): p is string => !!p)
      if (paths.length === 0) return
      const s = useStore.getState()
      if (paths.length === 1 && paths[0].toLowerCase().endsWith('.lalukit')) {
        void s.openProject(paths[0])
      } else if (s.workspace === 'subtitles' && paths.length > 1) {
        void s.startBatch(paths)
      } else if (s.workspace === 'merge' || paths.length > 1) {
        if (s.workspace !== 'merge') s.setWorkspace('merge')
        void s.mergeAddPaths(paths)
      } else {
        void s.openFile(paths[0])
      }
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const toBatch = workspace === 'subtitles' && count > 1
  const toMerge = !toBatch && (workspace === 'merge' || count > 1)

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="drop-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="drop-overlay-edge" />
          <motion.div
            className="drop-overlay-box"
            initial={{ scale: 0.93 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          >
            {toBatch ? <Sparkles size={30} /> : toMerge ? <Layers size={30} /> : <FileVideo size={30} />}
            <span>{toBatch ? t('drop.batch', { n: count }) : toMerge ? t('drop.merge') : t('drop.single')}</span>
            {toMerge && count > 1 && <span className="muted" style={{ fontSize: 13 }}>{t('drop.multiHint', { n: count })}</span>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
