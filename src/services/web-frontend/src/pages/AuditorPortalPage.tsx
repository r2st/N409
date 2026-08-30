import { useEffect, useState } from 'react';
import { AuthShell } from '../components/AuthShell';
import { HelpIcon } from '../components/HelpIcon';
import { Button, ErrorNote, Field, inputClass, ListTruncationNote, Spinner } from '../components/ui';
import { required, useFormValidation } from '../lib/useFormValidation';
import { formatDate, kindLabel, moneyFormatter, PER_SHARE_DIGITS, stateLabel } from '../lib/format';
import { sanitizeHtml } from '../lib/m2';

interface Section {
  heading: string;
  html: string;
}
interface Bundle {
  valuation: { number: string; company_name: string; kind: string; state: string; currency: string };
  report: {
    template_version: string;
    status: string;
    content: { title: string; sections: Section[] };
  } | null;
  assumptions: {
    allocation_method: string;
    weights: { asset: string | null; opm: string | null; income: string | null; market: string | null };
    dloc: string | null;
    dlom: string | null;
    dlom_method: string | null;
    exit_timeline: string | null;
  } | null;
  conclusion: {
    equity_value: string | null;
    fmv_per_share: string | null;
    engine_version: string;
    /*
     * What each figure is, in this valuation kind's own words — the server
     * sends the caption with the number (see domain/specialty.ts). A specialty
     * engine writes its headline into the 409A-named columns, so the fixed
     * captions this page used to print called an IFRS 2 total expense an
     * "Equity value". `null` is the kind contributing no such figure, and the
     * metric is then omitted rather than shown as an em-dash.
     *
     * Optional because a bundle served by an older build carries neither key;
     * those fall back to the 409A wording, which is what they held.
     */
    equity_label?: string | null;
    fmv_per_share_label?: string | null;
  } | null;
  qa: Array<{ id: string; status: string; checks: Array<{ label: string; status: string; detail: string }> }>;
  evidence_summary: {
    has_report: boolean;
    has_conclusion: boolean;
    qa_count: number;
    /**
     * `qa_count` counts the reviews this response carries, not the reviews that
     * exist. An auditor reading a number off a capped page is being told a
     * figure rather than shown a list; see QA_REVIEW_PAGE_LIMIT.
     */
    qa_truncated: boolean;
    assumptions_recorded: boolean;
  };
  access_expires_at: string;
  /**
   * Why there is no report, when `report` is null.
   *
   * `null` carried two entirely different facts — the engagement has not shared
   * a draft yet, and it has shared one but nobody has written it — and this
   * page rendered nothing for either. An auditor sent a link and shown a
   * company name with no document under it assumes the third possibility: that
   * the page is broken, or that they are being refused. They have no account
   * through which to find out which.
   *
   * Optional because a bundle from a build that predates it carries neither
   * key; those fall back to saying nothing specific rather than guessing.
   */
  report_status?: 'available' | 'not_shared' | 'not_started';
  /** False on an engagement that can no longer accept a note. */
  can_submit_notes?: boolean;
}

/**
 * What the heading calls the document, for a reader outside the firm.
 *
 * The server derives this from the engagement's own state now, so it moves —
 * it used to be a stored column nothing ever wrote, which meant an auditor
 * reading the issued, unstamped report of a published engagement was told in
 * the card heading that it was a draft. The words are the ones that matter to
 * somebody who has to decide whether they are holding the file of record:
 * "final" is the only one that says yes.
 */
const REPORT_STATUS_LABELS: Record<string, string> = {
  draft: 'draft',
  changes: 'draft, changes requested',
  accepted: 'draft, accepted by the analyst',
  published: 'final',
};

type Disposition = 'question' | 'change_requested' | 'approved';

/**
 * What an auditor can say, in the order they are likely to need it.
 *
 * Deliberately not a workflow control: none of these moves the engagement, and
 * the copy says who acts next so that "Sign off" cannot read as a button that
 * publishes something. See DISPOSITIONS in routes/auditorPortal.ts.
 */
