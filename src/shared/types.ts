// Types shared by main, preload and renderer.

// ---------- media ----------

export interface VideoStreamInfo {
  codec: string
  width: number
  height: number
  fps: number
  pixFmt: string
  bitrate: number | null
  rotation: number
}

export interface AudioStreamInfo {
  index: number
  codec: string
  sampleRate: number
  channels: number
  lang: string | null
  title: string | null
}

export type PlaybackMode = 'direct' | 'remux' | 'transcode'

export interface MediaInfo {
  id: string
  path: string
  fileName: string
  dirName: string
  sizeBytes: number
  container: string
  durationSec: number
  kind: 'video' | 'audio'
  video: VideoStreamInfo | null
  audioTracks: AudioStreamInfo[]
  subtitleTrackCount: number
  playback: {
    mode: PlaybackMode
    url: string | null // set when mode is 'direct', otherwise arrives via proxy job
    proxyJobId: string | null
  }
}

export interface WaveformData {
  buckets: number
  peaks: number[] // interleaved min,max pairs in -1..1
}

export interface ThumbsPartial {
  mediaId: string
  urls: (string | null)[] // sparse while generating
  done: boolean
}

// ---------- jobs ----------

export type JobKind =
  | 'proxy'
  | 'waveform'
  | 'thumbnails'
  | 'cut'
  | 'merge'
  | 'transcribe'
  | 'model-download'
  | 'burn-in'
  | 'attach-subs'
  | 'extract-audio'
  | 'gif'
  | 'reverse'
  | 'translate'
  | 'tighten'

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface FriendlyError {
  code: string // i18n key suffix, e.g. 'disk-full'
  message: string // english fallback, always present
  hint?: string
  logExcerpt?: string
}

export interface JobInfo {
  id: string
  kind: JobKind
  label: string
  detail: string | null
  progress: number | null // 0..1, null = indeterminate
  etaSec: number | null
  state: JobState
  error: FriendlyError | null
  result: unknown
  outputPath: string | null
  createdAt: number
  cancellable: boolean
}

// ---------- cutting ----------

export interface CutRange {
  id: string
  start: number
  end: number
  speed?: number // 0.25..4, default 1 (exact engine only)
  volume?: number // 0..3, default 1 (exact engine only)
}

export type CutMode = 'keep' | 'remove'
export type CutEngine = 'exact' | 'lossless'
export type QualityPreset = 'best' | 'balanced' | 'fast'

export interface WatermarkOptions {
  kind: 'image' | 'text'
  imagePath?: string
  text?: string
  position: 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'
  opacity: number // 0..1
  scale: number // image: fraction of video width (0.05..0.5); text: font size @720p
}

export interface CropOptions {
  ratio: '16:9' | '9:16' | '1:1' | '4:5' | '21:9' | 'custom'
  customW?: number
  customH?: number
  panX: number // -1..1, 0 = centered
  panY: number
}

export interface CutExportOptions {
  inputPath: string
  ranges: { start: number; end: number; speed?: number; volume?: number }[]
  mode: CutMode
  engine: CutEngine
  quality: QualityPreset
  useHardware: boolean
  outputPath: string
  loudnorm?: boolean
  watermark?: WatermarkOptions | null
  crop?: CropOptions | null
}

export interface GifExportOptions {
  inputPath: string
  start: number
  end: number
  fps: 10 | 15 | 24
  maxWidth: 480 | 720 | 1080
  loop: number // 0 = forever
  outputPath: string
}

export interface ExtractAudioOptions {
  inputPath: string
  format: 'mp3' | 'wav'
  outputPath: string
}

export interface ReverseOptions {
  inputPath: string
  start: number | null // null = whole file
  end: number | null
  quality: QualityPreset
  useHardware: boolean
  outputPath: string
}

