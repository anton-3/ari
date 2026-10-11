import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface State {
  error: Error | null
}

// Keeps a render error in the map from blanking the whole page: shows an
// in-style error line and lets the user retry (re-mount the view).
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ari graph] render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="gx-nofeed iso-nofeed" role="alert">
        <div className="gx-nofeed-h iso-nofeed-h">MAP RENDER ERROR</div>
        <div className="gx-nofeed-sub iso-nofeed-sub">{this.state.error.message}</div>
        <button type="button" className="gx-btn iso-btn" onClick={() => this.setState({ error: null })}>
          RELOAD VIEW
        </button>
      </div>
    )
  }
}
