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
 * Is this the failure of a code-split chunk rather than a bug in the page?
 *
 * Every page below the marketing entry is loaded with `React.lazy`, so a page
 * transition is a network fetch that can fail: the build was replaced while the
 * tab was open and the hashed URL is gone, an intermediary served a stale
 * document, or the connection dropped between screens.
 *
 * It matters because `React.lazy` caches the *rejection*. Once a chunk's import
 * has failed, every subsequent render of that component re-throws the stored
 * error without touching the network — so "Try again", which only clears this
 * boundary's state and re-renders the same children, cannot ever succeed. It
 * was a button that reproduced the same screen for as long as the user was
 * willing to press it, next to a message blaming an "unexpected error" for what
 * is usually just a deploy. Reloading is the only thing that fixes it, and so
 * it is the only thing offered.
 *
 * The strings are the ones the engines actually raise; no two agree.
 *   Chrome   "Failed to fetch dynamically imported module: https://…"
 *   Firefox  "error loading dynamically imported module: https://…"
 *   Safari   "Importing a module script failed."
 *   webpack  a ChunkLoadError, by name, for anything built with it
 */
export function isChunkLoadError(error: Error): boolean {
  if (error.name === 'ChunkLoadError') return true;
  return /dynamically imported module|importing a module script failed|loading chunk \S+ failed/i.test(
    error.message,
  );
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
    // The last resort for a render crash: without this the error is lost and
    // the user is left with a fallback and no way to say what happened.
    // eslint-disable-next-line no-console
    else console.error('Unhandled render error:', error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    if (isChunkLoadError(error)) {
      return (
        <div
          role="alert"
          className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-6 text-center"
        >
          <h1 className="text-xl font-semibold text-ink-900">This page didn’t finish loading</h1>
          <p className="text-sm text-ink-600">
            Part of the app couldn’t be downloaded — usually because a new version was released while this tab
            was open. Your data is safe. Reloading picks up the new version.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="tap-area cursor-pointer rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-bond-fg hover:bg-bond-700"
          >
            Reload
          </button>
        </div>
      );
    }

    return (
      <div
        role="alert"
        className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <h1 className="text-xl font-semibold text-ink-900">Something went wrong</h1>
        <p className="text-sm text-ink-600">
          An unexpected error interrupted {this.props.label ?? 'the page'}. Your data is safe — try again, and
          if it keeps happening, reload.
        </p>
        <div className="flex gap-3">
          <button
            onClick={this.reset}
            className="tap-area cursor-pointer rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-bond-fg hover:bg-bond-700"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="tap-area cursor-pointer rounded-md border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-paper-50"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
