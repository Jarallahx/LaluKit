import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { LaluApi } from '@shared/api'
import type { FriendlyError } from '@shared/types'

interface Wrapped<T> { __val?: T; __err?: FriendlyError }

// FriendlyError payloads cross IPC inside an envelope; unwrap and rethrow so
// renderer code can catch a structured error object.
export class ApiError extends Error {
  friendly: FriendlyError
  constructor(friendly: FriendlyError) {
    super(friendly.message)
    this.name = 'ApiError'
    this.friendly = friendly
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Wrapped<T>
  if (res && typeof res === 'object' && '__err' in res && res.__err) {
    throw new ApiError(res.__err)
  }
  return (res as Wrapped<T>).__val as T
}

function listen<T>(channel: string) {
  return (cb: (payload: T) => void): (() => void) => {
    const fn = (_e: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, fn as never)
    return () => ipcRenderer.removeListener(channel, fn as never)
  }
}

const api: LaluApi = {
  system: {
    info: () => call('system:info'),
    getSettings: () => call('settings:get'),
    setSettings: (patch) => call('settings:set', patch),
    getRecents: () => call('recents:get'),
    removeRecent: (p) => call('recents:remove', p),
    clearRecents: () => call('recents:clear'),
    chooseOpen: (multi) => call('dialog:open', multi),
    chooseSave: (req) => call('dialog:save', req),
    chooseDir: () => call('dialog:dir'),
    showInFolder: (p) => call('shell:show-in-folder', p),
    openPath: (p) => call('shell:open-path', p),
    openLog: () => call('shell:open-log'),
    clearCache: () => call('system:clear-cache'),
    fonts: () => call('system:fonts'),
    diskSpace: (dir) => call('system:disk-space', dir),
    setTitleBarTheme: (t) => call('system:titlebar', t),
    pathExists: (p) => call('system:path-exists', p),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null
      } catch {
        return null
      }
    },
    onOpenFile: listen<string>('app:open-file'),
    onSmoke: listen<{ scenario: string; testVideo: string | null }>('smoke:scenario')
  },
  media: {
    open: (p) => call('media:open', p),
    requestTranscodeProxy: (p) => call('media:proxy-transcode', p),
    waveform: (p, track) => call('media:waveform', p, track),
    thumbs: (p) => call('media:thumbs', p),
    keyframes: (p, t, w) => call('media:keyframes', p, t, w),
    onThumbsPartial: listen('thumbs:partial')
  },
  cut: {
    export: (opts) => call('cut:export', opts)
  },
  merge: {
    probe: (paths) => call('merge:probe', paths),
    plan: async (paths) => (await call<{ plan: never }>('merge:probe', paths)).plan,
    export: (opts) => call('merge:export', opts)
  },
  subs: {
    models: () => call('subs:models'),
    downloadModel: (id) => call('subs:model-download', id),
    deleteModel: (id) => call('subs:model-delete', id),
    transcribe: (opts) => call('subs:transcribe', opts),
    tighten: (inputPath, segments) => call('subs:tighten', inputPath, segments),
    exportFile: (segments, format, p) => call('subs:export-file', segments, format, p),
    burnIn: (opts) => call('subs:burn', opts),
    attach: (opts) => call('subs:attach', opts)
  },
  extras: {
    extractAudio: (opts) => call('extras:extract-audio', opts),
    gif: (opts) => call('extras:gif', opts),
    reverse: (opts) => call('extras:reverse', opts)
  },
  translate: {
    run: (segments, cfg, sourceLang) => call('translate:run', segments, cfg, sourceLang),
    test: (provider) => call('translate:test', provider),
    setKey: (provider, key) => call('translate:set-key', provider, key),
    hasKeys: () => call('translate:has-keys')
  },
  project: {
    save: (p, project) => call('project:save', p, project),
    load: (p) => call('project:load', p),
    autosave: (project) => call('project:autosave', project),
    recoveryPeek: () => call('project:recovery-peek'),
    recoveryClear: () => call('project:recovery-clear')
  },
  jobs: {
    cancel: (id) => call('jobs:cancel', id),
    list: () => call('jobs:list'),
    onUpdate: listen('job:update')
  }
}

contextBridge.exposeInMainWorld('lalu', api)
