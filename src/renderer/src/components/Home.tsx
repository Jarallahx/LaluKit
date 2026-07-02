import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Captions, FilePlus2, Film, Layers, Scissors, Trash2, X, CheckCircle2, AlertTriangle, Music } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Button, IconButton } from '@/ui/primitives'
import { fmtDuration } from '@/lib/time'
import { Logo } from './Logo'
import type { RecentFile } from '@shared/types'

export function Home(): ReactNode {
  const t = useT()
  const openFile = useStore((s) => s.openFile)
  const recents = useStore((s) => s.recents)
  const sysInfo = useStore((s) => s.sysInfo)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const refreshRecents = useStore((s) => s.refreshRecents)

  useEffect(() => {
    void refreshRecents()
  }, [refreshRecents])

  const browse = async (): Promise<void> => {
    const paths = await window.lalu.system.chooseOpen(false)
    if (paths[0]) void openFile(paths[0])
  }

  const features = [
    { icon: Scissors, title: t('home.feature.cut.title'), sub: t('home.feature.cut.sub'), tone: 'accent', go: (): void => setWorkspace('cut') },
    { icon: Layers, title: t('home.feature.merge.title'), sub: t('home.feature.merge.sub'), tone: 'accent', go: (): void => setWorkspace('merge') },
    { icon: Captions, title: t('home.feature.subs.title'), sub: t('home.feature.subs.sub'), tone: 'ai', go: (): void => setWorkspace('subtitles') }
  ]

  return (
    <div className="home">
      <motion.div
        className="home-inner"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 0.0, 0.18, 1] }}
      >
        <div className="home-hero">
          <div className="home-mark"><Logo size={56} /></div>
          <h1 className="home-title">{t('app.name')}</h1>
          <p className="home-tagline">{t('app.tagline')}</p>
        </div>

        <button className="dropzone" onClick={() => void browse()}>
          <span className="dropzone-icon"><FilePlus2 size={26} strokeWidth={1.7} /></span>
          <span className="dropzone-title">{t('home.drop.title')}</span>
          <span className="dropzone-sub">{t('home.drop.sub')}</span>
        </button>

        <div className="home-features">
          {features.map((f, i) => (
            <motion.button
              key={f.title}
              className={`feature-card feature-${f.tone}`}
              onClick={f.go}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + i * 0.06, duration: 0.4, ease: [0.22, 0.0, 0.18, 1] }}
              whileHover={{ y: -3 }}
            >
              <span className="feature-icon"><f.icon size={18} strokeWidth={1.9} /></span>
              <span className="feature-title">{f.title}</span>
              <span className="feature-sub">{f.sub}</span>
            </motion.button>
          ))}
        </div>

        {recents.length > 0 && <RecentList recents={recents} />}

        <div className={`engine-chip ${sysInfo && !sysInfo.binsOk ? 'is-bad' : ''}`}>
          {sysInfo && !sysInfo.binsOk
            ? <><AlertTriangle size={13} /> {t('home.engines.missing')}</>
            : <><CheckCircle2 size={13} /> {t('home.engines.ok')}</>}
        </div>
      </motion.div>
    </div>
  )
}

function RecentList({ recents }: { recents: RecentFile[] }): ReactNode {
  const t = useT()
  const openFile = useStore((s) => s.openFile)
  const refreshRecents = useStore((s) => s.refreshRecents)
  const [missing, setMissing] = useState<string | null>(null)

  const open = async (r: RecentFile): Promise<void> => {
    if (await window.lalu.system.pathExists(r.path)) {
      void openFile(r.path)
    } else {
      setMissing(r.path)
      window.setTimeout(() => setMissing(null), 2200)
      await window.lalu.system.removeRecent(r.path)
      void refreshRecents()
    }
  }

  return (
    <div className="recents">
      <div className="recents-head">
        <span className="recents-title">{t('home.recent')}</span>
        <Button size="sm" variant="subtle" icon={<Trash2 size={12} />} onClick={() => { void window.lalu.system.clearRecents().then(() => void refreshRecents()) }}>
          {t('home.recent.clear')}
        </Button>
      </div>
      <div className="recents-row">
        {recents.slice(0, 8).map((r) => (
          <div key={r.path} className={`recent-card ${missing === r.path ? 'is-missing' : ''}`}>
            <button className="recent-main" onClick={() => void open(r)} title={r.path}>
              <span className={`recent-thumb ${r.thumbUrl ? 'has-img' : ''}`}>
                {r.thumbUrl
                  ? <img src={r.thumbUrl} alt="" />
                  : r.kind === 'audio' ? <Music size={16} /> : <Film size={16} />}
              </span>
              <span className="recent-name">{r.name}</span>
              <span className="recent-dur mono">{missing === r.path ? t('home.recent.missing') : fmtDuration(r.durationSec)}</span>
            </button>
            <IconButton
              label={t('home.recent.clear')}
              size="sm"
              className="recent-x"
              onClick={() => { void window.lalu.system.removeRecent(r.path).then(() => void refreshRecents()) }}
            >
              <X size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  )
}
