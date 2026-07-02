import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, Info, KeyRound, Languages, Palette, PlugZap, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Button, Field, Modal, SearchSelect, Segmented, Spinner, Toggle } from '@/ui/primitives'
import { fmtBytes } from '@/lib/time'
import { Logo } from '@/components/Logo'
import { WHISPER_LANGUAGES, type ApiProvider } from '@shared/types'

type Tab = 'general' | 'export' | 'subtitles' | 'translation' | 'storage' | 'about'

const PROVIDERS: { id: ApiProvider | 'nllb'; descKey: string }[] = [
  { id: 'claude', descKey: 'tr.backend.claude' },
  { id: 'openai', descKey: 'tr.backend.openai' },
  { id: 'deepl', descKey: 'tr.backend.deepl' },
  { id: 'google', descKey: 'tr.backend.google' },
  { id: 'nllb', descKey: 'tr.backend.nllb' }
]

const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']
const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini']

function TranslationTab(): ReactNode {
  const t = useT()
  const translate = useStore((s) => s.translate)
  const patchSettings = useStore((s) => s.patchSettings)
  const apiKeysState = useStore((s) => s.apiKeysState)
  const refreshApiKeys = useStore((s) => s.refreshApiKeys)
  const [keyInput, setKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; sample?: string } | null>(null)

  useEffect(() => {
    void refreshApiKeys()
  }, [refreshApiKeys])

  useEffect(() => {
    setKeyInput('')
    setTestResult(null)
  }, [translate.backend])

  const backend = translate.backend
  const isApi = backend !== 'nllb'
  const hasKey = isApi && !!apiKeysState?.[backend]

  const saveKey = async (): Promise<void> => {
    if (!isApi || keyInput.trim() === '') return
    await window.lalu.translate.setKey(backend, keyInput.trim())
    setKeyInput('')
    void refreshApiKeys()
  }

  const clearKey = async (): Promise<void> => {
    if (!isApi) return
    await window.lalu.translate.setKey(backend, null)
    setTestResult(null)
    void refreshApiKeys()
  }

  const test = async (): Promise<void> => {
    if (!isApi) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.lalu.translate.test(backend))
    } finally {
      setTesting(false)
    }
  }

  const langOptions = WHISPER_LANGUAGES.filter(([c]) => c !== 'auto').map(([code, name]) => ({ value: code, label: name }))

  return (
    <>
      <Field label={t('tr.backend')}>
        <div className="tr-backends">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`tr-backend ${backend === p.id ? 'is-on' : ''}`}
              onClick={() => patchSettings({ translate: { ...translate, backend: p.id } })}
            >
              <span className="model-radio">{backend === p.id && <span className="model-radio-dot" />}</span>
              <span className="tr-backend-desc">{t(p.descKey as never)}</span>
              {p.id !== 'nllb' && apiKeysState?.[p.id] && <span className="chip chip-ok"><KeyRound size={9} /></span>}
            </button>
          ))}
        </div>
      </Field>

      {isApi ? (
        <>
          <Field label={t('tr.apiKey')} hint={t(`tr.keyHelp.${backend}` as never)}>
            <div className="output-row">
              <input
                className="text-input"
                type="password"
                dir="ltr"
                placeholder={hasKey ? '••••••••••••' : t('tr.apiKey.placeholder')}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <Button size="sm" variant="primary" disabled={keyInput.trim() === ''} onClick={() => void saveKey()}>
                {t('tr.apiKey.save')}
              </Button>
              {hasKey && (
                <Button size="sm" variant="danger" onClick={() => void clearKey()}>{t('tr.apiKey.clear')}</Button>
              )}
            </div>
            <p className="panel-note">{hasKey ? t('tr.apiKey.set') : t('tr.apiKey.none')}</p>
          </Field>
          {backend === 'claude' && (
            <Field label={t('tr.model')}>
              <SearchSelect
                value={translate.claudeModel}
                options={CLAUDE_MODELS.map((m) => ({ value: m, label: m }))}
                onChange={(v) => patchSettings({ translate: { ...translate, claudeModel: v } })}
                width={260}
              />
            </Field>
          )}
          {backend === 'openai' && (
            <Field label={t('tr.model')}>
              <SearchSelect
                value={translate.openaiModel}
                options={OPENAI_MODELS.map((m) => ({ value: m, label: m }))}
                onChange={(v) => patchSettings({ translate: { ...translate, openaiModel: v } })}
                width={260}
              />
            </Field>
          )}
          <div className="tr-test-row">
            <Button size="sm" variant="ghost" disabled={!hasKey || testing} icon={testing ? <Spinner size={12} /> : <PlugZap size={13} />} onClick={() => void test()}>
              {testing ? t('tr.testing') : t('tr.test')}
            </Button>
            {testResult && (
              <span className={`tr-test-result ${testResult.ok ? 'is-ok' : 'is-bad'}`} dir="auto">
                {testResult.ok ? t('tr.test.ok', { sample: testResult.sample ?? '' }) : testResult.message}
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="panel-note">{t('tr.nllb.note')}</p>
      )}

      <Field label={t('tr.targetLang')}>
        <SearchSelect
          value={translate.targetLang}
          options={langOptions}
          onChange={(v) => patchSettings({ translate: { ...translate, targetLang: v } })}
          placeholder={t('subs.language.search')}
          width={236}
        />
      </Field>

      <p className="panel-note"><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> {t('tr.privacy')}</p>
    </>
  )
}

