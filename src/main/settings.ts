import { app } from 'electron'
import path from 'node:path'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import log from './logger'
import type { AppSettings, RecentFile } from '@shared/types'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  locale: 'en',
  exportDir: null,
  quality: 'balanced',
  // On by default: pickHwEncoder() resolves to null when no GPU encoder is
  // actually available, so this is safe on CPU-only machines.
  useHardware: true,
  snapping: true,
  cutEngine: 'exact',
  lastModelId: 'small',
  lastLanguage: 'auto',
  lastTranslate: false,
  vadEnabled: true,
  preciseTiming: true,
  subtitleStyle: {
    fontFamily: 'Arial',
    fontSize: 30,
    bold: false,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 2,
    background: false,
    position: 'bottom',
    marginV: 44
  },
  translate: {
    backend: 'claude',
    claudeModel: 'claude-sonnet-4-6',
    openaiModel: 'gpt-4o-mini',
    targetLang: 'ar'
  },
  volume: 1,
  muted: false
}

interface StoreShape {
  settings: AppSettings
  recents: RecentFile[]
  windowBounds: { x?: number; y?: number; width: number; height: number } | null
}

// Tiny atomic JSON store: read once at boot, debounce writes, tmp+rename.
class Store {
  private file: string
  private data: StoreShape
  private writeTimer: NodeJS.Timeout | null = null

  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json')
    this.data = { settings: { ...DEFAULT_SETTINGS }, recents: [], windowBounds: null }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreShape>
      this.data.settings = {
        ...DEFAULT_SETTINGS,
        ...(raw.settings ?? {}),
        subtitleStyle: { ...DEFAULT_SETTINGS.subtitleStyle, ...(raw.settings?.subtitleStyle ?? {}) },
        translate: { ...DEFAULT_SETTINGS.translate, ...(raw.settings?.translate ?? {}) }
      }
      this.data.recents = Array.isArray(raw.recents) ? raw.recents.slice(0, 12) : []
      this.data.windowBounds = raw.windowBounds ?? null
    } catch {
      // First run: follow the Windows display language for Arabic systems.
      try {
        const sys = [app.getLocale(), ...app.getPreferredSystemLanguages()].map((l) => l.toLowerCase())
        if (sys.some((l) => l.startsWith('ar'))) this.data.settings.locale = 'ar'
      } catch { /* keep english */ }
    }
    if (this.data.settings.locale !== 'ar' && this.data.settings.locale !== 'en') this.data.settings.locale = 'en'
  }

  get settings(): AppSettings {
    return this.data.settings
  }

  patchSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = {
      ...this.data.settings,
      ...patch,
      subtitleStyle: { ...this.data.settings.subtitleStyle, ...(patch.subtitleStyle ?? {}) },
      translate: { ...this.data.settings.translate, ...(patch.translate ?? {}) }
    }
    this.scheduleWrite()
    return this.data.settings
  }

  get recents(): RecentFile[] {
    return this.data.recents
  }

  addRecent(r: RecentFile): void {
    this.data.recents = [r, ...this.data.recents.filter((x) => x.path !== r.path)].slice(0, 12)
    this.scheduleWrite()
  }

  removeRecent(p: string): void {
    this.data.recents = this.data.recents.filter((x) => x.path !== p)
    this.scheduleWrite()
  }

  clearRecents(): void {
    this.data.recents = []
    this.scheduleWrite()
  }

  get windowBounds(): StoreShape['windowBounds'] {
    return this.data.windowBounds
  }

  setWindowBounds(b: NonNullable<StoreShape['windowBounds']>): void {
    this.data.windowBounds = b
    this.scheduleWrite()
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      log.error('settings write failed:', e)
    }
  }
}

let store: Store | null = null
export function getStore(): Store {
  if (!store) store = new Store()
  return store
}
