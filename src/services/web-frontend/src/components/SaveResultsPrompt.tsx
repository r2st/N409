import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

interface SaveResultsPromptProps {
  toolName: string;
  className?: string;
}

export function SaveResultsPrompt({ toolName, className = '' }: SaveResultsPromptProps) {
  const { status } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (status === 'authenticated' || dismissed) return null;

  return (
    <div
      className={`rounded-lg border border-paper-300 bg-surface p-5 ${className}`}
      data-testid="save-results-prompt"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-bond-100 p-2 text-bond-700">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Save your {toolName} results
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Create a free account to save results, track changes over time, and get personalized
              recommendations. Your data stays yours.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href="/api/v1/auth/google"
                className="inline-flex items-center gap-1.5 rounded-md border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm transition-colors hover:bg-paper-50"
                data-testid="sso-google"
              >
                <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.7 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.5 17.7 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.4 6.9-17.7z" />
                  <path fill="#FBBC05" d="M10.5 28.6a14.5 14.5 0 0 1 0-9.2l-7.9-6.2a24 24 0 0 0 0 21.6l7.9-6.2z" />
                  <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.6l-7.7-6c-2.1 1.4-4.8 2.3-7.5 2.3-6.3 0-11.6-4-13.5-9.6l-7.9 6.2C6.5 42.6 14.6 48 24 48z" />
                </svg>
                Google
              </a>
              <Link
                to="/register"
                className="inline-flex items-center gap-1.5 rounded-md border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm transition-colors hover:bg-paper-50"
                data-testid="signup-email"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M22 7l-10 7L2 7" />
                </svg>
                Email
              </Link>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 cursor-pointer rounded p-1 text-ink-400 transition-colors hover:text-ink-600"
          aria-label="Dismiss signup prompt"
          data-testid="dismiss-prompt"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
