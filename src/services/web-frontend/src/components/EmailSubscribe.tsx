import { useCallback, useState } from 'react';
import { api, ApiError } from '../lib/api';

export function EmailSubscribe() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = email.trim();
      if (!trimmed) return;
      setStatus('submitting');
      setErrorMsg('');
      try {
        await api('/api/v1/subscribe', { method: 'POST', body: { email: trimmed } });
        setStatus('success');
        setEmail('');
      } catch (err) {
        setStatus('error');
        setErrorMsg(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    },
    [email],
  );

  if (status === 'success') {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-center" role="status">
        <p className="text-sm font-semibold text-emerald-800">You're subscribed!</p>
        <p className="mt-1 text-xs text-emerald-700">
          We'll let you know about 409A compliance deadlines and updates.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label htmlFor="subscribe-email" className="block text-sm font-medium text-ink-700">
          Get notified about 409A compliance deadlines
        </label>
        <input
          id="subscribe-email"
          type="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-bond-500 focus:outline-none focus:ring-1 focus:ring-bond-500"
          disabled={status === 'submitting'}
          aria-describedby={status === 'error' ? 'subscribe-error' : undefined}
        />
        {status === 'error' && (
          <p id="subscribe-error" className="mt-1 text-xs text-red-600" role="alert">
            {errorMsg}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="shrink-0 rounded-md bg-bond-600 px-5 py-2 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700 disabled:opacity-60"
      >
        {status === 'submitting' ? 'Subscribing…' : 'Subscribe'}
      </button>
    </form>
  );
}
