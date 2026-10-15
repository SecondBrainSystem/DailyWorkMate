import React from 'react'
import i18n from '@/i18n'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

interface ErrorBoundaryProps {
  children: React.ReactNode
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.setState({ errorInfo })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{
            minHeight: '100vh',
            padding: '3rem 1.5rem',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
          }}
        >
          <div
            style={{
              maxWidth: '48rem',
              margin: '0 auto',
              padding: '1.5rem',
              borderRadius: '14px',
              background: 'var(--glass-bg)',
              border: '1px solid var(--glass-border)',
              boxShadow: 'var(--shadow-md)',
            }}
          >
            <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--error)' }}>{i18n.t('errorBoundary.title', 'Application error')}</h1>
            <p style={{ marginTop: '0.25rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {i18n.t('errorBoundary.description', 'Something went wrong while rendering this page. Reloading usually recovers it.')}
            </p>
            <pre
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1rem',
                borderRadius: '10px',
                overflow: 'auto',
                maxWidth: '100%',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
                fontSize: '0.8125rem',
                color: 'var(--error)',
                background: 'color-mix(in srgb, var(--error) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--error) 25%, transparent)',
              }}
            >
              {this.state.error?.toString()}
            </pre>
            {this.state.errorInfo && (
              <details style={{ marginTop: '0.75rem' }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-muted)' }}>{i18n.t('errorBoundary.componentStack', 'Component stack')}</summary>
                <pre
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.75rem 1rem',
                    borderRadius: '10px',
                    overflow: 'auto',
                    maxWidth: '100%',
                    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--glass-border)',
                  }}
                >
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: '1.25rem',
                padding: '0.5rem 1.25rem',
                borderRadius: '10px',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 500,
                color: '#fff',
                background: 'hsl(var(--primary))',
              }}
            >
              {i18n.t('errorBoundary.reload', 'Reload')}
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
