import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Button, ErrorNote, Field, TextInput, inputClass } from './ui';

interface HelpTopic {
  id: string;
  title: string;
  keywords: string;
  body: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started with a valuation',
    keywords: 'new create begin start valuation request',
    body: 'Create a valuation from "New valuation", pick the product kind (409A, patent, …) and your company name. The workspace then guides you through documents, methodology params and the report. Your progress is visible on the Overview tab at every step.',
  },
  {
    id: 'documents',
    title: 'Uploading documents',
    keywords: 'upload file document cap table financials pdf csv',
    body: 'Open your valuation → Documents. Upload the cap table, income statement, balance sheet, projections, articles of incorporation and option grants. PDF, CSV, TSV, TXT, MD and JSON are machine-readable; run the AI "Missing data check" afterwards to see what is still needed.',
  },
  {
    id: 'params',
    title: 'Methodology params',
    keywords: 'params weights dlom dloc approach methodology',
    body: 'Params define the methodology: the four approach weights (asset, OPM, income, market) must sum to 1.0, plus DLOC/DLOM settings and the market method. Analysts set these — clients can review them read-only.',
  },
  {
    id: 'calculations',
    title: 'Running calculations',
    keywords: 'calculate compute engine fmv fair market value recalculate',
    body: 'Calculations combine saved params with AI-extracted inputs and comparables. Run a full calculation first; afterwards you can recalculate a single approach (asset, OPM, income or market) without re-running everything else.',
  },
  {
    id: 'report',
    title: 'Reports and versions',
    keywords: 'report pdf draft publish version editor',
    body: 'The Report tab holds the sectioned report with immutable version history. Ops edit and render the PDF; the report becomes visible to clients once the valuation reaches the draft states, and publishing locks the engagement.',
  },
  {
    id: 'states',
    title: 'Valuation states',
    keywords: 'state status lifecycle pending started published waiting',
    body: 'Valuations move through a 14-state lifecycle from pending to published. "Waiting on client" flags that we need something from you — check the chat thread on the Overview tab for what is blocking.',
  },
  {
    id: 'access',
    title: 'Who can see what',
    keywords: 'roles permissions access partner client ops team',
    body: 'Clients see their own valuations; partners see their channel; operations see everything. Working tabs (Workbook, Overwrites, AI, Calculations) are operations-only. Reports become client-visible from the draft stage onward.',
  },
];

export function filterTopics(topics: HelpTopic[], query: string): HelpTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return topics;
  return topics.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.keywords.includes(q) ||
      t.body.toLowerCase().includes(q),
  );
}

function ContactForm({ onSent }: { onSent: () => void }) {
  const location = useLocation();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await api('/support/messages', {
        method: 'POST',
        body: { subject, body, page_path: location.pathname },
      });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your message.');
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <Field label="Subject">
        <TextInput
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={300}
          placeholder="What do you need help with?"
        />
      </Field>
      <Field label="Message">
        <textarea
          className={`${inputClass} min-h-28`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={20000}
          placeholder="Tell us what happened or what you're trying to do…"
        />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" disabled={sending || subject.trim() === '' || body.trim() === ''}>
        {sending ? 'Sending…' : 'Send to support'}
      </Button>
    </form>
  );
}

/** Intercom-style help widget: floating launcher, searchable topics, and a
 * contact form that lands in the ops support inbox. */
export function HelpWidget() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'topics' | 'contact' | 'sent'>('topics');
  const [query, setQuery] = useState('');
  const [openTopic, setOpenTopic] = useState<string | null>(null);

  const topics = useMemo(() => filterTopics(HELP_TOPICS, query), [query]);

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label="Help & support"
          className="fixed right-4 bottom-20 z-50 flex max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-paper-300 bg-white shadow-lift"
        >
          <div className="bg-ink-900 px-5 py-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-paper-50">
                {view === 'contact' ? 'Contact support' : view === 'sent' ? 'Message sent' : 'Help & support'}
              </h2>
              <button
                aria-label="Close help"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-ink-300 hover:bg-ink-800 hover:text-paper-50"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {view === 'topics' && (
              <input
                className="mt-3 w-full rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-paper-50 placeholder:text-ink-400 focus:border-brass-400 focus:outline-none"
                placeholder="Search help topics…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {view === 'topics' && (
              <div className="space-y-1">
                {topics.length === 0 && (
                  <p className="px-2 py-6 text-center text-sm text-ink-400">
                    No topics match “{query}”. Try contacting support below.
                  </p>
                )}
                {topics.map((t) => (
                  <div key={t.id} className="rounded-md">
                    <button
                      onClick={() => setOpenTopic(openTopic === t.id ? null : t.id)}
                      className="flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2.5 text-left text-sm font-semibold text-ink-800 hover:bg-paper-100"
                    >
                      {t.title}
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className={`shrink-0 text-ink-400 transition-transform ${openTopic === t.id ? 'rotate-90' : ''}`}
                      >
                        <path d="M9 5l8 7-8 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {openTopic === t.id && (
                      <p className="px-3 pt-1 pb-3 text-sm leading-relaxed text-ink-600">{t.body}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {view === 'contact' && <ContactForm onSent={() => setView('sent')} />}
            {view === 'sent' && (
              <div className="px-2 py-8 text-center">
                <p className="font-display text-lg text-ink-800">Thanks — we're on it.</p>
                <p className="mt-2 text-sm text-ink-500">
                  The operations team reads every message and will follow up on your valuation's chat
                  thread or by email.
                </p>
              </div>
            )}
          </div>

          <div className="border-t border-paper-200 p-3">
            {view === 'topics' ? (
              <Button variant="secondary" className="w-full" onClick={() => setView('contact')}>
                Contact support
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setView('topics');
                }}
              >
                ← Back to help topics
              </Button>
            )}
          </div>
        </div>
      )}

      <button
        aria-label={open ? 'Close help' : 'Open help'}
        onClick={() => setOpen((v) => !v)}
        className="fixed right-4 bottom-4 z-50 flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-ink-900 text-paper-50 shadow-lift transition-transform hover:scale-105"
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.3 2.2-2.8 3.5" strokeLinecap="round" />
            <circle cx="12" cy="17.3" r="0.4" fill="currentColor" />
            <circle cx="12" cy="12" r="9.2" />
          </svg>
        )}
      </button>
    </>
  );
}
