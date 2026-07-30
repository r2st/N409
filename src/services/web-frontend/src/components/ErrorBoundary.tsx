import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional custom fallback; receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional hook for error reporting (telemetry). */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Label shown in the default fallback (e.g. "workspace"). */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary (audit F-1 P1). Before this, any uncaught render
 * error blanked the entire SPA with no recovery and no telemetry. Now a render
 * throw is caught and a recoverable fallback is shown; the error is reported via
 * onError (default: console.error) rather than lost.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) this.props.onError(error, info);
    else console.error('Unhandled render error:', error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <h1 className="text-xl font-semibold text-slate-900">Something went wrong</h1>
        <p className="text-sm text-slate-600">
          An unexpected error interrupted {this.props.label ?? 'the page'}. Your data is safe — try
          again, and if it keeps happening, reload.
        </p>
        <div className="flex gap-3">
          <button
            onClick={this.reset}
            className="cursor-pointer rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-bond-fg hover:bg-bond-700"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="cursor-pointer rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
