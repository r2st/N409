import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Select, Spinner, TextInput } from '../components/ui';
import { FieldWarnings, ValidationSummary } from '../components/ValidationNotes';
import { PLATFORM_BRANDING, type Branding } from '../lib/branding';
import { answerFromControl, controlValue, resumeStep } from '../lib/intakeAnswers';
import {
  hasBlockingIssues,
  issuesByField,
  validateIntake,
  type IntakeCrossRule,
  type IntakeField,
  type IntakeSection,
} from '../lib/intakeValidation';

/**
 * Client intake form — the prospect-facing half of a firm's intake link.
 *
 * Everything here is shaped by who is on the other side of the screen: a
 * founder or a CFO who has never seen this product, is not signed in, and was
 * sent a link by their valuation firm. So the page wears the firm's brand
 * rather than ours, never mentions an account, and never asks them to press
 * Save — answers are written back as they type, because the one thing that
 * would lose this firm a client is a half-finished form evaporating on a
 * closed tab.
 *
 * The token arrives in the URL fragment and is posted in the request body: a
 * fragment is never sent to the server in the request line, so the credential
 * stays out of access logs, and posting it keeps it out of the Referer header
 * too. Same discipline as the auditor portal.
 */

interface SectionCompletion {
  key: string;
  title: string;
  requiredTotal: number;
  requiredAnswered: number;
  answeredTotal: number;
  fieldTotal: number;
  complete: boolean;
}

interface Completion {
  sections: SectionCompletion[];
  requiredTotal: number;
  requiredAnswered: number;
  percentComplete: number;
  ready: boolean;
}

interface Portal {
  firm: Branding;
  client_name: string | null;
  sections: IntakeSection[];
  cross_rules?: IntakeCrossRule[];
  answers: Record<string, unknown>;
  completion: Completion;
  status: string;
  can_edit: boolean;
  submitted_at: string | null;
  expires_at: string;
}

/** How long after the last keystroke a section's answers are written back. */
const AUTOSAVE_MS = 900;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new Error(problem.detail ?? problem.title ?? 'Something went wrong.');
  }
  return (await res.json()) as T;
};

/** The prose a review row shows. Unanswered reads as "Not answered", not blank. */
function displayValue(field: IntakeField, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not answered';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'select') return String(value).replace(/_/g, ' ');
  if (field.type === 'number') return Number(value).toLocaleString();
  if (field.type === 'date') {
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
  }
  return String(value);
}

