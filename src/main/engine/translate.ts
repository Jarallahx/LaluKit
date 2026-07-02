import { CancelledError, err } from './errors'
import type { ProgressFn } from './util'
import type { ApiProvider, SubtitleSegment, TranslateRunResult } from '@shared/types'
import { WHISPER_LANGUAGES } from '@shared/types'

// Online subtitle translation: meaning-based via LLMs (Claude/OpenAI) or NMT
// (DeepL/Google). LLM batches carry surrounding-segment context so lines are
// translated as dialogue, not isolated strings.

export interface OnlineCfg {
  provider: ApiProvider
  apiKey: string
  model?: string
  baseUrl?: string // override for tests
}

export interface TranslateCtx {
  signal?: AbortSignal
  onProgress?: ProgressFn
  log: (m: string) => void
  sourceLang?: string | null // whisper iso of the source, when known
}

const LLM_BATCH = 15
const NMT_BATCH = 40
const CONTEXT = 3

export function langName(iso: string): string {
  return WHISPER_LANGUAGES.find(([c]) => c === iso)?.[1] ?? iso
}

function systemPrompt(targetName: string, sourceName: string | null): string {
  return [
    `You are translating subtitles${sourceName ? ` from ${sourceName}` : ''} into ${targetName}.`,
    'Preserve meaning, tone, and emotional register. Use natural conversational',
    `${targetName} appropriate for media subtitles` +
    (targetName === 'Arabic' ? ' (clear modern Arabic with a natural conversational register — no overly formal khutbah Arabic for casual dialogue, and absolutely no transliteration/romanization of the source words)' : '') + '.',
    'Do NOT translate proper nouns literally — keep names as names.',
    'Keep translations concise so they fit subtitle timing.',
    'You receive a JSON array of segments plus surrounding context lines.',
    'Reply with ONLY a JSON object {"items":[{"id":<id>,"t":"<translation>"}]} —',
    'one item per input segment, no notes, no extra text.'
  ].join(' ')
}

function userPayload(batch: SubtitleSegment[], before: string[], after: string[], targetName: string): string {
  return JSON.stringify({
    target_language: targetName,
    context_before: before,
    segments: batch.map((s) => ({ id: s.id, text: s.text })),
    context_after: after
  })
}

// Tolerant extraction of {"items":[...]} or a bare array from an LLM reply.
// Numeric-string ids are coerced; everything else is dropped here and caught
// by the strict batch validation below.
function parseLlmItems(text: string): { id: number; t: string }[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.search(/[[{]/)
  if (start < 0) throw new Error('no JSON in model reply')
  const candidate = cleaned.slice(start)
  const parsed = JSON.parse(candidate) as unknown
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed as { items?: unknown[] }).items
  if (!Array.isArray(arr)) throw new Error('reply JSON has no items array')
  const out: { id: number; t: string }[] = []
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue
    const rawId = (x as { id?: unknown }).id
    const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' ? Number(rawId) : NaN
    const t = (x as { t?: unknown; translation?: unknown }).t ?? (x as { translation?: unknown }).translation
    if (Number.isFinite(id) && typeof t === 'string') out.push({ id, t })
  }
  return out
}

// Timing safety: a batch is applied only when the reply contains EXACTLY the
// ids that were sent — same count, same set. An off-by-one reply would
// otherwise put line k's Arabic on line k±1, which plays as "out of sync".
function validateBatchIds(sent: SubtitleSegment[], received: { id: number; t: string }[]): string | null {
  if (received.length !== sent.length) {
    return `count mismatch: sent ${sent.length}, received ${received.length}`
  }
  const sentIds = new Set(sent.map((s) => s.id))
  const recvIds = new Set(received.map((r) => r.id))
  if (recvIds.size !== received.length) return 'duplicate ids in reply'
  for (const id of sentIds) {
    if (!recvIds.has(id)) return `missing id ${id} in reply`
  }
  return null
}

interface HttpReply { status: number; body: string; retryAfterSec: number | null }

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<HttpReply> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    if (signal?.aborted) throw new CancelledError()
    throw err('translate-net', 'Could not reach the translation service.', 'Check your internet connection and try again.')
  }
  const text = await res.text().catch(() => '')
  const ra = res.headers.get('retry-after')
  return { status: res.status, body: text, retryAfterSec: ra ? Number(ra) || null : null }
}

