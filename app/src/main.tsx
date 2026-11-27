import { StrictMode, Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) }
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ color: '#f66', background: '#111', padding: 16, whiteSpace: 'pre-wrap' }}>
          {this.state.error}
        </pre>
      )
    }
    return this.props.children
  }
}

{
  const url = new URL(window.location.href)
  const nick = url.searchParams.get('nick')
  if (nick) {
    try {
      if (!localStorage.getItem('wt.nickname')) localStorage.setItem('wt.nickname', nick.trim().slice(0, 32))
    } catch { /* приватный режим */ }
    url.searchParams.delete('nick')
    window.history.replaceState(null, '', url.toString())
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