export function ClientIntakePage() {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<Portal | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [step, setStep] = useState(0);
  const [fatal, setFatal] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);

  // Keys edited since the last successful write. Only these are sent, so a save
  // never re-posts (and never resurrects) a field the client did not touch.
  const pending = useRef<Set<string>>(new Set());
  const answersRef = useRef<Record<string, unknown>>({});
  answersRef.current = answers;

  // Judged locally against the rules the server sent with the schema, so a
  // mistyped figure is caught at the keyboard rather than by an analyst
  // three days later.
  const issues = useMemo(
    () => validateIntake(data?.sections ?? [], data?.cross_rules ?? [], answers),
    [data, answers],
  );
  const issuesFor = useMemo(() => issuesByField(issues), [issues]);
  const blocked = hasBlockingIssues(issues);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!raw) {
      setFatal('This link is missing its access token. Please use the link your firm sent you.');
      return;
    }
    setToken(raw);
    post<Portal>('/api/v1/intake/portal', { token: raw })
      .then((portal) => {
        setData(portal);
        setAnswers(portal.answers ?? {});
        setCompletion(portal.completion);
        setSubmittedAt(portal.submitted_at);
        // Reopen where the client stopped. A submitted form has nothing left to
        // answer, so it opens on the review — which is what it renders anyway.
        setStep(portal.submitted_at ? portal.sections.length : resumeStep(portal.completion.sections));
      })
      .catch((err: unknown) =>
        setFatal(err instanceof Error ? err.message : 'This link is invalid, expired, or withdrawn.'),
      );
  }, []);

  /**
   * The write currently in flight. Every flush queues behind it, so at most one
   * save is ever open against this link.
   *
   * Three callers can flush — the autosave timer, moving between steps, and
   * Submit — and before this they could all be open at once, which broke two
   * things that matter on a form nobody is watching us fill in.
   *
   * The server merges each slice with `answers || $2::jsonb`, so the last
   * request to *arrive* wins per key. Two overlapping saves of the same field
   * are ordered by the network rather than by when the client typed them, and
   * the older value can land second: the prospect watches the page say "Saved"
   * over the figure they just corrected, and the firm converts the intake with
   * the figure they replaced.
   *
   * And `flush` returned as soon as it found nothing pending — which is exactly
   * what it finds while an earlier flush is still open, having already cleared
   * the set. Submit awaited that, got an instant resolve, and posted /submit
   * ahead of the answers it was submitting; the server judged completeness on
   * what it had and answered "Complete all required fields" to a client who
   * just had.
   */
  const inFlight = useRef<Promise<boolean>>(Promise.resolve(true));

  /**
   * Write the pending keys back, after any write already in flight. Resolves
   * true when everything pending at its turn is on the server — so Submit can
   * wait for a real answer instead of for an empty set.
   */
  const flush = useCallback((): Promise<boolean> => {
    const next = inFlight.current.then(async (): Promise<boolean> => {
      // Read at its turn, not at call time: what is pending may have grown
      // while this call was queued, and those keys belong in this write.
      if (!token || pending.current.size === 0) return true;
      const keys = [...pending.current];
      pending.current.clear();
      const slice: Record<string, unknown> = {};
      for (const key of keys) slice[key] = answersRef.current[key] ?? null;

      setSaveState('saving');
      try {
        const res = await post<{ answers: Record<string, unknown>; completion: Completion }>(
          '/api/v1/intake/portal/answers',
          { token, answers: slice },
        );
        setCompletion(res.completion);
        setSaveState('saved');
        setSaveError(null);
        return true;
      } catch (err) {
        // Put the keys back so the next attempt — a later edit, or leaving the
        // step — retries them rather than dropping the client's typing.
        for (const key of keys) pending.current.add(key);
        setSaveState('error');
        setSaveError(err instanceof Error ? err.message : 'Could not save your answers.');
        return false;
      }
    });
    // A failed write must not poison the queue for the next one; the boolean is
    // how failure is reported, and the chain always resolves.
    inFlight.current = next.then(
      () => true,
      () => true,
    );
    return next;
  }, [token]);

  const setField = (key: string, value: unknown) => {
    pending.current.add(key);
    setAnswers((a) => ({ ...a, [key]: value }));
    setSaveState('idle');
  };

  // Debounced autosave: one write per pause in typing, not one per keystroke.
  useEffect(() => {
    if (pending.current.size === 0) return;
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [answers, flush]);

  const goTo = (next: number) => {
    void flush();
    setStep(next);
    // Guarded: jsdom (and some embedded webviews) have no scrollTo, and losing
    // a scroll position is not worth throwing inside a click handler.
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  };

  const submit = async () => {
    if (!token) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Submitting answers the server has not got yet is how a complete form
      // gets told it is incomplete. If the write failed, say so in the client's
      // own terms rather than letting the server's completeness error stand in
      // for a network problem.
      if (!(await flush())) {
        setSubmitError('Your latest answers could not be saved. Check your connection and try again.');
        return;
      }
      const res = await post<{ submitted_at: string; completion: Completion }>(
        '/api/v1/intake/portal/submit',
        { token },
      );
      setSubmittedAt(res.submitted_at);
      setCompletion(res.completion);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not submit — please check your answers.');
    } finally {
      setSubmitting(false);
    }
  };

  const firm = data?.firm ?? PLATFORM_BRANDING;

  if (fatal) {
    return (
      <Shell firm={firm}>
        <div className="rounded-lg border border-paper-300 bg-surface p-8 text-center shadow-card">
          <h1 className="font-display text-xl font-semibold text-ink-900">This link isn’t available</h1>
          <p className="mt-2 text-sm text-ink-500">{fatal}</p>
          {firm.support_email && (
            <p className="mt-4 text-sm text-ink-400">
              Get in touch with {firm.name} at{' '}
              <a className="text-bond-700 underline" href={`mailto:${firm.support_email}`}>
                {firm.support_email}
              </a>
              .
            </p>
          )}
        </div>
      </Shell>
    );
  }

  if (!data || !completion) {
    return (
      <Shell firm={firm}>
        <Spinner label="Loading your intake form…" />
      </Shell>
    );
  }

  if (submittedAt) {
    return (
      <Shell firm={firm}>
        <div className="rounded-lg border border-paper-300 bg-surface p-8 shadow-card">
          <div
            aria-hidden
            className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-bold"
            style={{ backgroundColor: firm.accent, color: firm.accent_fg }}
          >
            ✓
          </div>
          <h1 className="mt-4 font-display text-2xl font-semibold text-ink-900">
            Thank you — that’s everything
          </h1>
          <p className="mt-2 text-sm text-ink-500">
            {firm.name} received your answers on {new Date(submittedAt).toLocaleDateString()}. Your valuation
            team will be in touch if anything needs following up.
          </p>
        </div>
        <Review sections={data.sections} answers={answers} />
      </Shell>
    );
  }

  const readOnly = !data.can_edit;
  const reviewStep = data.sections.length;
  const onReview = step >= reviewStep;
  const section = data.sections[step];

  return (
    <Shell firm={firm}>
      <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
        <Progress
          firm={firm}
          completion={completion}
          step={step}
          reviewStep={reviewStep}
          onStep={goTo}
          saveState={saveState}
        />

        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">
            {data.client_name ? `Welcome, ${data.client_name}` : 'Valuation intake'}
          </h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {firm.name} needs a few details to begin your valuation. Your answers save automatically — you can
            close this page and pick it up from the same link.
          </p>

          {readOnly && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              This form is no longer accepting changes. Contact {firm.name} if you need to update anything.
            </div>
          )}
          {saveError && (
            <div className="mt-4">
              <ErrorNote>{saveError}</ErrorNote>
            </div>
          )}

          {onReview ? (
            <>
              <Review sections={data.sections} answers={answers} onEdit={readOnly ? undefined : goTo} />
              {issues.length > 0 && (
                <div className="mt-5">
                  <ValidationSummary issues={issues} />
                </div>
              )}
              {submitError && (
                <div className="mt-5">
                  <ErrorNote>{submitError}</ErrorNote>
                </div>
              )}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button variant="secondary" onClick={() => goTo(reviewStep - 1)}>
                  Back
                </Button>
                {!readOnly && (
                  <Button
                    disabled={submitting || !completion.ready || blocked}
                    title={blocked ? 'Correct the highlighted answers first' : undefined}
                    style={
                      completion.ready && !blocked && !submitting
                        ? { backgroundColor: firm.accent, color: firm.accent_fg }
                        : undefined
                    }
                    onClick={() => void submit()}
                  >
                    {submitting ? 'Submitting…' : 'Submit to ' + firm.name}
                  </Button>
                )}
                {!completion.ready && (
                  <span className="text-sm text-ink-400">
                    {completion.requiredTotal - completion.requiredAnswered} required{' '}
                    {completion.requiredTotal - completion.requiredAnswered === 1 ? 'answer' : 'answers'}{' '}
                    still needed.
                  </span>
                )}
              </div>
            </>
          ) : (
            section && (
              <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card sm:p-8">
                <div className="overline text-ink-400">
                  Step {step + 1} of {reviewStep + 1}
                </div>
                <h2 className="mt-1 font-display text-lg font-semibold text-ink-900">{section.title}</h2>
                <p className="mt-1 mb-6 text-sm text-ink-400">{section.description}</p>

                <div className="grid gap-5 sm:grid-cols-2">
                  {section.fields.map((f) => (
                    <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                      <Field
                        label={`${f.label}${f.required ? ' *' : ''}`}
                        hint={f.hint}
                        error={issuesFor.get(f.key)?.find((i) => i.severity === 'error')?.message}
                      >
                        <Control field={f} answers={answers} disabled={readOnly} onChange={setField} />
                      </Field>
                      <FieldWarnings issues={issuesFor.get(f.key) ?? []} />
                    </div>
                  ))}
                </div>

                {(() => {
                  const sectionIssues = issues.filter((i) => section.fields.some((f) => f.key === i.field));
                  return sectionIssues.length > 0 ? (
                    <div className="mt-6">
                      <ValidationSummary issues={sectionIssues} />
                    </div>
                  ) : null;
                })()}

                <div className="mt-8 flex items-center justify-between gap-3 border-t border-paper-200 pt-5">
                  <Button variant="secondary" disabled={step === 0} onClick={() => goTo(step - 1)}>
                    Back
                  </Button>
                  <Button
                    style={{ backgroundColor: firm.accent, color: firm.accent_fg }}
                    onClick={() => goTo(step + 1)}
                  >
                    {step === reviewStep - 1 ? 'Review answers' : 'Continue'}
                  </Button>
                </div>
              </section>
            )
          )}
        </div>
      </div>
    </Shell>
  );
}