export interface ProjectFile {
  app: 'lalukit'
  version: 1
  savedAt: number
  sourcePath: string
  cutMode: CutMode
  cutEngine: CutEngine
  ranges: CutRange[]
  segments: SubtitleSegment[]
  detectedLang: string | null
  usedModelId: string | null
  subtitleStyle: SubtitleStyle
}

// ---------- merge ----------

export interface MergePlan {
  fastConcat: boolean
  width: number
  height: number
  fps: number
  reasons: string[] // i18n key suffixes explaining why normalization is needed
}

export interface MergeExportOptions {
  inputs: string[]
  outputPath: string
  quality: QualityPreset
  useHardware: boolean
}

// ---------- subtitles ----------

export interface SubtitleSegment {
  id: number
  start: number
  end: number
  text: string
  translation?: string // filled by the translate step
}

export interface WhisperModel {
  id: string
  label: string
  sizeMB: number
  ramGB: number
  speed: 1 | 2 | 3 | 4 | 5 // 5 = fastest
  quality: 1 | 2 | 3 | 4 | 5 // 5 = best
  multilingual: boolean
  recommended?: boolean
}

export interface ModelsState {
  catalog: WhisperModel[]
  installed: string[]
}

export interface TranscribeOptions {
  inputPath: string
  audioTrack: number
  modelId: string
  language: string // 'auto' or whisper language code
  translate: boolean
  vad?: boolean // Silero VAD pre-filter: skip non-speech; default on
  preciseTiming?: boolean // word-level rebuild + speech clamping; default on
}

export interface TranscribeResult {
  segments: SubtitleSegment[]
  language: string
  modelId: string
  backend: 'cuda' | 'cpu'
  cleanedCount: number // hallucinated lines auto-removed
  repairedCount: number // suspicious lines fixed by re-transcription
  vadUsed: boolean
}

export interface SubtitleStyle {
  fontFamily: string
  fontSize: number // expressed at 720p height, scaled to the video
  bold: boolean
  color: string // #rrggbb
  outlineColor: string
  outlineWidth: number // 0..6
  background: boolean
  position: 'bottom' | 'middle' | 'top'
  marginV: number // px at 720p
}

export interface BurnInOptions {
  inputPath: string
  segments: SubtitleSegment[]
  style: SubtitleStyle
  quality: QualityPreset
  useHardware: boolean
  outputPath: string
}

export interface AttachOptions {
  inputPath: string
  segments: SubtitleSegment[]
  language: string // whisper code or 'und'
  outputPath: string
}

// ---------- translation ----------

export type TranslateBackend = 'claude' | 'openai' | 'deepl' | 'google' | 'nllb'
export type ApiProvider = Exclude<TranslateBackend, 'nllb'>

export interface TranslateSettings {
  backend: TranslateBackend
  claudeModel: string
  openaiModel: string
  targetLang: string // whisper iso code, default 'ar'
}

export interface TranslateRunResult {
  translations: Record<number, string> // segment id -> translated text
  failedIds: number[]
  provider: TranslateBackend
}

export interface TranslateTestResult {
  ok: boolean
  message: string
  sample?: string
}

// ---------- settings / system ----------

export interface AppSettings {
  theme: 'dark' | 'light'
  locale: 'en' | 'ar'
  exportDir: string | null
  quality: QualityPreset
  useHardware: boolean
  snapping: boolean
  cutEngine: CutEngine
  lastModelId: string
  lastLanguage: string
  lastTranslate: boolean
  vadEnabled: boolean
  preciseTiming: boolean
  subtitleStyle: SubtitleStyle
  translate: TranslateSettings
  volume: number
  muted: boolean
}

export interface RecentFile {
  path: string
  name: string
  durationSec: number
  kind: 'video' | 'audio'
  openedAt: number
  thumbUrl?: string | null // enriched on read from the thumbnail cache
}

export interface SystemInfo {
  version: string
  logPath: string
  modelsDir: string
  cacheDir: string
  binsOk: boolean
  hwEncoders: string[] // subset of ['nvenc','qsv','amf']
  whisperBackend: 'cuda' | 'cpu'
  cacheSizeBytes: number
}