const DISPOSITIONS: Array<{ value: Disposition; label: string; hint: string }> = [
  {
    value: 'question',
    label: 'Ask a question',
    hint: 'Goes to the engagement team as a question — nothing changes until they answer.',
  },
  {
    value: 'change_requested',
    label: 'Request a change',
    hint: 'Flags something you believe is wrong. The reviewer decides what to do about it.',
  },
  {
    value: 'approved',
    label: 'Record your sign-off',
    hint: 'Records that you reviewed this with no exceptions. It does not publish or approve anything itself.',
  },
];

/**
 * External auditor portal (feature 8). Public, token-authenticated, read-only
 * view of one valuation: report, assumptions, conclusion, and audit-defense
 * Q&A. The token comes from the shared link's fragment (never a query string).
 */
export function AuditorPortalPage() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * Kept so the note form can post it back.
   *
   * Read from the fragment once, on mount, rather than re-read at submit time:
   * the fragment is the one part of the URL a stray navigation can drop, and a
   * submit that silently fails because the token has gone from the address bar
   * is the worst version of the dead end this form exists to close.
   */
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!fromHash) {
      setError('This auditor link is missing its access token.');
      return;
    }
    setToken(fromHash);
    fetch('/api/v1/auditor/portal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: fromHash }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // The fallbacks are for the case the server never got to answer in
          // its own words — a proxy's HTML error page, an offline browser —
          // where `detail` is absent and "Access denied" used to be the whole
          // message. They are the two situations the reader is in, and neither
          // is one they fix by asking for another link.
          const detail = (await res.json().catch(() => ({}))).detail;
          throw new Error(
            detail ??
              (res.status >= 500
                ? 'The valuation service could not be reached just now. Nothing is wrong with your ' +
                  'link — wait a minute and reload this page.'
                : `This auditor link could not be opened (error ${res.status}). Reload the page, and ` +
                  'if it keeps failing ask the valuation team who sent it to issue a fresh link.'),
          );
        }
        return res.json();
      })
      .then(setBundle)
      .catch((err) =>
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'This page could not reach the valuation service. Check your connection and reload; ' +
                'your link does not need replacing.',
        ),
      );
  }, []);

  if (error) {
    return (
      <AuthShell title="Auditor access" subtitle="Read-only valuation review">
        <ErrorNote>{error}</ErrorNote>
      </AuthShell>
    );
  }
  if (!bundle) {
    return (
      <AuthShell title="Auditor access" subtitle="Loading…">
        <Spinner />
      </AuthShell>
    );
  }

  // `undefined` is a bundle from a build that predates the captions; `null` is
  // this kind having no such figure. Only the first falls back.
  const perShareLabel =
    bundle.conclusion?.fmv_per_share_label === undefined
      ? 'Concluded FMV / share'
      : bundle.conclusion.fmv_per_share_label;
  const equityLabel =
    bundle.conclusion?.equity_label === undefined ? 'Equity value' : bundle.conclusion.equity_label;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Auditor portal · read-only
        <HelpIcon article="auditor-portal-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
        {bundle.valuation.company_name}
      </h1>
      <p className="tnum mt-1 text-sm text-ink-400">
        {bundle.valuation.number} · {kindLabel(bundle.valuation.kind)} · {stateLabel(bundle.valuation.state)}
      </p>
      <p className="mt-1 text-xs text-ink-400">Access expires {formatDate(bundle.access_expires_at)}</p>

      {bundle.conclusion && (
        <section className="mt-6 flex flex-wrap gap-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          {perShareLabel !== null && (
            <Metric
              label={perShareLabel}
              value={bundle.conclusion.fmv_per_share ?? '—'}
              currency={bundle.valuation.currency}
              digits={PER_SHARE_DIGITS}
            />
          )}
          {equityLabel !== null && (
            <Metric
              label={equityLabel}
              value={bundle.conclusion.equity_value ?? '—'}
              currency={bundle.valuation.currency}
            />
          )}
          <Metric label="Engine version" value={bundle.conclusion.engine_version} />
        </section>
      )}

      {bundle.assumptions && (
        <Card title="Assumptions">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Fact label="Allocation" value={bundle.assumptions.allocation_method} />
            <Fact label="DLOM" value={pct(bundle.assumptions.dlom)} />
            <Fact label="DLOM method" value={bundle.assumptions.dlom_method ?? '—'} />
            <Fact label="DLOC" value={pct(bundle.assumptions.dloc)} />
            <Fact label="Asset wt" value={pct(bundle.assumptions.weights.asset)} />
            <Fact label="OPM wt" value={pct(bundle.assumptions.weights.opm)} />
            <Fact label="Income wt" value={pct(bundle.assumptions.weights.income)} />
            <Fact label="Market wt" value={pct(bundle.assumptions.weights.market)} />
          </dl>
        </Card>
      )}

      {!bundle.report && bundle.report_status && (
        /*
         * The section that used to render as nothing at all.
         *
         * An auditor is holding a link somebody sent them on purpose; a page
         * with a company name and no document is not "there is no report yet"
         * to them, it is "this is broken" or "I am being refused". Both wrong
         * readings end the journey here, because there is no account to log
         * into and ask from. Naming which of the two it is turns a dead end
         * into a wait — and the note form below is how they say so if it is
         * not.
         */
        <Card title="Report">
          <p data-testid="auditor-report-absent" className="text-sm text-ink-600">
            {bundle.report_status === 'not_shared'
              ? 'The valuation report has not been shared yet. The engagement team shares it once the draft is ready — the conclusion and assumptions above are already final enough to review, and this section will fill in without you needing a new link.'
              : 'The engagement has reached the stage where the report is shared, but no version has been written yet. It will appear here when it is.'}
          </p>
        </Card>
      )}

      {bundle.report && (
        <Card title={`Report — ${REPORT_STATUS_LABELS[bundle.report.status] ?? bundle.report.status}`}>
          {bundle.report.content.sections.map((s, i) => (
            <div key={i} className="mb-5 last:mb-0">
              <h3 className="mb-1.5 font-display text-base font-semibold text-ink-900">{s.heading}</h3>
              {/*
                Sanitised again here, as the report tab does. Server-side
                sanitisation on save is the primary control, but this page
                renders whatever is *already stored* — including content
                written before a sanitiser covered the path that wrote it —
                and its reader is an external auditor holding a token, the one
                viewer with no account and the least reason to trust us.
              */}
              <div
                className="prose-sm text-ink-700"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(s.html) }}
              />
            </div>
          ))}
        </Card>
      )}

      {/*
       * No empty-state card here, deliberately, unlike the report above. The
       * report is what the auditor was sent the link *for*, so its absence is
       * the one that reads as a fault; a review section that is simply not
       * there is not a claim about anything. Pinned by
       * "omits the review card when the valuation has not been reviewed".
       */}
      {bundle.qa.length > 0 && (
        <Card title="Audit-defense review">
          {bundle.qa.map((q) => (
            <div key={q.id} className="mb-4 last:mb-0">
              <div className="overline text-ink-400">Review · {q.status}</div>
              <ul className="mt-2 space-y-1.5">
                {q.checks.map((c, i) => (
                  <li key={i} className="text-sm">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${
                        c.status === 'pass'
                          ? 'bg-emerald-50 text-emerald-700'
                          : c.status === 'fail'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-paper-100 text-ink-600'
                      }`}
                    >
                      {c.status}
                    </span>
                    <span className="font-semibold text-ink-800">{c.label}:</span>{' '}
                    <span className="text-ink-600">{c.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ListTruncationNote
            truncated={bundle.evidence_summary.qa_truncated}
            shown={bundle.qa.length}
            noun="reviews"
            hint="ask the engagement team for the full review history"
          />
        </Card>
      )}

      {token && bundle.can_submit_notes !== false && <NoteForm token={token} />}
    </div>
  );
}

/**
 * The auditor's half of the review, which the portal did not have.
 *
 * Everything above this is read-only, and every other way into the engagement's
 * thread needs an account — which is the one thing an auditor holding a link
 * does not have. So a reviewer who found a problem in a signed deliverable had
 * to leave the product, find an email address, and describe which valuation
 * they meant, and none of it reached the engagement's record.
 *
 * The submitted note is echoed back rather than the form merely clearing: a
 * submission whose only feedback is an empty box is a submission the sender
 * cannot tell landed, and the obvious response to that is to send it again.
 */
function NoteForm({ token }: { token: string }) {
  const [disposition, setDisposition] = useState<Disposition>('question');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ heading: string; body: string } | null>(null);

  const chosen = DISPOSITIONS.find((d) => d.value === disposition)!;

  /*
   * The shared validator rather than the browser's, like every other form here
   * — and rather than a submit button that is simply disabled while the box is
   * empty. A disabled control states that something is wrong without saying
   * what, and the reader it states it to is an auditor with no account to ask
   * from. Naming the box is the same choice the onboarding funnel makes.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    { body },
    { body: required('body', 'Your note') },
  );

  const submit = handleSubmit(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auditor/portal/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, disposition, body: body.trim() }),
      });
      if (!res.ok) {
        throw new Error(
          (await res.json().catch(() => ({}))).detail ?? 'Your note could not be sent. Please try again.',
        );
      }
      const { note } = await res.json();
      setSent({ heading: note.heading, body: note.body });
      // Cleared only after the reply, so a failure leaves the text where the
      // auditor can retry it rather than making them write it again.
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your note could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-1 text-ink-400">Respond</h2>
      <p className="mb-4 text-sm text-ink-600">
        Anything you put here goes to the engagement team and is recorded against this valuation. You will not
        get a reply on this page — they will contact you directly.
      </p>

      {sent && (
        <div
          role="status"
          data-testid="auditor-note-sent"
          className="mb-4 rounded-md border border-bond-200 bg-bond-50 px-3.5 py-3 text-sm text-bond-800"
        >
          <div className="font-semibold">Sent — recorded as “{sent.heading}”.</div>
          <p className="mt-1 whitespace-pre-wrap text-bond-700">{sent.body}</p>
          <p className="mt-2 text-xs text-bond-700">
            You can send another note from this link at any time until it expires.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4" noValidate>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-ink-700">What is this?</legend>
          <div className="flex flex-wrap gap-2">
            {DISPOSITIONS.map((d) => (
              <label
                key={d.value}
                className={`tap-area cursor-pointer rounded-md border px-3.5 py-2 text-sm font-semibold ${
                  disposition === d.value
                    ? 'border-bond-600 bg-bond-50 text-bond-800'
                    : 'border-ink-200 bg-surface text-ink-700 hover:border-bond-400'
                }`}
              >
                <input
                  type="radio"
                  name="disposition"
                  value={d.value}
                  checked={disposition === d.value}
                  onChange={() => setDisposition(d.value)}
                  className="sr-only"
                />
                {d.label}
              </label>
            ))}
          </div>
          {/* Said before they write, not after they send: "Record your
              sign-off" beside a report is exactly the control someone expects
              to publish something, and it does not. */}
          <p className="mt-2 text-xs text-ink-500">{chosen.hint}</p>
        </fieldset>

        <Field label="Your note" error={errorFor('body')}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={blurHandler('body')}
            rows={5}
            maxLength={20_000}
            required
            placeholder="Cite the exhibit or figure you mean — the team sees this against the valuation, not in an inbox."
            className={inputClass}
          />
        </Field>

        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send to the engagement team'}
        </Button>
      </form>
    </section>
  );
}

const pct = (v: string | null) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

/**
 * `digits` exists because this portal is where the figure is *checked*.
 *
 * Both money metrics went through one formatter struck at two decimals, and the
 * per-share conclusion is struck at four everywhere it is issued — the report
 * body, the executive summary, Exhibit H. So the auditor reconciling a $2.5013
 * conclusion against the PDF in front of them was shown $2.50 by the very page
 * built for that reconciliation. The aggregate beside it is genuinely a
 * two-decimal figure, so the precision is per-metric rather than per-page.
 */
function Metric({
  label,
  value,
  currency,
  digits = 2,
}: {
  label: string;
  value: string;
  currency?: string;
  digits?: number;
}) {
  const display =
    currency && /^-?\d/.test(value)
      ? moneyFormatter(currency, { minimumFractionDigits: digits, maximumFractionDigits: digits })(
          Number(value),
        )
      : value;
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className="tnum mt-1 font-display text-xl font-semibold text-ink-900">{display}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-4 text-ink-400">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="mt-0.5 font-semibold text-ink-900">{value}</dd>
    </div>
  );
}
