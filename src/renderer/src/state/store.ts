import { create } from 'zustand'
import { playerCtl } from '@/lib/player-ctl'
import { clamp, snapToFrame } from '@/lib/time'
import { baseName, suggestOutput } from '@/lib/naming'
import { composeSegments, fileSuffixFor, type SubsViewMode } from '@/lib/subs-compose'
import type {
  ApiProvider, AppSettings, CropOptions, CutEngine, CutMode, CutRange,
  FriendlyError, JobInfo, MediaInfo, MergePlan, ModelsState, ProjectFile,
  RecentFile, SubtitleSegment, SubtitleStyle, SystemInfo, ThumbsPartial,
  TranscribeResult, TranslateRunResult
} from '@shared/types'
import { RTL_LANGS } from '@shared/types'
import type { I18nKey } from '@/i18n/en'

export type Workspace = 'cut' | 'merge' | 'subtitles'

export interface Toast {
  id: string
  severity: 'info' | 'success' | 'error' | 'warning'
  titleKey: I18nKey
  titleVars?: Record<string, string | number>
  friendly?: FriendlyError | null
  action?: { labelKey: I18nKey; run: () => void }
  sticky?: boolean
}

interface Snapshot {
  ranges: CutRange[]
  segments: SubtitleSegment[]
  cutMode: CutMode
}

export interface BatchItem {
  path: string
  name: string
  status: 'pending' | 'working' | 'done' | 'error'
  srtPath: string | null
}

export type DialogState =
  | { kind: 'export-cut' }
  | { kind: 'export-merge' }
  | { kind: 'settings'; tab?: string }
  | { kind: 'shortcuts' }
  | { kind: 'style'; thenBurn?: boolean }
  | { kind: 'burn' }
  | { kind: 'attach' }
  | { kind: 'confirm-open'; path: string }
  | { kind: 'confirm-retranscribe' }
  | { kind: 'extract-audio' }
  | { kind: 'gif' }
  | { kind: 'reverse' }
  | null

export interface MergeItem {
  id: string
  path: string
  info: MediaInfo | null
  errorCode: string | null
  thumbUrl: string | null
  probing: boolean
}

let idCounter = 0
const uid = (): string => `id${Date.now().toString(36)}${(idCounter++).toString(36)}`

interface State extends AppSettings {
  // ----- boot/system -----
  hydrated: boolean
  sysInfo: SystemInfo | null
  fonts: string[]
  recents: RecentFile[]

  // ----- ui -----
  workspace: Workspace
  dialog: DialogState
  paletteOpen: boolean
  toasts: Toast[]
  dropActive: boolean
  shuttleRate: number
  currentTimeCoarse: number
  playing: boolean
  setPaletteOpen(b: boolean): void

  // ----- media -----
  media: MediaInfo | null
  playbackUrl: string | null
  proxyJobId: string | null
  proxyProgress: number | null
  opening: boolean
  peaks: number[] | null
  noAudio: boolean
  thumbs: (string | null)[]
  waveJobId: string | null
  thumbsJobId: string | null
  triedTranscodeFallback: boolean

  // ----- cut -----
  ranges: CutRange[]
  selectedRangeId: string | null
  selectedRangeIds: string[]
  cutMode: CutMode
  keyframes: number[]
  cropPreview: CropOptions | null

  // ----- history -----
  past: Snapshot[]
  future: Snapshot[]

  // ----- batch transcription -----
  batch: { active: boolean; items: BatchItem[]; index: number; jobId: string | null }

  // ----- merge -----
  mergeItems: MergeItem[]
  mergePlan: MergePlan | null

  // ----- subtitles -----
  models: ModelsState | null
  segments: SubtitleSegment[]
  detectedLang: string | null
  usedModelId: string | null
  transcribeJobId: string | null
  downloadJobId: string | null
  pendingAutoTranscribe: boolean
  subsAudioTrack: number
  followPlayback: boolean
  showSubtitlePreview: boolean
  cleanedCount: number
  subsViewMode: SubsViewMode
  translateJobId: string | null
  tightenJobId: string | null
  apiKeysState: Record<ApiProvider, boolean> | null

  // ----- jobs -----
  jobs: Record<string, JobInfo>
  jobOrder: string[]