export interface SaveDialogRequest {
  defaultPath: string
  filters: { name: string; extensions: string[] }[]
}

export interface DiskSpace {
  freeBytes: number
}

// Whisper language list (code -> english name) lives in shared so both
// renderer (picker) and main (metadata) agree.
export const WHISPER_LANGUAGES: [string, string][] = [
  ['auto', 'Auto-detect'],
  ['en', 'English'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['de', 'German'],
  ['es', 'Spanish'], ['ru', 'Russian'], ['ko', 'Korean'], ['fr', 'French'],
  ['ja', 'Japanese'], ['pt', 'Portuguese'], ['tr', 'Turkish'], ['pl', 'Polish'],
  ['ca', 'Catalan'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['it', 'Italian'],
  ['id', 'Indonesian'], ['hi', 'Hindi'], ['fi', 'Finnish'], ['vi', 'Vietnamese'],
  ['he', 'Hebrew'], ['uk', 'Ukrainian'], ['el', 'Greek'], ['ms', 'Malay'],
  ['cs', 'Czech'], ['ro', 'Romanian'], ['da', 'Danish'], ['hu', 'Hungarian'],
  ['ta', 'Tamil'], ['no', 'Norwegian'], ['th', 'Thai'], ['ur', 'Urdu'],
  ['hr', 'Croatian'], ['bg', 'Bulgarian'], ['lt', 'Lithuanian'], ['la', 'Latin'],
  ['mi', 'Maori'], ['ml', 'Malayalam'], ['cy', 'Welsh'], ['sk', 'Slovak'],
  ['te', 'Telugu'], ['fa', 'Persian'], ['lv', 'Latvian'], ['bn', 'Bengali'],
  ['sr', 'Serbian'], ['az', 'Azerbaijani'], ['sl', 'Slovenian'], ['kn', 'Kannada'],
  ['et', 'Estonian'], ['mk', 'Macedonian'], ['br', 'Breton'], ['eu', 'Basque'],
  ['is', 'Icelandic'], ['hy', 'Armenian'], ['ne', 'Nepali'], ['mn', 'Mongolian'],
  ['bs', 'Bosnian'], ['kk', 'Kazakh'], ['sq', 'Albanian'], ['sw', 'Swahili'],
  ['gl', 'Galician'], ['mr', 'Marathi'], ['pa', 'Punjabi'], ['si', 'Sinhala'],
  ['km', 'Khmer'], ['sn', 'Shona'], ['yo', 'Yoruba'], ['so', 'Somali'],
  ['af', 'Afrikaans'], ['oc', 'Occitan'], ['ka', 'Georgian'], ['be', 'Belarusian'],
  ['tg', 'Tajik'], ['sd', 'Sindhi'], ['gu', 'Gujarati'], ['am', 'Amharic'],
  ['yi', 'Yiddish'], ['lo', 'Lao'], ['uz', 'Uzbek'], ['fo', 'Faroese'],
  ['ht', 'Haitian Creole'], ['ps', 'Pashto'], ['tk', 'Turkmen'], ['nn', 'Nynorsk'],
  ['mt', 'Maltese'], ['sa', 'Sanskrit'], ['lb', 'Luxembourgish'], ['my', 'Myanmar'],
  ['bo', 'Tibetan'], ['tl', 'Tagalog'], ['mg', 'Malagasy'], ['as', 'Assamese'],
  ['tt', 'Tatar'], ['haw', 'Hawaiian'], ['ln', 'Lingala'], ['ha', 'Hausa'],
  ['ba', 'Bashkir'], ['jw', 'Javanese'], ['su', 'Sundanese'], ['yue', 'Cantonese']
]

// RTL whisper languages (for dir=auto fallbacks and SRT preview alignment).
export const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi'])
