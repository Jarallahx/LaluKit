// Contract implemented by the preload bridge and consumed by the renderer.
import type {
  ApiProvider, AppSettings, AttachOptions, BurnInOptions, CutExportOptions,
  DiskSpace, ExtractAudioOptions, GifExportOptions, JobInfo, MediaInfo,
  MergeExportOptions, MergePlan, ModelsState, ProjectFile, RecentFile,
  ReverseOptions, SaveDialogRequest, SubtitleSegment, SystemInfo, ThumbsPartial,
  TranscribeOptions, TranslateSettings, TranslateTestResult, WaveformData
} from './types'

export interface MergeProbeResult {
  items: { path: string; info: MediaInfo | null; errorCode: string | null; thumbUrl: string | null }[]
  plan: MergePlan | null
}

export interface LaluApi {
  system: {
    info(): Promise<SystemInfo>
    getSettings(): Promise<AppSettings>
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    getRecents(): Promise<RecentFile[]>
    removeRecent(path: string): Promise<RecentFile[]>
    clearRecents(): Promise<void>
    chooseOpen(multi: boolean): Promise<string[]>
    chooseSave(req: SaveDialogRequest): Promise<string | null>
    chooseDir(): Promise<string | null>
    showInFolder(path: string): Promise<void>
    openPath(path: string): Promise<void>
    openLog(): Promise<void>
    clearCache(): Promise<number>
    fonts(): Promise<string[]>
    diskSpace(dir: string): Promise<DiskSpace>
    setTitleBarTheme(theme: 'dark' | 'light'): Promise<void>
    pathExists(path: string): Promise<boolean>
    pathForFile(file: File): string | null
    onOpenFile(cb: (path: string) => void): () => void
    onSmoke(cb: (payload: { scenario: string; testVideo: string | null }) => void): () => void
  }
  media: {
    open(path: string): Promise<MediaInfo>
    requestTranscodeProxy(path: string): Promise<{ jobId: string }>
    waveform(path: string, track: number): Promise<{ jobId: string }>
    thumbs(path: string): Promise<{ jobId: string }>
    keyframes(path: string, t: number, windowSec: number): Promise<number[]>
    onThumbsPartial(cb: (p: ThumbsPartial) => void): () => void
  }
  cut: {
    export(opts: CutExportOptions): Promise<{ jobId: string }>
  }
  merge: {
    probe(paths: string[]): Promise<MergeProbeResult>
    plan(paths: string[]): Promise<MergePlan | null>
    export(opts: MergeExportOptions): Promise<{ jobId: string }>
  }
  subs: {
    models(): Promise<ModelsState>
    downloadModel(id: string): Promise<{ jobId: string }>
    deleteModel(id: string): Promise<ModelsState>
    transcribe(opts: TranscribeOptions): Promise<{ jobId: string }>
    tighten(inputPath: string, segments: SubtitleSegment[]): Promise<{ jobId: string }>
    exportFile(segments: SubtitleSegment[], format: 'srt' | 'vtt', path: string): Promise<void>
    burnIn(opts: BurnInOptions): Promise<{ jobId: string }>
    attach(opts: AttachOptions): Promise<{ jobId: string }>
  }
  extras: {
    extractAudio(opts: ExtractAudioOptions): Promise<{ jobId: string }>
    gif(opts: GifExportOptions): Promise<{ jobId: string }>
    reverse(opts: ReverseOptions): Promise<{ jobId: string }>
  }
  translate: {
    run(segments: SubtitleSegment[], cfg: TranslateSettings, sourceLang: string | null): Promise<{ jobId: string }>
    test(provider: ApiProvider): Promise<TranslateTestResult>
    setKey(provider: ApiProvider, key: string | null): Promise<Record<ApiProvider, boolean>>
    hasKeys(): Promise<Record<ApiProvider, boolean>>
  }
  project: {
    save(path: string, project: ProjectFile): Promise<void>
    load(path: string): Promise<ProjectFile>
    autosave(project: ProjectFile): Promise<void>
    recoveryPeek(): Promise<ProjectFile | null>
    recoveryClear(): Promise<void>
  }
  jobs: {
    cancel(id: string): Promise<void>
    list(): Promise<JobInfo[]>
    onUpdate(cb: (job: JobInfo) => void): () => void
  }
}

export type { WaveformData }