  // ----- actions -----
  hydrate(): Promise<void>
  patchSettings(patch: Partial<AppSettings>): void
  setWorkspace(w: Workspace): void
  openDialog(d: NonNullable<DialogState>): void
  closeDialog(): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: string): void
  setDropActive(b: boolean): void
  setPlaying(b: boolean): void
  setShuttleRate(r: number): void
  refreshRecents(): Promise<void>

  openFile(path: string, opts?: { force?: boolean }): Promise<void>
  closeMedia(): void
  retryPlaybackViaProxy(): Promise<void>

  addRangeAt(t: number): void
  markIn(t: number): void
  markOut(t: number): void
  updateRange(id: string, patch: Partial<Pick<CutRange, 'start' | 'end'>>): void
  updateRangeCommitted(id: string, patch: Partial<Pick<CutRange, 'start' | 'end'>>): void
  moveRange(id: string, delta: number): void
  removeRange(id: string): void
  removeSelectedRanges(): void
  selectRange(id: string | null, opts?: { additive?: boolean }): void
  splitRangeAt(t: number): void
  setRangeFx(id: string, fx: { speed?: number; volume?: number }): void
  setCutMode(m: CutMode): void
  setCutEngine(e: CutEngine): void
  addKeyframes(times: number[]): void
  setCropPreview(c: CropOptions | null): void

  historyMark(): void
  undo(): void
  redo(): void

  buildProject(): ProjectFile | null
  saveProjectAs(): Promise<void>
  openProject(path: string): Promise<void>
  autosaveNow(): Promise<void>
  offerRecovery(): Promise<void>

  startBatch(paths: string[]): Promise<void>
  cancelBatch(): void
  exportSubtitles(format: 'srt' | 'vtt'): Promise<void>
  setSubsViewMode(m: SubsViewMode): void
  startTranslate(): Promise<void>
  tightenTiming(): Promise<void>
  refreshApiKeys(): Promise<void>

  mergeAddPaths(paths: string[]): Promise<void>
  mergeRemove(id: string): void
  mergeSetOrder(ids: string[]): void
  mergeClear(): void

  refreshModels(): Promise<void>
  setSegments(segments: SubtitleSegment[]): void
  editSegment(id: number, patch: Partial<SubtitleSegment>): void
  deleteSegment(id: number): void
  addSegmentAfter(id: number | null): void
  mergeSegmentWithNext(id: number): void
  startTranscribe(): Promise<void>
  downloadModel(id: string): Promise<void>
  setSubsOption(patch: Partial<Pick<State, 'lastModelId' | 'lastLanguage' | 'lastTranslate' | 'subsAudioTrack' | 'followPlayback' | 'showSubtitlePreview'>>): void
  setSubtitleStyle(style: SubtitleStyle): void

  updateJob(job: JobInfo): void
  cancelJob(id: string): void
  applyThumbsPartial(p: ThumbsPartial): void
}

const DEFAULT_STYLE: SubtitleStyle = {
  fontFamily: 'Arial', fontSize: 30, bold: false, color: '#ffffff',
  outlineColor: '#000000', outlineWidth: 2, background: false,
  position: 'bottom', marginV: 44
}

