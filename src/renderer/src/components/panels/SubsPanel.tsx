import { useMemo, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle, AudioWaveform, Captions, Check, Download, FileDown, Flame,
  Languages as LangIcon, Layers2, MicOff, Paintbrush, RotateCcw, Sparkles, Star,
  Timer, X
} from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { Button, Dots, IconButton, ProgressBar, SearchSelect, Segmented, Spinner, Toggle } from '@/ui/primitives'
import { fmtETA } from '@/lib/time'
import { langName } from '@/lib/lang-name'
import { hasAnyTranslation } from '@/lib/subs-compose'
import { WHISPER_LANGUAGES } from '@shared/types'
import { TranscriptList } from './TranscriptList'

export function SubsPanel(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const noAudio = useStore((s) => s.noAudio)
  const segments = useStore((s) => s.segments)
  const transcribeJobId = useStore((s) => s.transcribeJobId)

  if (!media) return null

  return (
    <div className="panel panel-ai">
      <div className="panel-head">
        <span className="panel-title"><Sparkles size={14} /> {t('subs.title')}</span>
      </div>
      {noAudio ? (
        <div className="subs-noaudio">
          <MicOff size={28} strokeWidth={1.5} />
          <span className="ranges-empty-title">{t('subs.noAudio.title')}</span>
          <span className="ranges-empty-sub">{t('subs.noAudio.sub')}</span>
        </div>
      ) : transcribeJobId ? (
        <TranscribingView jobId={transcribeJobId} />
      ) : segments.length > 0 ? (
        <TranscriptView />
      ) : (
        <SetupView />
      )}
    </div>
  )
}

// ---------- setup ----------

