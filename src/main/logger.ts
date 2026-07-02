import log from 'electron-log/main'
import path from 'node:path'
import { app } from 'electron'

export function initLogger(): void {
  log.initialize()
  log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'lalukit.log')
  log.transports.file.maxSize = 2 * 1024 * 1024
  log.transports.file.level = 'info'
  log.transports.console.level = app.isPackaged ? false : 'info'
  log.errorHandler.startCatching({
    showDialog: false,
    onError: ({ error }) => log.error('uncaught:', error)
  })
}

export function logPath(): string {
  return log.transports.file.getFile().path
}

export default log
