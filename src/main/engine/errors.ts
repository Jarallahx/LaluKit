import type { FriendlyError } from '@shared/types'

// Error carrying a user-presentable payload. The renderer localizes by `code`;
// `message` is the english fallback and what lands in the log.
export class EngineError extends Error {
  friendly: FriendlyError
  constructor(friendly: FriendlyError) {
    super(friendly.message)
    this.name = 'EngineError'
    this.friendly = friendly
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export function err(code: string, message: string, hint?: string, logExcerpt?: string): EngineError {
  return new EngineError({ code, message, hint, logExcerpt })
}

// Maps ffmpeg/ffprobe stderr to a friendly error. Order matters: most
// specific patterns first.
export function mapFfmpegError(stderrTail: string, exitCode: number | null): EngineError {
  const s = stderrTail
  const excerpt = s.slice(-500).trim()
  if (/no space left|not enough space|disk (is )?full|enospc/i.test(s)) {
    return err('disk-full', 'There is not enough free disk space to finish this operation.', 'Free up some space on the output drive and try again.', excerpt)
  }
  if (/permission denied|access is denied|eacces|eperm/i.test(s)) {
    return err('permission', 'LaluKit was not allowed to write to that location.', 'Choose a different output folder, or close any app using the file.', excerpt)
  }
  if (/no such file or directory|could not open file|cannot find/i.test(s)) {
    return err('not-found', 'A file involved in this operation could not be found.', 'The file may have been moved or renamed. Re-open it and try again.', excerpt)
  }
  if (/cannot load nvcuda|no nvenc capable|incompatible.*driver|failed to create.*(nvenc|qsv|amf)|error initializing output stream.*(nvenc|qsv|amf)|cannot open encoder|no capable devices|mfx.*error|d3d11va/i.test(s)) {
    return err('hw-encoder', 'The hardware video encoder failed to start.', 'Disable "Use hardware encoder" in the export options and try again.', excerpt)
  }
  if (/invalid data found when processing input|moov atom not found|could not find codec parameters|header missing|invalid as first byte|ebml header parsing failed|does not contain any stream/i.test(s)) {
    return err('corrupt', "This file couldn't be read. It may be corrupt or use an unsupported format.", 'Try re-downloading or re-exporting the source file.', excerpt)
  }
  if (/matches no streams|stream specifier.*matches no|output file does not contain any stream/i.test(s)) {
    return err('no-stream', 'The file is missing the audio or video stream this operation needs.', undefined, excerpt)
  }
  if (exitCode === null) {
    return err('ffmpeg-crash', 'The media engine stopped unexpectedly.', 'Check the log for details and try again.', excerpt)
  }
  return err('ffmpeg-failed', 'The media engine reported an error.', 'Check the log for details.', excerpt)
}
