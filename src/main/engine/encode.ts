import type { QualityPreset } from '@shared/types'

export type HwEncoder = 'nvenc' | 'qsv' | 'amf'

// Builds the video encoder argument block for a quality preset, optionally on
// a hardware encoder. All paths produce 8-bit H.264 so segments can be
// concatenated and every player can read the result.
export function videoEncodeArgs(quality: QualityPreset, hw: HwEncoder | null): string[] {
  if (hw === 'nvenc') {
    const cq = quality === 'best' ? '19' : quality === 'balanced' ? '23' : '27'
    const preset = quality === 'best' ? 'p6' : 'p5'
    return ['-c:v', 'h264_nvenc', '-preset', preset, '-tune', 'hq', '-rc', 'vbr', '-cq', cq,
      '-b:v', '0', '-rc-lookahead', '20', '-spatial-aq', '1', '-bf', '3', '-pix_fmt', 'yuv420p']
  }
  if (hw === 'qsv') {
    const q = quality === 'best' ? '19' : quality === 'balanced' ? '23' : '27'
    return ['-c:v', 'h264_qsv', '-global_quality', q, '-pix_fmt', 'nv12']
  }
  if (hw === 'amf') {
    const q = quality === 'best' ? '19' : quality === 'balanced' ? '23' : '27'
    return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', q, '-qp_p', q, '-quality', 'balanced', '-pix_fmt', 'yuv420p']
  }
  const crf = quality === 'best' ? '17' : quality === 'balanced' ? '20' : '23'
  const preset = quality === 'best' ? 'slow' : 'veryfast'
  return ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p']
}

export function audioEncodeArgs(): string[] {
  return ['-c:a', 'aac', '-b:a', '192k']
}

export function isHwEncoderError(code: string): boolean {
  return code === 'hw-encoder'
}

export function containerExtras(outputPath: string): string[] {
  const lower = outputPath.toLowerCase()
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v') || lower.endsWith('.mov') || lower.endsWith('.m4a')) {
    return ['-movflags', '+faststart']
  }
  return []
}
