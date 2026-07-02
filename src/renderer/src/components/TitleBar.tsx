import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { FolderOpen, Keyboard, Languages, Moon, Settings, Sun, Scissors, Layers, Captions } from 'lucide-react'
import { useStore, type Workspace } from '@/state/store'
import { useT } from '@/i18n'
import { IconButton } from '@/ui/primitives'
import { Logo } from './Logo'

const TABS: { id: Workspace; icon: typeof Scissors; key: 'tab.cut' | 'tab.merge' | 'tab.subtitles' }[] = [
  { id: 'cut', icon: Scissors, key: 'tab.cut' },
  { id: 'merge', icon: Layers, key: 'tab.merge' },
  { id: 'subtitles', icon: Captions, key: 'tab.subtitles' }
]

export function TitleBar(): ReactNode {
  const t = useT()
  const workspace = useStore((s) => s.workspace)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const theme = useStore((s) => s.theme)
  const locale = useStore((s) => s.locale)
  const patchSettings = useStore((s) => s.patchSettings)
  const openDialog = useStore((s) => s.openDialog)
  const media = useStore((s) => s.media)
  const openFile = useStore((s) => s.openFile)

  const browse = async (): Promise<void> => {
    const paths = await window.lalu.system.chooseOpen(false)
    if (paths[0]) void openFile(paths[0])
  }

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <Logo size={21} />
        <span className="titlebar-name">{t('app.name')}</span>
        {media && <span className="titlebar-file" title={media.path}>{media.fileName}</span>}
      </div>

      <nav className="titlebar-tabs no-drag" aria-label="Workspace">
        {TABS.map(({ id, icon: Icon, key }) => (
          <button
            key={id}
            className={`ws-tab ${workspace === id ? 'is-on' : ''} ${id === 'subtitles' ? 'ws-tab-ai' : ''}`}
            onClick={() => setWorkspace(id)}
          >
            {workspace === id && (
              <motion.span
                layoutId="ws-tab-thumb"
                className="ws-tab-thumb"
                transition={{ type: 'spring', stiffness: 480, damping: 36 }}
              />
            )}
            <Icon size={14} />
            <span>{t(key)}</span>
          </button>
        ))}
      </nav>

      <div className="titlebar-actions no-drag">
        <IconButton label={t('titlebar.openFile')} onClick={() => void browse()}>
          <FolderOpen size={16} />
        </IconButton>
        <IconButton label={t('titlebar.language')} onClick={() => patchSettings({ locale: locale === 'en' ? 'ar' : 'en' })}>
          <Languages size={16} />
        </IconButton>
        <IconButton
          data-testid="btn-theme"
          label={theme === 'dark' ? t('titlebar.theme.dark') : t('titlebar.theme.light')}
          onClick={() => patchSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
        <IconButton label={t('titlebar.shortcuts')} onClick={() => openDialog({ kind: 'shortcuts' })}>
          <Keyboard size={16} />
        </IconButton>
        <IconButton data-testid="btn-settings" label={t('titlebar.settings')} onClick={() => openDialog({ kind: 'settings' })}>
          <Settings size={16} />
        </IconButton>
        <div className="titlebar-wco-space" />
      </div>
    </header>
  )
}