function authQuotaCheck(provider: ApiProvider, reply: HttpReply): void {
  if (reply.status === 401 || reply.status === 403) {
    throw err('translate-auth', `The ${provider} API key was rejected.`, 'Check the key in Settings → Translation.', reply.body.slice(0, 300))
  }
  if (reply.status === 402) {
    throw err('translate-quota', `The ${provider} account has no remaining credit.`, 'Top up the account or switch backends in Settings.', reply.body.slice(0, 300))
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError()) }, { once: true })
  })

// One LLM batch with retry (429 honors Retry-After; 5xx/network backoff ×3).
async function llmBatch(
  cfg: OnlineCfg,
  batch: SubtitleSegment[],
  before: string[],
  after: string[],
  targetName: string,
  sourceName: string | null,
  ctx: TranslateCtx
): Promise<{ id: number; t: string }[]> {
  const sys = systemPrompt(targetName, sourceName)
  const user = userPayload(batch, before, after, targetName)
  let attempt = 0
  let idRetries = 0
  for (;;) {
    attempt++
    if (ctx.signal?.aborted) throw new CancelledError()
    let reply: HttpReply
    if (cfg.provider === 'claude') {
      reply = await post(
        `${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
        { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: cfg.model ?? 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: sys,
          messages: [{ role: 'user', content: user }]
        },
        ctx.signal
      )
    } else {
      reply = await post(
        `${cfg.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`,
        { authorization: `Bearer ${cfg.apiKey}` },
        {
          model: cfg.model ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user }
          ],
          response_format: { type: 'json_object' }
        },
        ctx.signal
      )
    }
    authQuotaCheck(cfg.provider, reply)
    if (reply.status === 429) {
      if (attempt >= 4) throw err('translate-quota', `${cfg.provider} rate limit persisted after retries.`, 'Wait a minute and run translation again — finished segments are kept.')
      await sleep((reply.retryAfterSec ?? 4 * attempt) * 1000, ctx.signal)
      continue
    }
    if (reply.status >= 500 || reply.status === 408) {
      if (attempt >= 3) throw new Error(`HTTP ${reply.status}`)
      await sleep(1500 * attempt, ctx.signal)
      continue
    }
    if (reply.status !== 200) {
      throw err('translate-failed', `${cfg.provider} replied with HTTP ${reply.status}.`, undefined, reply.body.slice(0, 300))
    }
    const json = JSON.parse(reply.body) as never
    const text = cfg.provider === 'claude'
      ? (json as { content: { text: string }[] }).content?.[0]?.text ?? ''
      : (json as { choices: { message: { content: string } }[] }).choices?.[0]?.message?.content ?? ''
    const items = parseLlmItems(text)
    const idError = validateBatchIds(batch, items)
    if (idError) {
      // One corrective retry: models occasionally renumber; never apply a
      // misaligned batch (that's the "Arabic out of sync" failure mode).
      if (idRetries >= 1) throw new Error(`id contract violated after retry (${idError})`)
      idRetries++
      ctx.log(`batch id contract violated (${idError}); retrying once`)
      await sleep(800, ctx.signal)
      continue
    }
    return items
  }
}

async function nmtBatch(
  cfg: OnlineCfg,
  texts: string[],
  targetIso: string,
  ctx: TranslateCtx
): Promise<string[]> {
  let attempt = 0
  for (;;) {
    attempt++
    if (ctx.signal?.aborted) throw new CancelledError()
    let reply: HttpReply
    if (cfg.provider === 'deepl') {
      const base = cfg.baseUrl ?? (cfg.apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')
      reply = await post(
        `${base}/v2/translate`,
        { authorization: `DeepL-Auth-Key ${cfg.apiKey}` },
        { text: texts, target_lang: targetIso.toUpperCase() },
        ctx.signal
      )
    } else {
      const base = cfg.baseUrl ?? 'https://translation.googleapis.com'
      reply = await post(
        `${base}/language/translate/v2?key=${encodeURIComponent(cfg.apiKey)}`,
        {},
        { q: texts, target: targetIso, format: 'text' },
        ctx.signal
      )
    }
    authQuotaCheck(cfg.provider, reply)
    if (reply.status === 429 || reply.status === 456 /* deepl quota */) {
      if (reply.status === 456 || attempt >= 4) {
        throw err('translate-quota', `${cfg.provider} quota exceeded.`, 'Wait or switch backends in Settings — finished segments are kept.')
      }
      await sleep((reply.retryAfterSec ?? 4 * attempt) * 1000, ctx.signal)
      continue
    }
    if (reply.status >= 500) {
      if (attempt >= 3) throw new Error(`HTTP ${reply.status}`)
      await sleep(1500 * attempt, ctx.signal)
      continue
    }
    if (reply.status !== 200) {
      throw err('translate-failed', `${cfg.provider} replied with HTTP ${reply.status}.`, undefined, reply.body.slice(0, 300))
    }
    const json = JSON.parse(reply.body) as never
    if (cfg.provider === 'deepl') {
      return ((json as { translations: { text: string }[] }).translations ?? []).map((t) => t.text)
    }
    return ((json as { data: { translations: { translatedText: string }[] } }).data?.translations ?? []).map((t) => t.translatedText)
  }
}

export async function translateAllOnline(
  cfg: OnlineCfg,
  segments: SubtitleSegment[],
  targetIso: string,
  ctx: TranslateCtx
): Promise<TranslateRunResult> {
  const todo = segments.filter((s) => s.text.trim().length > 0)
  const translations: Record<number, string> = {}
  const failedIds: number[] = []
  const targetName = langName(targetIso)
  const sourceName = ctx.sourceLang ? langName(ctx.sourceLang) : null
  const isLlm = cfg.provider === 'claude' || cfg.provider === 'openai'
  const batchSize = isLlm ? LLM_BATCH : NMT_BATCH
  const started = Date.now()
  let done = 0

  const report = (): void => {
    const frac = todo.length > 0 ? done / todo.length : 1
    const elapsed = (Date.now() - started) / 1000
    const eta = frac > 0.02 ? (elapsed / frac) * (1 - frac) : null
    ctx.onProgress?.(frac, eta, `${done}/${todo.length}`)
  }
  report()

  for (let i = 0; i < todo.length; i += batchSize) {
    if (ctx.signal?.aborted) throw new CancelledError()
    const batch = todo.slice(i, i + batchSize)
    try {
      if (isLlm) {
        const before = todo.slice(Math.max(0, i - CONTEXT), i).map((s) => s.text)
        const after = todo.slice(i + batch.length, i + batch.length + CONTEXT).map((s) => s.text)
        const items = await llmBatch(cfg, batch, before, after, targetName, sourceName, ctx)
        const byId = new Map(items.map((x) => [x.id, x.t]))
        for (const s of batch) {
          const t = byId.get(s.id)
          if (t && t.trim().length > 0) translations[s.id] = t.trim()
          else failedIds.push(s.id)
        }
      } else {
        const out = await nmtBatch(cfg, batch.map((s) => s.text), targetIso, ctx)
        batch.forEach((s, k) => {
          const t = out[k]
          if (t && t.trim().length > 0) translations[s.id] = t.trim()
          else failedIds.push(s.id)
        })
      }
    } catch (e) {
      if (e instanceof CancelledError) throw e
      // Auth/quota abort the run; anything else fails this batch and moves on.
      if (e && typeof e === 'object' && 'friendly' in e) {
        const code = (e as { friendly: { code: string } }).friendly.code
        if (code === 'translate-auth' || code === 'translate-quota') throw e
      }
      ctx.log(`translate batch ${i / batchSize + 1} failed: ${(e as Error).message}`)
      failedIds.push(...batch.map((s) => s.id))
    }
    done += batch.length
    report()
  }

  if (Object.keys(translations).length === 0 && todo.length > 0) {
    throw err('translate-failed', 'No segments could be translated.', 'Check the log for details and try again.')
  }
  ctx.onProgress?.(1, 0, null)
  return { translations, failedIds, provider: cfg.provider }
}

// Cheap connectivity/key check used by the Settings "Test" button.
export async function testProvider(cfg: OnlineCfg): Promise<{ ok: boolean; message: string; sample?: string }> {
  try {
    const res = await translateAllOnline(
      cfg,
      [{ id: 1, start: 0, end: 1, text: 'Hello, how are you?' }],
      'ar',
      { log: () => {} }
    )
    const sample = res.translations[1]
    return sample
      ? { ok: true, message: 'OK', sample }
      : { ok: false, message: 'The service replied but returned no translation.' }
  } catch (e) {
    const friendly = (e as { friendly?: { message: string; hint?: string } }).friendly
    return { ok: false, message: friendly ? `${friendly.message}${friendly.hint ? ' ' + friendly.hint : ''}` : (e as Error).message }
  }
}