export function SettingsDialog(): ReactNode {
  const t = useT()
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const theme = useStore((s) => s.theme)
  const locale = useStore((s) => s.locale)
  const quality = useStore((s) => s.quality)
  const useHardware = useStore((s) => s.useHardware)
  const exportDir = useStore((s) => s.exportDir)
  const sysInfo = useStore((s) => s.sysInfo)
  const models = useStore((s) => s.models)
  const patchSettings = useStore((s) => s.patchSettings)
  const refreshModels = useStore((s) => s.refreshModels)

  const open = dialog?.kind === 'settings'
  const requestedTab = dialog?.kind === 'settings' ? dialog.tab : undefined
  const [tab, setTab] = useState<Tab>('general')
  const [cacheSize, setCacheSize] = useState<number | null>(null)

  useEffect(() => {
    if (open) {
      setTab((requestedTab as Tab) ?? 'general')
      setCacheSize(sysInfo?.cacheSizeBytes ?? null)
      void refreshModels()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: t('settings.general') },
    { id: 'export', label: t('settings.export') },
    { id: 'subtitles', label: t('settings.subtitles') },
    { id: 'translation', label: t('settings.translation') },
    { id: 'storage', label: t('settings.storage') },
    { id: 'about', label: t('settings.about') }
  ]

  const installedModels = (models?.catalog ?? []).filter((m) => models?.installed.includes(m.id))

  return (
    <Modal open={open} onClose={closeDialog} title={t('settings.title')} width={620}>
      <div className="settings">
        <nav className="settings-nav">
          {tabs.map((x) => (
            <button key={x.id} className={`settings-tab ${tab === x.id ? 'is-on' : ''}`} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === 'general' && (
            <>
              <Field label={<><Palette size={12} style={{ verticalAlign: -2 }} /> {t('settings.theme')}</>}>
                <Segmented
                  value={theme}
                  onChange={(v) => patchSettings({ theme: v })}
                  options={[
                    { value: 'dark', label: t('settings.theme.dark') },
                    { value: 'light', label: t('settings.theme.light') }
                  ]}
                />
              </Field>
              <Field label={<><Languages size={12} style={{ verticalAlign: -2 }} /> {t('settings.language')}</>}>
                <Segmented
                  value={locale}
                  onChange={(v) => patchSettings({ locale: v })}
                  options={[
                    { value: 'en', label: 'English' },
                    { value: 'ar', label: 'العربية' }
                  ]}
                />
              </Field>
            </>
          )}

          {tab === 'export' && (
            <>
              <Field label={<><Save size={12} style={{ verticalAlign: -2 }} /> {t('settings.defaultQuality')}</>}>
                <Segmented
                  value={quality}
                  onChange={(v) => patchSettings({ quality: v })}
                  options={[
                    { value: 'best', label: t('export.quality.best') },
                    { value: 'balanced', label: t('export.quality.balanced') },
                    { value: 'fast', label: t('export.quality.fast') }
                  ]}
                />
              </Field>
              <Field
                row
                label={t('settings.hw')}
                hint={sysInfo && sysInfo.hwEncoders.length > 0
                  ? t('settings.hw.detected', { list: sysInfo.hwEncoders.map((e) => e.toUpperCase()).join(', ') })
                  : t('settings.hw.none')}
              >
                <Toggle
                  checked={useHardware}
                  disabled={!sysInfo || sysInfo.hwEncoders.length === 0}
                  onChange={(v) => patchSettings({ useHardware: v })}
                  label={t('settings.hw')}
                />
              </Field>
              <Field label={t('settings.exportDir')}>
                <div className="output-row">
                  <span className="output-path mono" dir="ltr">{exportDir ?? t('settings.exportDir.same')}</span>
                  <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => {
                    void window.lalu.system.chooseDir().then((dir) => {
                      if (dir) patchSettings({ exportDir: dir })
                    })
                  }}>
                    {t('settings.exportDir.choose')}
                  </Button>
                  {exportDir && (
                    <Button size="sm" variant="subtle" onClick={() => patchSettings({ exportDir: null })}>
                      {t('settings.exportDir.reset')}
                    </Button>
                  )}
                </div>
              </Field>
            </>
          )}

          {tab === 'subtitles' && (
            <>
              <Field label={t('settings.models.title')}>
                {installedModels.length === 0 ? (
                  <p className="panel-note">{t('settings.models.none')}</p>
                ) : (
                  <div className="settings-models">
                    {installedModels.map((m) => (
                      <div key={m.id} className="settings-model-row">
                        <span className="settings-model-name">{m.label}</span>
                        <span className="muted mono">{t('subs.model.size', { mb: m.sizeMB })}</span>
                        <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => {
                          void window.lalu.subs.deleteModel(m.id).then(() => void refreshModels())
                        }}>
                          {t('settings.models.delete')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Field>
              <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => {
                if (sysInfo) void window.lalu.system.openPath(sysInfo.modelsDir)
              }}>
                {t('settings.models.folder')}
              </Button>
            </>
          )}

          {tab === 'translation' && <TranslationTab />}

          {tab === 'storage' && (
            <>
              <Field label={t('settings.cache')} hint={t('settings.cache.desc')}>
                <div className="output-row">
                  <span className="muted">{t('settings.cache.size', { size: cacheSize !== null ? fmtBytes(cacheSize) : '…' })}</span>
                  <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => {
                    void window.lalu.system.clearCache().then(setCacheSize)
                  }}>
                    {t('settings.cache.clear')}
                  </Button>
                </div>
              </Field>
            </>
          )}

          {tab === 'about' && (
            <div className="about">
              <div className="about-head">
                <Logo size={40} />
                <div>
                  <div className="about-name">{t('app.name')} <span className="mono muted">v{sysInfo?.version ?? '1.0.0'}</span></div>
                  <div className="muted">{t('settings.about.line')}</div>
                </div>
              </div>
              <p className="panel-note"><Info size={12} style={{ verticalAlign: -2 }} /> {t('settings.about.privacy')}</p>
              <p className="panel-note">{t('settings.about.engines')}</p>
              <Button size="sm" variant="ghost" onClick={() => void window.lalu.system.openLog()}>
                {t('settings.openLog')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