function SetupView(): ReactNode {
  const t = useT()
  const models = useStore((s) => s.models)
  const modelId = useStore((s) => s.lastModelId)
  const language = useStore((s) => s.lastLanguage)
  const translate = useStore((s) => s.lastTranslate)
  const vadEnabled = useStore((s) => s.vadEnabled)
  const preciseTiming = useStore((s) => s.preciseTiming)
  const patchSettings = useStore((s) => s.patchSettings)
  const audioTrack = useStore((s) => s.subsAudioTrack)
  const media = useStore((s) => s.media)
  const setSubsOption = useStore((s) => s.setSubsOption)
  const startTranscribe = useStore((s) => s.startTranscribe)
  const downloadJobId = useStore((s) => s.downloadJobId)
  const jobs = useStore((s) => s.jobs)

  const dlJob = downloadJobId ? jobs[downloadJobId] : null
  const installed = models?.installed ?? []
  const catalog = models?.catalog ?? []
  const selected = catalog.find((m) => m.id === modelId)
  const isInstalled = installed.includes(modelId)

  const langOptions = useMemo(
    () => WHISPER_LANGUAGES.map(([code, name]) => ({ value: code, label: code === 'auto' ? `✦ ${name}` : name })),
    []
  )

  return (
    <div className="panel-scroll subs-setup">
      <p className="panel-note subs-lead">{t('subs.setup.lead')}</p>

      <div className="panel-section">
        <span className="panel-label">{t('subs.model')}</span>
        <div className="model-list">
          {catalog.map((m) => {
            const on = m.id === modelId
            const have = installed.includes(m.id)
            return (
              <button
                key={m.id}
                className={`model-row ${on ? 'is-on' : ''}`}
                onClick={() => setSubsOption({ lastModelId: m.id })}
              >
                <span className="model-radio">{on && <span className="model-radio-dot" />}</span>
                <span className="model-main">
                  <span className="model-name">
                    {m.label}
                    {m.recommended && <span className="model-star" title={t('subs.model.recommended')}><Star size={10} fill="currentColor" /></span>}
                  </span>
                  <span className="model-meta">
                    <span>{t('subs.model.size', { mb: m.sizeMB })}</span>
                    <span>·</span>
                    <span>{t('subs.model.ram', { gb: m.ramGB })}</span>
                    <span>·</span>
                    <span>{m.multilingual ? t('subs.model.multilingual') : t('subs.model.enOnly')}</span>
                  </span>
                </span>
                <span className="model-ratings">
                  <span className="model-rating" title={t('subs.model.speed')}><Dots n={m.speed} tone="ai" /></span>
                  <span className="model-rating" title={t('subs.model.quality')}><Dots n={m.quality} tone="accent" /></span>
                </span>
                <span className={`model-state ${have ? 'is-have' : ''}`} title={have ? t('subs.model.installed') : t('subs.model.notInstalled')}>
                  {have ? <Check size={13} /> : <Download size={13} />}
                </span>
              </button>
            )
          })}
        </div>
        <p className="panel-note">{t('subs.model.guide')}</p>
      </div>

      <div className="panel-section">
        <span className="panel-label">{t('subs.language')}</span>
        <SearchSelect
          value={language}
          options={langOptions}
          onChange={(v) => setSubsOption({ lastLanguage: v })}
          placeholder={t('subs.language.search')}
          width={236}
        />
      </div>

      {(media?.audioTracks.length ?? 0) > 1 && (
        <div className="panel-section">
          <span className="panel-label">{t('subs.audioTrack')}</span>
          <SearchSelect
            value={String(audioTrack)}
            options={media!.audioTracks.map((a) => ({
              value: String(a.index),
              label: `${t('subs.track.n', { n: a.index + 1 })} — ${a.codec}${a.lang ? ` (${a.lang})` : ''}`
            }))}
            onChange={(v) => setSubsOption({ subsAudioTrack: Number(v) })}
            width={236}
          />
        </div>
      )}

      <div className="panel-section">
        <div className="panel-label-row">
          <span className="panel-label"><AudioWaveform size={12} style={{ verticalAlign: -2 }} /> {t('subs.vad')}</span>
          <Toggle checked={vadEnabled} onChange={(v) => patchSettings({ vadEnabled: v })} label={t('subs.vad')} />
        </div>
        <p className="panel-note">{t('subs.vad.hint')}</p>
      </div>

      <div className="panel-section">
        <div className="panel-label-row">
          <span className="panel-label"><Timer size={12} style={{ verticalAlign: -2 }} /> {t('subs.precise')}</span>
          <Toggle checked={preciseTiming} onChange={(v) => patchSettings({ preciseTiming: v })} label={t('subs.precise')} />
        </div>
        <p className="panel-note">{t('subs.precise.hint')}</p>
      </div>

      <div className="panel-section">
        <div className="panel-label-row">
          <span className="panel-label"><LangIcon size={12} style={{ verticalAlign: -2 }} /> {t('subs.translate')}</span>
          <Toggle checked={translate} onChange={(v) => setSubsOption({ lastTranslate: v })} label={t('subs.translate')} />
        </div>
        {translate && <p className="panel-note">{t('subs.translate.hint')}</p>}
      </div>

      <div className="subs-cta">
        {dlJob && (dlJob.state === 'running' || dlJob.state === 'queued') ? (
          <div className="subs-dl">
            <div className="subs-dl-head">
              <span>{t('jobs.kind.model-download')} — {selected?.label}</span>
              <span className="mono muted">{dlJob.detail ?? ''} {dlJob.etaSec != null ? `· ${fmtETA(dlJob.etaSec)}` : ''}</span>
            </div>
            <ProgressBar value={dlJob.progress} tone="ai" />
            <Button size="sm" variant="subtle" onClick={() => useStore.getState().cancelJob(dlJob.id)}>{t('jobs.cancel')}</Button>
          </div>
        ) : (
          <Button variant="ai" size="lg" icon={<Sparkles size={15} />} onClick={() => void startTranscribe()}>
            {isInstalled ? t('subs.transcribe') : t('subs.downloadAndTranscribe', { mb: selected?.sizeMB ?? 0 })}
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------- transcribing ----------

function TranscribingView({ jobId }: { jobId: string }): ReactNode {
  const t = useT()
  const job = useStore((s) => s.jobs[jobId])
  const cancelJob = useStore((s) => s.cancelJob)
  return (
    <div className="subs-working">
      <motion.div
        className="subs-working-orb"
        animate={{ scale: [1, 1.12, 1], opacity: [0.85, 1, 0.85] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Sparkles size={26} />
      </motion.div>
      <span className="subs-working-title">{t('subs.transcribing')}</span>
      <span className="ranges-empty-sub">{t('subs.transcribing.sub')}</span>
      <div className="subs-skeleton" aria-hidden="true">
        <span className="subs-skeleton-line" style={{ width: '88%' }} />
        <span className="subs-skeleton-line" style={{ width: '64%' }} />
        <span className="subs-skeleton-line" style={{ width: '76%' }} />
      </div>
      <div className="subs-working-bar">
        <ProgressBar value={job?.progress ?? null} tone="ai" />
        <span className="mono muted subs-working-eta">
          {job?.progress != null ? `${Math.round((job.progress ?? 0) * 100)}%` : ''}
          {job?.etaSec != null ? ` · ${t('jobs.eta', { eta: fmtETA(job.etaSec) })}` : ''}
        </span>
      </div>
      <Button variant="subtle" onClick={() => cancelJob(jobId)}>{t('jobs.cancel')}</Button>
    </div>
  )
}

// ---------- transcript ----------

function TranscriptView(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const segments = useStore((s) => s.segments)
  const detectedLang = useStore((s) => s.detectedLang)
  const usedModelId = useStore((s) => s.usedModelId)
  const cleanedCount = useStore((s) => s.cleanedCount)
  const subsViewMode = useStore((s) => s.subsViewMode)
  const setSubsViewMode = useStore((s) => s.setSubsViewMode)
  const translateJobId = useStore((s) => s.translateJobId)
  const startTranslate = useStore((s) => s.startTranslate)
  const tightenJobId = useStore((s) => s.tightenJobId)
  const tightenTiming = useStore((s) => s.tightenTiming)
  const cancelJob = useStore((s) => s.cancelJob)
  const jobs = useStore((s) => s.jobs)
  const targetLang = useStore((s) => s.translate.targetLang)
  const openDialog = useStore((s) => s.openDialog)
  const exportSubtitles = useStore((s) => s.exportSubtitles)

  const detectedName = langName(detectedLang)
  const translated = hasAnyTranslation(segments)
  const trJob = translateJobId ? jobs[translateJobId] : null
  const exportFile = (format: 'srt' | 'vtt'): Promise<void> => exportSubtitles(format)

  return (
    <>
      <div className="subs-toolbar">
        <div className="subs-meta">
          <span className="chip chip-ai"><Captions size={11} /> {t('subs.segments', { n: segments.length })}</span>
          {detectedLang && <span className="chip">{t('subs.detected', { lang: detectedName })}</span>}
          {usedModelId && <span className="chip">{t('subs.model.chip', { model: usedModelId })}</span>}
          {cleanedCount > 0 && (
            <span className="chip chip-warn" title={t('subs.cleaned.hint')}>
              <AlertTriangle size={10} /> {t('subs.cleaned', { n: cleanedCount })}
            </span>
          )}
        </div>

        {trJob && (trJob.state === 'running' || trJob.state === 'queued') ? (
          <div className="subs-translating">
            <span className="subs-translating-label">
              {t('translate.translating', { detail: trJob.detail ?? '…' })}
              {trJob.etaSec != null && trJob.etaSec > 1 ? ` · ${fmtETA(trJob.etaSec)}` : ''}
            </span>
            <ProgressBar value={trJob.progress} tone="ai" />
            <IconButton label={t('jobs.cancel')} size="sm" onClick={() => cancelJob(trJob.id)}>
              <X size={12} />
            </IconButton>
          </div>
        ) : (
          <div className="subs-translate-row">
            <Button variant="ai" size="sm" icon={<LangIcon size={13} />} onClick={() => void startTranslate()}>
              {t('translate.button', { lang: langName(targetLang) })}
            </Button>
            {translated && (
              <Segmented
                size="sm"
                tone="ai"
                value={subsViewMode}
                onChange={setSubsViewMode}
                options={[
                  { value: 'original', label: t('translate.view.original') },
                  { value: 'translation', label: langName(targetLang) },
                  { value: 'both', label: t('translate.view.both') }
                ]}
              />
            )}
          </div>
        )}

        <div className="subs-actions">
          <Button size="sm" variant="ghost" icon={<FileDown size={13} />} onClick={() => void exportFile('srt')}>
            {t('subs.export.srt')}
          </Button>
          <Button size="sm" variant="ghost" icon={<FileDown size={13} />} onClick={() => void exportFile('vtt')}>
            {t('subs.export.vtt')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Paintbrush size={13} />} onClick={() => openDialog({ kind: 'style' })}>
            {t('subs.style')}
          </Button>
          {media?.kind === 'video' && (
            <>
              <Button size="sm" variant="ghost" icon={<Flame size={13} />} onClick={() => openDialog({ kind: 'style', thenBurn: true })}>
                {t('subs.burn')}
              </Button>
              <Button size="sm" variant="ghost" icon={<Layers2 size={13} />} onClick={() => openDialog({ kind: 'attach' })}>
                {t('subs.attach')}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={tightenJobId ? <Spinner size={12} /> : <Timer size={13} />}
            disabled={!!tightenJobId}
            onClick={() => void tightenTiming()}
          >
            {t('subs.tighten')}
          </Button>
          <Button size="sm" variant="subtle" icon={<RotateCcw size={13} />} onClick={() => openDialog({ kind: 'confirm-retranscribe' })}>
            {t('subs.retranscribe')}
          </Button>
        </div>
      </div>
      <TranscriptList />
    </>
  )
}
