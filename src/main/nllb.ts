import path from 'node:path'
import { app } from 'electron'
import log from './logger'
import { CancelledError, err } from './engine/errors'
import type { ProgressFn } from './engine/util'
import type { SubtitleSegment, TranslateRunResult } from '@shared/types'

// Offline translation: NLLB-200 distilled 600M via transformers.js
// (onnxruntime). The model (~600 MB quantized) downloads to userData on first
// use with progress; afterwards everything runs locally on the CPU.

// whisper ISO codes -> NLLB FLORES-200 codes (common languages; english fallback).
const FLORES: Record<string, string> = {
  en: 'eng_Latn', ar: 'arb_Arab', ja: 'jpn_Jpan', zh: 'zho_Hans', yue: 'yue_Hant',
  ko: 'kor_Hang', fr: 'fra_Latn', de: 'deu_Latn', es: 'spa_Latn', ru: 'rus_Cyrl',
  tr: 'tur_Latn', hi: 'hin_Deva', pt: 'por_Latn', it: 'ita_Latn', id: 'ind_Latn',
  fa: 'pes_Arab', ur: 'urd_Arab', he: 'heb_Hebr', vi: 'vie_Latn', th: 'tha_Thai',
  nl: 'nld_Latn', pl: 'pol_Latn', sv: 'swe_Latn', uk: 'ukr_Cyrl', el: 'ell_Grek',
  cs: 'ces_Latn', ro: 'ron_Latn', hu: 'hun_Latn', fi: 'fin_Latn', da: 'dan_Latn',
  no: 'nob_Latn', ms: 'zsm_Latn', bn: 'ben_Beng', ta: 'tam_Taml', te: 'tel_Telu',
  ml: 'mal_Mlym', kn: 'kan_Knda', mr: 'mar_Deva', gu: 'guj_Gujr', pa: 'pan_Guru',
  sw: 'swh_Latn', am: 'amh_Ethi', so: 'som_Latn', ha: 'hau_Latn', yo: 'yor_Latn',
  az: 'azj_Latn', kk: 'kaz_Cyrl', uz: 'uzn_Latn', sr: 'srp_Cyrl', hr: 'hrv_Latn',
  bg: 'bul_Cyrl', sk: 'slk_Latn', sl: 'slv_Latn', lt: 'lit_Latn', lv: 'lvs_Latn',
  et: 'est_Latn', ka: 'kat_Geor', hy: 'hye_Armn', ne: 'npi_Deva', si: 'sin_Sinh',
  km: 'khm_Khmr', lo: 'lao_Laoo', my: 'mya_Mymr', tl: 'tgl_Latn', sq: 'als_Latn',
  mk: 'mkd_Cyrl', bs: 'bos_Latn', ca: 'cat_Latn', gl: 'glg_Latn', eu: 'eus_Latn',
  is: 'isl_Latn', mt: 'mlt_Latn', cy: 'cym_Latn', af: 'afr_Latn', ps: 'pbt_Arab'
}

export function floresCode(iso: string | null | undefined): string {
  return FLORES[(iso ?? 'en').toLowerCase()] ?? 'eng_Latn'
}

export function nllbModelsDir(): string {
  return path.join(app.getPath('userData'), 'models', 'nllb-cache')
}

type Translator = (text: string, opts: { src_lang: string; tgt_lang: string }) => Promise<{ translation_text: string }[]>

let pipelinePromise: Promise<Translator> | null = null

async function getTranslator(onProgress?: ProgressFn): Promise<Translator> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Lazy import: keeps onnxruntime out of the startup path entirely.
      const tf = await import('@huggingface/transformers')
      tf.env.cacheDir = nllbModelsDir()
      const downloads = new Map<string, number>()
      const pipe = await tf.pipeline('translation', 'Xenova/nllb-200-distilled-600M', {
        dtype: 'q8',
        progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
          // Model download maps onto the first 60% of the job bar.
          if (p.status === 'progress' && p.file && typeof p.progress === 'number') {
            downloads.set(p.file, p.progress)
            const avg = [...downloads.values()].reduce((a, b) => a + b, 0) / downloads.size
            onProgress?.((avg / 100) * 0.6, null, `model ${Math.round(avg)}%`)
          }
        }
      })
      log.info('[nllb] pipeline ready')
      return pipe as unknown as Translator
    })().catch((e) => {
      pipelinePromise = null
      throw e
    })
  }
  return pipelinePromise
}

export async function nllbTranslateAll(
  segments: SubtitleSegment[],
  sourceIso: string | null,
  targetIso: string,
  signal?: AbortSignal,
  onProgress?: ProgressFn
): Promise<TranslateRunResult> {
  const todo = segments.filter((s) => s.text.trim().length > 0)
  let translator: Translator
  try {
    translator = await getTranslator(onProgress)
  } catch (e) {
    log.error('[nllb] pipeline init failed:', e)
    throw err(
      'nllb-init',
      'The offline translation model could not be loaded.',
      'Check your internet connection for the first-time download (~600 MB), then try again.',
      (e as Error).message?.slice(0, 300)
    )
  }
  if (signal?.aborted) throw new CancelledError()

  const src = floresCode(sourceIso)
  const tgt = floresCode(targetIso)
  const translations: Record<number, string> = {}
  const failedIds: number[] = []
  const started = Date.now()

  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) throw new CancelledError()
    const seg = todo[i]
    try {
      const out = await translator(seg.text, { src_lang: src, tgt_lang: tgt })
      const t = out?.[0]?.translation_text?.trim()
      if (t) translations[seg.id] = t
      else failedIds.push(seg.id)
    } catch (e) {
      log.warn(`[nllb] segment ${seg.id} failed: ${(e as Error).message}`)
      failedIds.push(seg.id)
    }
    const frac = (i + 1) / todo.length
    const elapsed = (Date.now() - started) / 1000
    const eta = frac > 0.05 ? (elapsed / frac) * (1 - frac) : null
    onProgress?.(0.6 + frac * 0.4, eta, `${i + 1}/${todo.length}`)
  }

  if (Object.keys(translations).length === 0 && todo.length > 0) {
    throw err('translate-failed', 'No segments could be translated.', 'Check the log for details.')
  }
  onProgress?.(1, 0, null)
  return { translations, failedIds, provider: 'nllb' }
}
