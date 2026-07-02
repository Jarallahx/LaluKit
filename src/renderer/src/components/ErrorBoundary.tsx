import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n'
import { Button } from '@/ui/primitives'

interface State {
  error: Error | null
}

// Last line of defense: a crashed component tree shows a friendly recovery
// screen instead of a white window. The error itself goes to the main log
// via console (forwarded by electron-log).
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('renderer crash:', error.message, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const locale = (document.documentElement.lang === 'ar' ? 'ar' : 'en') as 'en' | 'ar'
    return (
      <div className="boundary">
        <AlertTriangle size={36} className="boundary-icon" />
        <h1>{translate(locale, 'error.title')}</h1>
        <p>{translate(locale, 'error.boundary')}</p>
        <div className="boundary-actions">
          <Button variant="ghost" onClick={() => void window.lalu.system.openLog()}>
            {translate(locale, 'jobs.openLog')}
          </Button>
          <Button variant="primary" onClick={() => window.location.reload()}>
            {translate(locale, 'error.reload')}
          </Button>
        </div>
      </div>
    )
  }
}
