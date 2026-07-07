import type { ReactNode } from 'react';
import { LogoMark, Wordmark } from './Logo';

/** Split-panel shell for the sign-in / registration pages. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-paper-100">
      {/* Brand panel */}
      <div className="ledger-grid relative hidden w-[44%] flex-col justify-between overflow-hidden bg-ink-900 p-12 lg:flex">
        <Wordmark light />
        <div>
          <div className="overline mb-5 text-brass-400">Independent · Defensible · Audit-ready</div>
          <h1 className="font-display text-[2.6rem] leading-[1.12] font-medium text-paper-50">
            Valuations built for
            <br />
            scrutiny, delivered
            <br />
            with <em className="text-brass-300 not-italic underline decoration-bond-500 decoration-2 underline-offset-8">precision</em>.
          </h1>
          <p className="mt-6 max-w-sm text-[0.95rem] leading-relaxed text-ink-300">
            IRC §409A common-stock valuations and a full family of fair-value opinions — AI-assisted
            intake, analyst-reviewed, engine-computed.
          </p>
        </div>
        <div className="flex items-center gap-6 text-xs text-ink-400">
          <span>§409A</span>
          <span className="h-px flex-1 bg-ink-700" />
          <span>ASC 718 · 820</span>
          <span className="h-px flex-1 bg-ink-700" />
          <span>QSBS · Gift & Estate</span>
        </div>
        {/* Soft glow accent */}
        <div className="pointer-events-none absolute -right-32 -bottom-32 h-96 w-96 rounded-full bg-bond-700/25 blur-3xl" />
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="flex items-center gap-2.5">
              <LogoMark size={34} />
              <span className="font-display text-2xl font-semibold text-ink-900">N409</span>
            </span>
          </div>
          <h2 className="font-display text-2xl font-semibold text-ink-900">{title}</h2>
          <p className="mt-1.5 mb-8 text-sm text-ink-400">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
