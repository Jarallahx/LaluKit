import { app, safeStorage } from 'electron'
import path from 'node:path'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import log from './logger'
import type { ApiProvider } from '@shared/types'

// API keys encrypted at rest with Electron safeStorage (DPAPI on Windows).
// Keys never leave the main process — the renderer only ever sees booleans.

interface KeyFile {
  v: 1
  // provider -> base64(encrypted) — or {plain} fallback when the OS keystore
  // is unavailable (logged loudly; practically never on Windows).
  keys: Record<string, { enc: string } | { plain: string }>
}

function file(): string {
  return path.join(app.getPath('userData'), 'keys.json')
}

function load(): KeyFile {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as KeyFile
    if (raw.v === 1 && raw.keys) return raw
  } catch { /* first run */ }
  return { v: 1, keys: {} }
}

function persist(data: KeyFile): void {
  mkdirSync(path.dirname(file()), { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, file())
}

export function setApiKey(provider: ApiProvider, key: string | null): void {
  const data = load()
  if (!key || key.trim() === '') {
    delete data.keys[provider]
  } else if (safeStorage.isEncryptionAvailable()) {
    data.keys[provider] = { enc: safeStorage.encryptString(key.trim()).toString('base64') }
  } else {
    log.warn('safeStorage unavailable — storing API key without OS encryption')
    data.keys[provider] = { plain: Buffer.from(key.trim(), 'utf8').toString('base64') }
  }
  persist(data)
}

export function getApiKey(provider: ApiProvider): string | null {
  const entry = load().keys[provider]
  if (!entry) return null
  try {
    if ('enc' in entry) return safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))
    return Buffer.from(entry.plain, 'base64').toString('utf8')
  } catch (e) {
    log.error(`failed to decrypt ${provider} key:`, e)
    return null
  }
}

export function hasApiKeys(): Record<ApiProvider, boolean> {
  const data = load()
  return {
    claude: !!data.keys.claude,
    openai: !!data.keys.openai,
    deepl: !!data.keys.deepl,
    google: !!data.keys.google
  }
}
