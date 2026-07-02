import type { ReactNode } from 'react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Kbd, Modal } from '@/ui/primitives'

export function ShortcutsDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)

  const sections: { title: string; rows: { keys: string[]; desc: string }[] }[] = [
    {
      title: t('shortcuts.playback'),
      rows: [
        { keys: ['Space'], desc: t('shortcuts.space') },
        { keys: ['J', 'K', 'L'], desc: t('shortcuts.jkl') },
        { keys: ['←', '→'], desc: t('shortcuts.arrows') },
        { keys: ['[', ']'], desc: t('shortcuts.frames') },
        { keys: ['Home', 'End'], desc: t('shortcuts.homeEnd') }
      ]
    },
    {
      title: t('shortcuts.marking'),
      rows: [
        { keys: ['I', 'O'], desc: t('shortcuts.io') },
        { keys: ['N'], desc: t('shortcuts.n') },
        { keys: ['S'], desc: t('shortcuts.split') },
        { keys: ['Shift', 'Click'], desc: t('shortcuts.multiselect') },
        { keys: ['Del'], desc: t('shortcuts.del') }
      ]
    },
    {
      title: t('shortcuts.other'),
      rows: [
        { keys: ['Ctrl', 'K'], desc: t('shortcuts.palette') },
        { keys: ['Ctrl', 'Z'], desc: t('shortcuts.undo') },
        { keys: ['Ctrl', 'S'], desc: t('shortcuts.project') },
        { keys: ['G'], desc: t('shortcuts.snap') },
        { keys: ['M'], desc: t('shortcuts.m') },
        { keys: ['?'], desc: t('shortcuts.question') }
      ]
    }
  ]

  return (
    <Modal open={dialog?.kind === 'shortcuts'} onClose={closeDialog} title={t('shortcuts.title')} width={460}>
      <div className="shortcuts">
        {sections.map((sec) => (
          <div key={sec.title} className="shortcuts-section">
            <span className="panel-label">{sec.title}</span>
            {sec.rows.map((row) => (
              <div key={row.desc} className="shortcuts-row">
                <span className="shortcuts-keys force-ltr">
                  {row.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
                </span>
                <span className="shortcuts-desc">{row.desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
