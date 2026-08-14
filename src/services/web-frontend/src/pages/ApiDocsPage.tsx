import { ApiReference } from '../components/ApiReference';

/**
 * The signed-in partner console's API reference. The reference itself is
 * shared with the public `/developers` page — the docs endpoint it reads is
 * unauthenticated, so there is one renderer and no second copy to drift.
 */
export function ApiDocsPage() {
  return (
    <div className="max-w-3xl">
      <div className="overline text-ink-400">Partner API</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">API reference</h1>
      <p className="mt-1 text-sm text-ink-400">
        Programmatic valuation submission — create engagements, upload documents, poll status, and retrieve
        results from your own systems.
      </p>
      <ApiReference />
    </div>
  );
}