export const useStore = create<State>((set, get) => ({
  // settings defaults (overwritten by hydrate)
  theme: 'dark',
  locale: 'en',
  exportDir: null,
  quality: 'balanced',
  useHardware: false,
  snapping: true,
  cutEngine: 'exact',
  lastModelId: 'small',
  lastLanguage: 'auto',
  lastTranslate: false,
  vadEnabled: true,
  preciseTiming: true,
  subtitleStyle: DEFAULT_STYLE,
  translate: { backend: 'claude', claudeModel: 'claude-sonnet-4-6', openaiModel: 'gpt-4o-mini', targetLang: 'ar' },
  volume: 1,
  muted: false,

  hydrated: false,
  sysInfo: null,
  fonts: [],
  recents: [],

  workspace: 'cut',
  dialog: null,
  paletteOpen: false,
  toasts: [],
  dropActive: false,
  shuttleRate: 0,
  currentTimeCoarse: 0,
  playing: false,

  media: null,
  playbackUrl: null,
  proxyJobId: null,
  proxyProgress: null,
  opening: false,
  peaks: null,
  noAudio: false,
  thumbs: [],
  waveJobId: null,
  thumbsJobId: null,
  triedTranscodeFallback: false,

  ranges: [],
  selectedRangeId: null,
  selectedRangeIds: [],
  cutMode: 'keep',
  keyframes: [],
  cropPreview: null,
  past: [],
  future: [],
  batch: { active: false, items: [], index: 0, jobId: null },

  mergeItems: [],
  mergePlan: null,

  models: null,
  segments: [],
  detectedLang: null,
  usedModelId: null,
  transcribeJobId: null,
  downloadJobId: null,
  pendingAutoTranscribe: false,
  subsAudioTrack: 0,
  followPlayback: true,
  showSubtitlePreview: true,
  cleanedCount: 0,
  subsViewMode: 'original',
  translateJobId: null,
  tightenJobId: null,
  apiKeysState: null,

  jobs: {},
  jobOrder: [],

  // ---------- boot ----------

  hydrate: async () => {
    const [settings, sysInfo, recents] = await Promise.all([
      window.lalu.system.getSettings(),
      window.lalu.system.info(),
      window.lalu.system.getRecents()
    ])
    set({ ...settings, sysInfo, recents, hydrated: true })
    applyChrome(settings.theme, settings.locale)
    void window.lalu.system.fonts().then((fonts) => set({ fonts }))
    void get().refreshModels()
  },

  patchSettings: (patch) => {
    set(patch as Partial<State>)
    const s = get()
    if (patch.theme || patch.locale) applyChrome(s.theme, s.locale)
    void window.lalu.system.setSettings({
      theme: s.theme, locale: s.locale, exportDir: s.exportDir, quality: s.quality,
      useHardware: s.useHardware, snapping: s.snapping, cutEngine: s.cutEngine,
      lastModelId: s.lastModelId, lastLanguage: s.lastLanguage, lastTranslate: s.lastTranslate,
      vadEnabled: s.vadEnabled, preciseTiming: s.preciseTiming, translate: s.translate,
      subtitleStyle: s.subtitleStyle, volume: s.volume, muted: s.muted
    })
    if (patch.theme) void window.lalu.system.setTitleBarTheme(patch.theme)
  },

  setWorkspace: (w) => set({ workspace: w }),
  openDialog: (d) => set({ dialog: d, paletteOpen: false }),
  closeDialog: () => set({ dialog: null }),
  setPaletteOpen: (b) => set({ paletteOpen: b }),

  toast: (t) => {
    const toast: Toast = { ...t, id: uid() }
    set((s) => ({ toasts: [...s.toasts, toast].slice(-5) }))
    if (!t.sticky) {
      window.setTimeout(() => get().dismissToast(toast.id), t.severity === 'error' ? 9000 : 4000)
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setDropActive: (b) => set({ dropActive: b }),
  setPlaying: (b) => set({ playing: b }),
  setShuttleRate: (r) => set({ shuttleRate: r }),

  refreshRecents: async () => {
    set({ recents: await window.lalu.system.getRecents() })
  },

  // ---------- media ----------

  openFile: async (path, opts) => {
    const s = get()
    if (!opts?.force && s.media && (s.ranges.length > 0 || s.segments.length > 0) && s.media.path !== path) {
      set({ dialog: { kind: 'confirm-open', path } })
      return
    }
    set({ opening: true })
    try {
      const info = await window.lalu.media.open(path)
      set({
        media: info,
        playbackUrl: info.playback.url,
        proxyJobId: info.playback.proxyJobId,
        proxyProgress: info.playback.proxyJobId ? 0 : null,
        opening: false,
        peaks: null,
        noAudio: info.audioTracks.length === 0,
        thumbs: [],
        triedTranscodeFallback: false,
        ranges: [],
        selectedRangeId: null,
        selectedRangeIds: [],
        keyframes: [],
        cropPreview: null,
        past: [],
        future: [],
        segments: [],
        detectedLang: null,
        usedModelId: null,
        transcribeJobId: null,
        translateJobId: null,
        cleanedCount: 0,
        subsViewMode: 'original',
        pendingAutoTranscribe: false,
        subsAudioTrack: 0,
        currentTimeCoarse: 0,
        playing: false,
        workspace: get().workspace === 'merge' ? 'cut' : get().workspace,
        dialog: null
      })
      void get().refreshRecents()
      if (info.audioTracks.length > 0) {
        const { jobId } = await window.lalu.media.waveform(path, 0)
        set({ waveJobId: jobId })
      }
      if (info.video) {
        const { jobId } = await window.lalu.media.thumbs(path)
        set({ thumbsJobId: jobId })
      }
    } catch (e) {
      set({ opening: false })
      get().toast({
        severity: 'error',
        titleKey: 'error.openFailed',
        titleVars: { name: baseName(path) },
        friendly: friendlyOf(e)
      })
    }
  },

  closeMedia: () => {
    playerCtl.detach()
    set({
      media: null, playbackUrl: null, proxyJobId: null, proxyProgress: null,
      peaks: null, thumbs: [], ranges: [], selectedRangeId: null, segments: [],
      detectedLang: null, usedModelId: null, transcribeJobId: null, keyframes: []
    })
  },

  // Direct playback failed at runtime: rebuild via transcode proxy once.
  retryPlaybackViaProxy: async () => {
    const s = get()
    if (!s.media || s.triedTranscodeFallback) return
    set({ triedTranscodeFallback: true, playbackUrl: null, proxyProgress: 0 })
    try {
      const { jobId } = await window.lalu.media.requestTranscodeProxy(s.media.path)
      set({ proxyJobId: jobId })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  // ---------- history ----------

  historyMark: () => {
    const s = get()
    const snap: Snapshot = {
      ranges: s.ranges.map((r) => ({ ...r })),
      segments: s.segments.map((x) => ({ ...x })),
      cutMode: s.cutMode
    }
    set({ past: [...s.past, snap].slice(-50), future: [] })
  },

  undo: () => {
    const s = get()
    const snap = s.past[s.past.length - 1]
    if (!snap) return
    const current: Snapshot = { ranges: s.ranges, segments: s.segments, cutMode: s.cutMode }
    set({
      past: s.past.slice(0, -1),
      future: [...s.future, current].slice(-50),
      ranges: snap.ranges,
      segments: snap.segments,
      cutMode: snap.cutMode,
      selectedRangeId: null,
      selectedRangeIds: []
    })
  },

  redo: () => {
    const s = get()
    const snap = s.future[s.future.length - 1]
    if (!snap) return
    const current: Snapshot = { ranges: s.ranges, segments: s.segments, cutMode: s.cutMode }
    set({
      future: s.future.slice(0, -1),
      past: [...s.past, current].slice(-50),
      ranges: snap.ranges,
      segments: snap.segments,
      cutMode: snap.cutMode,
      selectedRangeId: null,
      selectedRangeIds: []
    })
  },

  // ---------- cut ----------

  addRangeAt: (t) => {
    const s = get()
    if (!s.media) return
    const fps = s.media.video?.fps ?? 30
    const dur = s.media.durationSec
    const start = clamp(snapToFrame(t, fps), 0, Math.max(0, dur - 0.05))
    const sorted = [...s.ranges].sort((a, b) => a.start - b.start)
    const next = sorted.find((r) => r.start > start)
    const maxEnd = next ? next.start : dur
    const end = clamp(Math.min(start + Math.max(2, dur * 0.05), maxEnd), start + 1 / fps, dur)
    if (end - start < 1 / fps) return
    get().historyMark()
    const range: CutRange = { id: uid(), start, end }
    set({
      ranges: [...s.ranges, range].sort((a, b) => a.start - b.start),
      selectedRangeId: range.id,
      selectedRangeIds: [range.id]
    })
  },

  splitRangeAt: (t) => {
    const s = get()
    if (!s.media) return
    const fps = s.media.video?.fps ?? 30
    const minLen = 1 / fps
    const target = s.ranges.find((r) => t > r.start + minLen && t < r.end - minLen)
    if (!target) return
    get().historyMark()
    const cutAt = snapToFrame(t, fps)
    const left: CutRange = { ...target, id: target.id, end: cutAt }
    const right: CutRange = { ...target, id: uid(), start: cutAt }
    set({
      ranges: s.ranges.map((r) => (r.id === target.id ? left : r)).concat(right).sort((a, b) => a.start - b.start),
      selectedRangeId: right.id,
      selectedRangeIds: [right.id]
    })
  },

  setRangeFx: (id, fx) => {
    get().historyMark()
    set((s) => ({
      ranges: s.ranges.map((r) => (r.id === id
        ? { ...r, speed: fx.speed ?? r.speed ?? 1, volume: fx.volume ?? r.volume ?? 1 }
        : r))
    }))
  },

  markIn: (t) => {
    const s = get()
    if (!s.media) return
    const fps = s.media.video?.fps ?? 30
    const time = snapToFrame(t, fps)
    const sel = s.ranges.find((r) => r.id === s.selectedRangeId)
    get().historyMark()
    if (sel) {
      get().updateRange(sel.id, { start: Math.min(time, sel.end - 1 / fps) })
    } else {
      const dur = s.media.durationSec
      const end = clamp(time + Math.max(2, dur * 0.05), time + 1 / fps, dur)
      const range: CutRange = { id: uid(), start: clamp(time, 0, dur - 1 / fps), end }
      set({ ranges: [...s.ranges, range].sort((a, b) => a.start - b.start), selectedRangeId: range.id, selectedRangeIds: [range.id] })
    }
  },

  markOut: (t) => {
    const s = get()
    if (!s.media) return
    const fps = s.media.video?.fps ?? 30
    const time = snapToFrame(t, fps)
    const sel = s.ranges.find((r) => r.id === s.selectedRangeId)
    get().historyMark()
    if (sel) {
      get().updateRange(sel.id, { end: Math.max(time, sel.start + 1 / fps) })
    } else {
      const start = clamp(time - 5, 0, Math.max(0, time - 1 / fps))
      const range: CutRange = { id: uid(), start, end: clamp(time, start + 1 / fps, s.media.durationSec) }
      set({ ranges: [...s.ranges, range].sort((a, b) => a.start - b.start), selectedRangeId: range.id, selectedRangeIds: [range.id] })
    }
  },

  updateRangeCommitted: (id, patch) => {
    get().historyMark()
    get().updateRange(id, patch)
  },

  updateRange: (id, patch) => {
    const s = get()
    if (!s.media) return
    const fps = s.media.video?.fps ?? 30
    const minLen = 1 / fps
    const dur = s.media.durationSec
    const sorted = [...s.ranges].sort((a, b) => a.start - b.start)
    const idx = sorted.findIndex((r) => r.id === id)
    if (idx < 0) return
    const prev = sorted[idx - 1]
    const next = sorted[idx + 1]
    const r = { ...sorted[idx] }
    if (patch.start !== undefined) {
      r.start = clamp(patch.start, prev ? prev.end : 0, r.end - minLen)
    }
    if (patch.end !== undefined) {
      r.end = clamp(patch.end, r.start + minLen, next ? next.start : dur)
    }
    sorted[idx] = r
    set({ ranges: sorted })
  },

  moveRange: (id, delta) => {
    const s = get()
    if (!s.media) return
    const sorted = [...s.ranges].sort((a, b) => a.start - b.start)
    const idx = sorted.findIndex((r) => r.id === id)
    if (idx < 0) return
    const r = sorted[idx]
    const len = r.end - r.start
    const lo = sorted[idx - 1] ? sorted[idx - 1].end : 0
    const hi = (sorted[idx + 1] ? sorted[idx + 1].start : s.media.durationSec) - len
    const start = clamp(r.start + delta, lo, Math.max(lo, hi))
    sorted[idx] = { ...r, start, end: start + len }
    set({ ranges: sorted })
  },

  removeRange: (id) => {
    const s = get()
    get().historyMark()
    set({
      ranges: s.ranges.filter((r) => r.id !== id),
      selectedRangeId: s.selectedRangeId === id ? null : s.selectedRangeId,
      selectedRangeIds: s.selectedRangeIds.filter((x) => x !== id)
    })
  },

  removeSelectedRanges: () => {
    const s = get()
    const ids = new Set(s.selectedRangeIds.length > 0 ? s.selectedRangeIds : s.selectedRangeId ? [s.selectedRangeId] : [])
    if (ids.size === 0) return
    get().historyMark()
    set({
      ranges: s.ranges.filter((r) => !ids.has(r.id)),
      selectedRangeId: null,
      selectedRangeIds: []
    })
  },

  selectRange: (id, opts) => {
    if (id === null) {
      set({ selectedRangeId: null, selectedRangeIds: [] })
      return
    }
    if (opts?.additive) {
      // Shift-click: toggle membership, keep the latest as primary.
      const cur = get().selectedRangeIds
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      set({ selectedRangeIds: next, selectedRangeId: next[next.length - 1] ?? null })
    } else {
      set({ selectedRangeId: id, selectedRangeIds: [id] })
    }
  },

  setCropPreview: (c) => set({ cropPreview: c }),
  setCutMode: (m) => set({ cutMode: m }),
  setCutEngine: (e) => {
    set({ cutEngine: e })
    get().patchSettings({ cutEngine: e })
  },
  addKeyframes: (times) => {
    const merged = new Set(get().keyframes)
    for (const t of times) merged.add(Math.round(t * 1000) / 1000)
    set({ keyframes: [...merged].sort((a, b) => a - b).slice(0, 5000) })
  },

  // ---------- merge ----------

  mergeAddPaths: async (paths) => {
    const fresh = paths.filter((p) => !get().mergeItems.some((i) => i.path === p))
    if (fresh.length === 0) return
    const placeholders: MergeItem[] = fresh.map((p) => ({
      id: uid(), path: p, info: null, errorCode: null, thumbUrl: null, probing: true
    }))
    set((s) => ({ mergeItems: [...s.mergeItems, ...placeholders] }))
    try {
      const res = await window.lalu.merge.probe(fresh)
      set((s) => {
        const items = s.mergeItems.map((item) => {
          const probed = res.items.find((r) => r.path === item.path)
          if (!probed || !item.probing) return item
          return { ...item, probing: false, info: probed.info, errorCode: probed.errorCode, thumbUrl: probed.thumbUrl }
        })
        return { mergeItems: items }
      })
    } catch {
      set((s) => ({
        mergeItems: s.mergeItems.map((i) => (i.probing ? { ...i, probing: false, errorCode: 'unexpected' } : i))
      }))
    }
    recomputeMergePlan(set, get)
  },

  mergeRemove: (id) => {
    set((s) => ({ mergeItems: s.mergeItems.filter((i) => i.id !== id) }))
    recomputeMergePlan(set, get)
  },

  mergeSetOrder: (ids) => {
    set((s) => {
      const byId = new Map(s.mergeItems.map((i) => [i.id, i]))
      const ordered = ids.map((id) => byId.get(id)).filter((i): i is MergeItem => !!i)
      const missing = s.mergeItems.filter((i) => !ids.includes(i.id))
      return { mergeItems: [...ordered, ...missing] }
    })
  },

  mergeClear: () => set({ mergeItems: [], mergePlan: null }),

  // ---------- subtitles ----------

  refreshModels: async () => {
    try {
      set({ models: await window.lalu.subs.models() })
    } catch { /* models list is non-critical at boot */ }
  },

  setSegments: (segments) => {
    get().historyMark()
    set({ segments })
  },

  editSegment: (id, patch) => {
    get().historyMark()
    set((s) => ({
      segments: s.segments.map((seg) => {
        if (seg.id !== id) return seg
        const next = { ...seg, ...patch }
        if (next.end <= next.start) next.end = next.start + 0.2
        return next
      })
    }))
  },

  deleteSegment: (id) => {
    get().historyMark()
    set((s) => ({ segments: s.segments.filter((x) => x.id !== id) }))
  },

  addSegmentAfter: (id) => {
    get().historyMark()
    const s = get()
    const maxId = s.segments.reduce((m, x) => Math.max(m, x.id), 0)
    let start = playerCtl.currentTime
    let end = start + 2
    if (id !== null) {
      const i = s.segments.findIndex((x) => x.id === id)
      if (i >= 0) {
        start = s.segments[i].end
        end = s.segments[i + 1] ? Math.min(start + 2, s.segments[i + 1].start) : start + 2
        if (end - start < 0.3) end = start + 1
      }
    }
    const seg: SubtitleSegment = { id: maxId + 1, start, end, text: '' }
    const segments = [...s.segments, seg].sort((a, b) => a.start - b.start)
    set({ segments })
  },

  mergeSegmentWithNext: (id) => {
    const s = get()
    const i = s.segments.findIndex((x) => x.id === id)
    if (i < 0 || i >= s.segments.length - 1) return
    get().historyMark()
    const a = s.segments[i]
    const b = s.segments[i + 1]
    const merged: SubtitleSegment = { id: a.id, start: a.start, end: b.end, text: `${a.text} ${b.text}`.trim() }
    set({ segments: [...s.segments.slice(0, i), merged, ...s.segments.slice(i + 2)] })
  },

  startTranscribe: async () => {
    const s = get()
    if (!s.media || s.noAudio) return
    const installed = s.models?.installed.includes(s.lastModelId) ?? false
    if (!installed) {
      set({ pendingAutoTranscribe: true })
      await get().downloadModel(s.lastModelId)
      return
    }
    try {
      const { jobId } = await window.lalu.subs.transcribe({
        inputPath: s.media.path,
        audioTrack: s.subsAudioTrack,
        modelId: s.lastModelId,
        language: s.lastLanguage,
        translate: s.lastTranslate,
        vad: s.vadEnabled,
        preciseTiming: s.preciseTiming
      })
      set({ transcribeJobId: jobId })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  downloadModel: async (id) => {
    try {
      const { jobId } = await window.lalu.subs.downloadModel(id)
      set({ downloadJobId: jobId })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.download-failed', friendly: friendlyOf(e) })
    }
  },

  setSubsOption: (patch) => {
    set(patch as Partial<State>)
    if (patch.lastModelId !== undefined || patch.lastLanguage !== undefined || patch.lastTranslate !== undefined) {
      const s = get()
      get().patchSettings({
        lastModelId: s.lastModelId, lastLanguage: s.lastLanguage, lastTranslate: s.lastTranslate
      })
    }
  },

  setSubtitleStyle: (style) => {
    set({ subtitleStyle: style })
    get().patchSettings({ subtitleStyle: style })
  },

  // ---------- jobs ----------

  updateJob: (job) => {
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: job },
      jobOrder: s.jobOrder.includes(job.id) ? s.jobOrder : [...s.jobOrder, job.id]
    }))
    const s = get()

    // proxy completion -> playable url
    if (job.id === s.proxyJobId) {
      if (job.state === 'running') set({ proxyProgress: job.progress })
      if (job.state === 'done') {
        const url = (job.result as { url?: string } | null)?.url ?? null
        set({ playbackUrl: url, proxyJobId: null, proxyProgress: null })
      }
      if (job.state === 'error' || job.state === 'cancelled') {
        set({ proxyJobId: null, proxyProgress: null })
      }
    }

    // waveform
    if (job.id === s.waveJobId && job.state === 'done') {
      const data = job.result as { peaks?: number[] } | null
      set({ peaks: data?.peaks ?? null, waveJobId: null })
    }

    // thumbnails final
    if (job.id === s.thumbsJobId && job.state === 'done') {
      const data = job.result as { urls?: (string | null)[] } | null
      if (data?.urls) set({ thumbs: data.urls, thumbsJobId: null })
    }

    // transcription
    if (job.id === s.transcribeJobId && job.state !== 'running' && job.state !== 'queued') {
      if (job.state === 'done') {
        const res = job.result as TranscribeResult
        get().historyMark()
        set({
          segments: res.segments,
          detectedLang: res.language,
          usedModelId: res.modelId,
          transcribeJobId: null,
          cleanedCount: res.cleanedCount ?? 0,
          subsViewMode: 'original'
        })
        // Visible diagnostic: hallucination filtering is never silent.
        if ((res.cleanedCount ?? 0) > 0 || (res.repairedCount ?? 0) > 0) {
          get().toast({
            severity: 'info',
            titleKey: 'subs.cleanedToast',
            titleVars: { cleaned: res.cleanedCount ?? 0, repaired: res.repairedCount ?? 0 }
          })
        }
        // Reflect the truly-used acceleration in the status bar.
        if (s.sysInfo && s.sysInfo.whisperBackend !== res.backend) {
          set({ sysInfo: { ...s.sysInfo, whisperBackend: res.backend } })
        }
        // RTL language + untouched default font -> bundled Arabic-capable font,
        // so burn-in matches what the user sees without manual setup.
        if (RTL_LANGS.has(res.language) && s.subtitleStyle.fontFamily === 'Arial') {
          get().setSubtitleStyle({ ...s.subtitleStyle, fontFamily: 'Noto Sans Arabic' })
        }
      } else {
        set({ transcribeJobId: null })
      }
    }

    // batch transcription chaining
    if (s.batch.active && job.id === s.batch.jobId && job.state !== 'running' && job.state !== 'queued') {
      void advanceBatch(job)
    }

    // tighten-to-speech completion -> apply snapped boundaries (undo-able)
    if (job.id === s.tightenJobId && job.state !== 'running' && job.state !== 'queued') {
      set({ tightenJobId: null })
      if (job.state === 'done') {
        const res = job.result as { segments: SubtitleSegment[] }
        get().historyMark()
        set({ segments: res.segments })
        get().toast({ severity: 'success', titleKey: 'subs.tightened' })
      }
    }

    // translation completion -> merge into segments (undo-able)
    if (job.id === s.translateJobId && job.state !== 'running' && job.state !== 'queued') {
      set({ translateJobId: null })
      if (job.state === 'done') {
        const res = job.result as TranslateRunResult
        get().historyMark()
        set({
          segments: get().segments.map((seg) =>
            res.translations[seg.id] ? { ...seg, translation: res.translations[seg.id] } : seg),
          subsViewMode: 'both'
        })
        if (res.failedIds.length > 0) {
          get().toast({ severity: 'warning', titleKey: 'translate.partial', titleVars: { n: res.failedIds.length } })
        } else {
          get().toast({ severity: 'success', titleKey: 'translate.done' })
        }
      }
    }

    // model download -> refresh models, optionally chain into transcribe
    if (job.id === s.downloadJobId && job.state !== 'running' && job.state !== 'queued') {
      set({ downloadJobId: null })
      if (job.state === 'done') {
        const models = job.result as ModelsState | null
        if (models) set({ models })
        if (s.pendingAutoTranscribe) {
          set({ pendingAutoTranscribe: false })
          void get().startTranscribe()
        }
      } else {
        set({ pendingAutoTranscribe: false })
      }
    }
  },

  cancelJob: (id) => {
    void window.lalu.jobs.cancel(id)
  },

  // ---------- project files ----------

  buildProject: () => {
    const s = get()
    if (!s.media) return null
    return {
      app: 'lalukit',
      version: 1,
      savedAt: Date.now(),
      sourcePath: s.media.path,
      cutMode: s.cutMode,
      cutEngine: s.cutEngine,
      ranges: s.ranges,
      segments: s.segments,
      detectedLang: s.detectedLang,
      usedModelId: s.usedModelId,
      subtitleStyle: s.subtitleStyle
    }
  },

  saveProjectAs: async () => {
    const s = get()
    const project = get().buildProject()
    if (!project || !s.media) return
    const def = await suggestOutput(s.media.path, 'project', 'lalukit', s.exportDir)
    const path = await window.lalu.system.chooseSave({
      defaultPath: def,
      filters: [{ name: 'LaluKit project', extensions: ['lalukit'] }]
    })
    if (!path) return
    try {
      await window.lalu.project.save(path, project)
      get().toast({ severity: 'success', titleKey: 'project.saved' })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  openProject: async (path) => {
    try {
      const project = await window.lalu.project.load(path)
      await get().openFile(project.sourcePath, { force: true })
      const s = get()
      if (!s.media || s.media.path !== project.sourcePath) return
      const dur = s.media.durationSec
      set({
        cutMode: project.cutMode,
        ranges: (project.ranges ?? [])
          .filter((r) => r.start < dur)
          .map((r) => ({ ...r, end: Math.min(r.end, dur) })),
        segments: project.segments ?? [],
        detectedLang: project.detectedLang,
        usedModelId: project.usedModelId,
        past: [],
        future: []
      })
      get().setCutEngine(project.cutEngine)
      if (project.subtitleStyle) get().setSubtitleStyle(project.subtitleStyle)
      get().toast({ severity: 'success', titleKey: 'project.opened' })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  autosaveNow: async () => {
    const s = get()
    if (!s.media || (s.ranges.length === 0 && s.segments.length === 0)) return
    const project = get().buildProject()
    if (project) await window.lalu.project.autosave(project).catch(() => {})
  },

  offerRecovery: async () => {
    const rec = await window.lalu.project.recoveryPeek().catch(() => null)
    if (!rec || get().media) return
    get().toast({
      severity: 'info',
      titleKey: 'project.recoveryFound',
      titleVars: { name: baseName(rec.sourcePath) },
      sticky: true,
      action: {
        labelKey: 'project.restore',
        run: () => {
          void window.lalu.project.recoveryClear()
          void (async () => {
            await get().openFile(rec.sourcePath, { force: true })
            const s = get()
            if (!s.media) return
            set({
              cutMode: rec.cutMode,
              ranges: rec.ranges ?? [],
              segments: rec.segments ?? [],
              detectedLang: rec.detectedLang,
              usedModelId: rec.usedModelId,
              past: [],
              future: []
            })
          })()
        }
      }
    })
  },

  // ---------- batch transcription ----------

  startBatch: async (paths) => {
    const s = get()
    if (s.batch.active || paths.length === 0) return
    const installed = s.models?.installed.includes(s.lastModelId) ?? false
    if (!installed) {
      get().toast({ severity: 'warning', titleKey: 'batch.needModel' })
      return
    }
    const items: BatchItem[] = paths.map((p) => ({
      path: p, name: baseName(p), status: 'pending', srtPath: null
    }))
    set({ batch: { active: true, items, index: 0, jobId: null }, workspace: 'subtitles' })
    await launchBatchItem()
  },

  cancelBatch: () => {
    const s = get()
    if (s.batch.jobId) void window.lalu.jobs.cancel(s.batch.jobId)
    set({ batch: { active: false, items: [], index: 0, jobId: null } })
  },

  exportSubtitles: async (format) => {
    const s = get()
    if (!s.media || s.segments.length === 0) return
    const suffix = fileSuffixFor(s.subsViewMode, s.translate.targetLang, s.detectedLang)
    const def = await suggestOutput(s.media.path, suffix, format, s.exportDir)
    const path = await window.lalu.system.chooseSave({
      defaultPath: def,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    if (!path) return
    try {
      await window.lalu.subs.exportFile(composeSegments(s.segments, s.subsViewMode), format, path)
      get().toast({ severity: 'success', titleKey: 'subs.exported' })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  setSubsViewMode: (m) => set({ subsViewMode: m }),

  refreshApiKeys: async () => {
    try {
      set({ apiKeysState: await window.lalu.translate.hasKeys() })
    } catch { /* non-critical */ }
  },

  tightenTiming: async () => {
    const s = get()
    if (!s.media || s.segments.length === 0 || s.tightenJobId) return
    try {
      const { jobId } = await window.lalu.subs.tighten(s.media.path, s.segments)
      set({ tightenJobId: jobId })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  startTranslate: async () => {
    const s = get()
    if (s.segments.length === 0 || s.translateJobId) return
    // Online backends need a key; route the user to settings when missing.
    if (s.translate.backend !== 'nllb') {
      const keys = s.apiKeysState ?? (await window.lalu.translate.hasKeys().catch(() => null))
      if (keys && !keys[s.translate.backend]) {
        get().toast({ severity: 'warning', titleKey: 'translate.noKey' })
        set({ dialog: { kind: 'settings', tab: 'translation' } })
        return
      }
    }
    try {
      const { jobId } = await window.lalu.translate.run(s.segments, s.translate, s.detectedLang)
      set({ translateJobId: jobId })
    } catch (e) {
      get().toast({ severity: 'error', titleKey: 'error.generic', friendly: friendlyOf(e) })
    }
  },

  applyThumbsPartial: (p) => {
    const s = get()
    if (!s.media || s.media.id !== p.mediaId) return
    set({ thumbs: p.urls })
  }
}))

function recomputeMergePlan(
  set: (p: Partial<State>) => void,
  get: () => State
): void {
  const good = get().mergeItems.filter((i) => i.info)
  if (good.length === 0) {
    set({ mergePlan: null })
    return
  }
  void window.lalu.merge.probe(good.map((i) => i.path)).then((res) => {
    set({ mergePlan: res.plan })
  }).catch(() => set({ mergePlan: null }))
}

function friendlyOf(e: unknown): FriendlyError | null {
  if (e && typeof e === 'object' && 'friendly' in e) return (e as { friendly: FriendlyError }).friendly
  return null
}

// Starts the transcribe job for the current batch item.
async function launchBatchItem(): Promise<void> {
  const store = useStore.getState()
  const { batch } = store
  const item = batch.items[batch.index]
  if (!batch.active || !item) {
    if (batch.active) {
      useStore.setState({ batch: { ...batch, active: false, jobId: null } })
      store.toast({ severity: 'success', titleKey: 'batch.done', titleVars: { n: batch.items.filter((i) => i.status === 'done').length } })
    }
    return
  }
  try {
    const { jobId } = await window.lalu.subs.transcribe({
      inputPath: item.path,
      audioTrack: 0,
      modelId: store.lastModelId,
      language: store.lastLanguage,
      translate: store.lastTranslate,
      vad: store.vadEnabled,
      preciseTiming: store.preciseTiming
    })
    useStore.setState((s) => ({
      batch: {
        ...s.batch,
        jobId,
        items: s.batch.items.map((x, i) => (i === s.batch.index ? { ...x, status: 'working' } : x))
      }
    }))
  } catch {
    useStore.setState((s) => ({
      batch: {
        ...s.batch,
        items: s.batch.items.map((x, i) => (i === s.batch.index ? { ...x, status: 'error' } : x)),
        index: s.batch.index + 1,
        jobId: null
      }
    }))
    await launchBatchItem()
  }
}

// Handles completion of the current batch transcribe job: writes the SRT next
// to the source, then moves on.
async function advanceBatch(job: JobInfo): Promise<void> {
  const store = useStore.getState()
  const { batch } = store
  const item = batch.items[batch.index]
  if (!item) return
  let status: BatchItem['status'] = 'error'
  let srtPath: string | null = null
  if (job.state === 'done') {
    const res = job.result as TranscribeResult
    try {
      srtPath = await suggestOutput(item.path, res.language || 'subs', 'srt', null)
      await window.lalu.subs.exportFile(res.segments, 'srt', srtPath)
      status = 'done'
    } catch { /* leave as error */ }
  } else if (job.state === 'cancelled') {
    useStore.setState((s) => ({ batch: { ...s.batch, active: false, jobId: null } }))
    return
  }
  useStore.setState((s) => ({
    batch: {
      ...s.batch,
      jobId: null,
      items: s.batch.items.map((x, i) => (i === s.batch.index ? { ...x, status, srtPath } : x)),
      index: s.batch.index + 1
    }
  }))
  await launchBatchItem()
}

function applyChrome(theme: 'dark' | 'light', locale: 'en' | 'ar'): void {
  const html = document.documentElement
  html.classList.add('theme-anim')
  html.dataset.theme = theme
  html.lang = locale
  html.dir = locale === 'ar' ? 'rtl' : 'ltr'
  window.setTimeout(() => html.classList.remove('theme-anim'), 450)
}

// ---------- global event wiring (module init, once) ----------

let wired = false
export function wireGlobalEvents(): void {
  if (wired) return
  wired = true
  window.lalu.jobs.onUpdate((job) => useStore.getState().updateJob(job))
  window.lalu.media.onThumbsPartial((p) => useStore.getState().applyThumbsPartial(p))
  window.lalu.system.onOpenFile((path) => {
    if (path.toLowerCase().endsWith('.lalukit')) void useStore.getState().openProject(path)
    else void useStore.getState().openFile(path)
  })
  playerCtl.onTime((t) => {
    const s = useStore.getState()
    if (Math.abs(t - s.currentTimeCoarse) > 0.2) useStore.setState({ currentTimeCoarse: t })
  })
  playerCtl.notifyShuttle = (rate) => useStore.getState().setShuttleRate(rate)
}