/** One questionnaire control, typed by the schema the server sent. */
function Control({
  field,
  answers,
  disabled,
  onChange,
}: {
  field: IntakeField;
  answers: Record<string, unknown>;
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const value = controlValue(answers, field.key);
  const set = (raw: string) => onChange(field.key, answerFromControl(field, raw));

  if (field.type === 'textarea') {
    return (
      <textarea
        disabled={disabled}
        rows={4}
        maxLength={field.rules?.maxLength}
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none disabled:bg-paper-100"
      />
    );
  }
  if (field.type === 'boolean') {
    return (
      <Select disabled={disabled} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Select…</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </Select>
    );
  }
  if (field.type === 'select') {
    return (
      <Select disabled={disabled} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Select…</option>
        {field.options?.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, ' ')}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <TextInput
      disabled={disabled}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      maxLength={field.type === 'text' ? field.rules?.maxLength : undefined}
      value={value}
      onChange={(e) => set(e.target.value)}
    />
  );
}

/** Section rail, overall progress and the autosave indicator. */
function Progress({
  firm,
  completion,
  step,
  reviewStep,
  onStep,
  saveState,
}: {
  firm: Branding;
  completion: Completion;
  step: number;
  reviewStep: number;
  onStep: (next: number) => void;
  saveState: SaveState;
}) {
  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'All answers saved'
        : saveState === 'error'
          ? 'Not saved — retrying'
          : 'Saves automatically';

  return (
    <aside className="lg:sticky lg:top-8 lg:self-start">
      <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
        <div className="flex items-baseline justify-between">
          <span className="tnum font-display text-2xl font-semibold text-ink-900">
            {completion.percentComplete}%
          </span>
          <span className="tnum text-xs text-ink-400">
            {completion.requiredAnswered}/{completion.requiredTotal} required
          </span>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-paper-300"
          role="progressbar"
          aria-label="Intake completion"
          aria-valuenow={completion.percentComplete}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${completion.percentComplete}%`, backgroundColor: firm.accent }}
          />
        </div>

        <ol className="mt-5 space-y-1">
          {completion.sections.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                aria-current={i === step ? 'step' : undefined}
                onClick={() => onStep(i)}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-paper-100 ${
                  i === step ? 'font-semibold text-ink-900' : 'text-ink-600'
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold ${
                    s.complete ? 'text-white' : 'bg-paper-200 text-ink-400'
                  }`}
                  style={s.complete ? { backgroundColor: firm.accent, color: firm.accent_fg } : undefined}
                >
                  {s.complete ? '✓' : i + 1}
                </span>
                {s.title}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              aria-current={step >= reviewStep ? 'step' : undefined}
              onClick={() => onStep(reviewStep)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-paper-100 ${
                step >= reviewStep ? 'font-semibold text-ink-900' : 'text-ink-600'
              }`}
            >
              <span
                aria-hidden
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-200 text-[0.65rem] font-bold text-ink-400"
              >
                {reviewStep + 1}
              </span>
              Review &amp; submit
            </button>
          </li>
        </ol>

        <p aria-live="polite" className="mt-5 border-t border-paper-200 pt-4 text-xs text-ink-400">
          {saveLabel}
        </p>
      </div>
    </aside>
  );
}

/** Everything answered so far, grouped as it was asked. */
function Review({
  sections,
  answers,
  onEdit,
}: {
  sections: IntakeSection[];
  answers: Record<string, unknown>;
  onEdit?: (step: number) => void;
}) {
  return (
    <div className="mt-6 space-y-5">
      {sections.map((section, i) => (
        <section key={section.key} className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-base font-semibold text-ink-900">{section.title}</h2>
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(i)}
                className="cursor-pointer text-sm text-bond-700 underline"
              >
                Edit
              </button>
            )}
          </div>
          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {section.fields.map((f) => {
              const missing = !(f.key in answers) || answers[f.key] === null || answers[f.key] === '';
              return (
                <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                  <dt className="text-xs text-ink-400">
                    {f.label}
                    {f.required && missing && (
                      <span className="ml-1 font-semibold text-red-600">required</span>
                    )}
                  </dt>
                  <dd
                    className={`mt-0.5 text-sm ${missing ? 'text-ink-300 italic' : 'font-medium text-ink-900'}`}
                  >
                    {displayValue(f, answers[f.key])}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Firm-branded page frame. The firm's mark, never ours. */
function Shell({ firm, children }: { firm: Branding; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper-100">
      <header className="border-b border-paper-300 bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-5">
          {firm.logo_url ? (
            <img src={firm.logo_url} alt={firm.name} className="h-8 w-auto" />
          ) : (
            <span
              aria-hidden
              className="flex h-8 w-8 items-center justify-center rounded font-display text-sm font-bold"
              style={{ backgroundColor: firm.accent, color: firm.accent_fg }}
            >
              {firm.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <div className="font-display text-base leading-tight font-semibold text-ink-900">{firm.name}</div>
            {firm.tagline && <div className="text-xs text-ink-400">{firm.tagline}</div>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      <footer className="mx-auto max-w-5xl px-6 pb-12 text-xs text-ink-400">
        Your answers are shared only with {firm.name}.
        {firm.support_email && (
          <>
            {' '}
            Questions?{' '}
            <a className="underline" href={`mailto:${firm.support_email}`}>
              {firm.support_email}
            </a>
          </>
        )}
      </footer>
    </div>
  );
}
