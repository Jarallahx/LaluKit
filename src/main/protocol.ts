import { net, protocol } from 'electron'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import log from './logger'

// media:// serves local files to the renderer. Requests are delegated to
// Electron's file:// loader (net.fetch), which implements the Range semantics
// the <video> demuxer needs. Only explicitly registered paths are reachable —
// the renderer cannot read arbitrary disk locations.
const allowed = new Set<string>()

export function registerMediaPath(p: string): string {
  const norm = path.normalize(p)
  allowed.add(norm.toLowerCase())
  return mediaUrl(norm)
}

export function mediaUrl(p: string): string {
  return `media://local/${Buffer.from(path.normalize(p), 'utf8').toString('base64url')}`
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.weba': 'audio/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png'
}

export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: { standard: true, stream: true, supportFetchAPI: true, bypassCSP: true }
    }
  ])
}

// Standard single-range parsing: "bytes=a-b", "bytes=a-", "bytes=-suffix".
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return null
  return { start, end }
}

export function installMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url)
      const encoded = url.pathname.replace(/^\//, '')
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8')
      if (!allowed.has(path.normalize(filePath).toLowerCase())) {
        log.warn(`media:// blocked unregistered path: ${filePath}`)
        return new Response('forbidden', { status: 403 })
      }
      // Electron's file loader slices Range requests correctly but answers
      // with a bare 200 and no range headers, which makes <video> consider
      // the source unseekable. Delegate the byte handling to it, then restore
      // proper 206/Content-Range/Accept-Ranges semantics around the body.
      const res = await net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
      if (!res.ok || !res.body) return res

      const size = (await stat(filePath)).size
      const headers = new Headers()
      const mime = MIME[path.extname(filePath).toLowerCase()]
      headers.set('content-type', mime ?? res.headers.get('content-type') ?? 'application/octet-stream')
      headers.set('accept-ranges', 'bytes')

      const rangeHeader = request.headers.get('range')
      const range = rangeHeader ? parseRange(rangeHeader, size) : null
      if (range) {
        headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
        headers.set('content-length', String(range.end - range.start + 1))
        return new Response(res.body, { status: 206, headers })
      }
      if (rangeHeader && !range) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      }
      headers.set('content-length', String(size))
      return new Response(res.body, { status: 200, headers })
    } catch (e) {
      log.warn('media:// request failed:', e)
      return new Response('not found', { status: 404 })
    }
  })
}
