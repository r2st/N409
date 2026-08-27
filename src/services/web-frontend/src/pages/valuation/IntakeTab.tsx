import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useWorkspace } from './ValuationWorkspace';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  LoadError,
  Select,
  Spinner,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';
import { FieldWarnings, ValidationSummary } from '../../components/ValidationNotes';
import { answerFromControl, controlValue } from '../../lib/intakeAnswers';
import {
  hasBlockingIssues,
  issuesByField,
  validateIntake,
  type IntakeCrossRule,
  type IntakeSection,
} from '../../lib/intakeValidation';

/**
 * Client self-service intake wizard (feature 7). A sectioned questionnaire
 * (company info, financials, cap table, legal) with a live completion tracker,
 * an outstanding-documents checklist, and — for ops — a document reminder.
 */

interface SectionCompletion {
  key: string;
  title: string;
  requiredTotal: number;
  requiredAnswered: number;
  complete: boolean;
}
interface Completion {
  sections: SectionCompletion[];
  requiredTotal: number;
  requiredAnswered: number;
  percentComplete: number;
  ready: boolean;
}
interface MissingDoc {
  kind: string;
  label: string;
}
interface QuestionnaireResponse {
  answers: Record<string, unknown>;
  submitted_at: string | null;
  completion: Completion;
  missing_documents: MissingDoc[];
  can_edit: boolean;
}

export function IntakeTab() {
  const { valuation, retired } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);
  const [schema, setSchema] = useState<IntakeSection[] | null>(null);
  const [schemaFailed, setSchemaFailed] = useState(false);
  const [crossRules, setCrossRules] = useState<IntakeCrossRule[]>([]);
  const [data, setData] = useState<QuestionnaireResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [busy, setBusy] = useState(false);
  const [reminderNote, setReminderNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<QuestionnaireResponse>(`/valuations/${valuation.id}/questionnaire`);
      setData(res);
      setAnswers(res.answers ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the questionnaire.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void api<{ sections: IntakeSection[]; cross_rules?: IntakeCrossRule[] }>(
      `/intake/schema?kind=${encodeURIComponent(valuation.kind)}`,
    )
      .then((r) => {
        setSchema(r.sections);
        setCrossRules(r.cross_rules ?? []);
      })
      // The empty list is deliberate — the sidebar, the progress and the
      // document checklist are still worth showing, and blocking the whole tab
      // on the form would take them away too. What was missing is the reason:
      // the tab rendered "Complete the sections below" above no sections at
      // all, so a client had nothing to fill in and nothing to explain it.
      .catch(() => {
        setSchema([]);
        setSchemaFailed(true);
      });
    void load();
  }, [load, valuation.kind, token]);

  const setField = (key: string, value: unknown) => setAnswers((a) => ({ ...a, [key]: value }));

  const saveSection = async (section: IntakeSection) => {
    setError(null);
    setBusy(true);
    try {
      const slice: Record<string, unknown> = {};
      for (const f of section.fields) slice[f.key] = answers[f.key] ?? null;
      const res = await api<QuestionnaireResponse>(`/valuations/${valuation.id}/questionnaire`, {
        method: 'PUT',
        body: { answers: slice },
      });
      setData((d) => (d ? { ...d, completion: res.completion, answers: res.answers } : d));
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/questionnaire/submit`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit — check required fields.');
    } finally {
      setBusy(false);
    }
  };

  const sendReminder = async () => {
    setReminderNote(null);
    setBusy(true);
    try {
      const res = await api<{ reminded: string }>(`/valuations/${valuation.id}/remind-documents`, {
        method: 'POST',
        body: {},
      });
      setReminderNote(`Reminder sent to ${res.reminded}.`);
    } catch (err) {
      setReminderNote(err instanceof ApiError ? err.message : 'Could not send reminder.');
    } finally {
      setBusy(false);
    }
  };

  // Validated against the answers in hand, not the last saved ones — the point
  // is to catch a mistyped figure while the client is still looking at it.
  const issues = useMemo(
    () => validateIntake(schema ?? [], crossRules, answers),
    [schema, crossRules, answers],
  );
  const issuesFor = useMemo(() => issuesByField(issues), [issues]);
  const blocked = hasBlockingIssues(issues);

  // Ahead of the spinner: `load` records the failure in `error`, but `data`
  // stays null on a failed load, so returning the spinner first left the tab
  // spinning forever on a 403 or a 503 with the explanation already in hand.
  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!schema || !data) return <Spinner />;

  const canEdit = data.can_edit && !retired;
  const section = schema[step];
  const completion = data.completion;
  const sectionIssues = section ? issues.filter((i) => section.fields.some((f) => f.key === i.field)) : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-5">
        {data.submitted_at ? (
          <div className="rounded-md border border-bond-200 bg-bond-50 px-4 py-3 text-sm text-bond-800">
            Questionnaire submitted. You can still update answers below if anything changes.
          </div>
        ) : (
          !schemaFailed && (
            <div className="rounded-md border border-paper-300 bg-paper-50 px-4 py-3 text-sm text-ink-500">
              Complete the sections below to help us value {valuation.company_name}. Your answers save per
              section.
            </div>
          )
        )}

        {schemaFailed && (
          <ErrorNote>
            Could not load the questionnaire form. Your saved answers are safe — reload the page to try again.
            Everything else on this tab is up to date.
          </ErrorNote>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}

        {section && (
          <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-ink-900">{section.title}</h2>
              <span className="text-xs text-ink-400">
                Step {step + 1} of {schema.length}
              </span>
            </div>
            <p className="mb-5 text-sm text-ink-400">{section.description}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              {section.fields.map((f) => (
                <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                  <Field
                    label={`${f.label}${f.required ? ' *' : ''}`}
                    hint={f.hint}
                    error={issuesFor.get(f.key)?.find((i) => i.severity === 'error')?.message}
                  >
                    {f.type === 'textarea' ? (
                      <textarea
                        disabled={!canEdit}
                        value={controlValue(answers, f.key)}
                        onChange={(e) => setField(f.key, answerFromControl(f, e.target.value))}
                        rows={3}
                        maxLength={f.rules?.maxLength}
                        className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none disabled:bg-paper-100"
                      />
                    ) : f.type === 'boolean' ? (
                      <Select
                        disabled={!canEdit}
                        value={controlValue(answers, f.key)}
                        onChange={(e) => setField(f.key, answerFromControl(f, e.target.value))}
                      >
                        <option value="">—</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </Select>
                    ) : f.type === 'select' ? (
                      <Select
                        disabled={!canEdit}
                        value={controlValue(answers, f.key)}
                        onChange={(e) => setField(f.key, answerFromControl(f, e.target.value))}
                      >
                        <option value="">—</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <TextInput
                        disabled={!canEdit}
                        type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                        maxLength={f.type === 'text' ? f.rules?.maxLength : undefined}
                        value={controlValue(answers, f.key)}
                        onChange={(e) => setField(f.key, answerFromControl(f, e.target.value))}
                      />
                    )}
                  </Field>
                  <FieldWarnings issues={issuesFor.get(f.key) ?? []} />
                </div>
              ))}
            </div>

            {sectionIssues.length > 0 && (
              <div className="mt-5">
                <ValidationSummary issues={sectionIssues} />
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                disabled={step === 0}
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                Back
              </Button>
              {canEdit && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={async () => {
                    await saveSection(section);
                  }}
                >
                  {busy ? 'Saving…' : 'Save section'}
                </Button>
              )}
              {step < schema.length - 1 ? (
                <Button
                  disabled={busy}
                  onClick={async () => {
                    if (canEdit) await saveSection(section);
                    setStep((s) => Math.min(schema.length - 1, s + 1));
                  }}
                >
                  Next
                </Button>
              ) : (
                canEdit && (
                  <Button
                    disabled={busy || !completion.ready || blocked}
                    title={blocked ? 'Correct the highlighted answers first' : undefined}
                    onClick={async () => {
                      if (await saveSection(section)) await submit();
                    }}
                  >
                    Submit questionnaire
                  </Button>
                )
              )}
            </div>
          </section>
        )}
      </div>

      {/* Progress + document checklist */}
      <aside className="space-y-5">
        <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
          <h3 className="overline mb-3 text-ink-400">Progress</h3>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="font-display text-2xl font-semibold text-ink-900">
              {completion.percentComplete}%
            </span>
            <span className="text-xs text-ink-400">
              {completion.requiredAnswered}/{completion.requiredTotal} required
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-paper-300">
            <div
              className="h-full rounded-full bg-bond-500"
              style={{ width: `${completion.percentComplete}%` }}
            />
          </div>
          <ul className="mt-4 space-y-1.5 text-sm">
            {completion.sections.map((s, i) => (
              <li key={s.key}>
                <button
                  aria-pressed={i === step}
                  className={`flex w-full items-center gap-2 text-left ${i === step ? 'font-semibold text-ink-900' : 'text-ink-600'}`}
                  onClick={() => setStep(i)}
                >
                  <span className={`h-2 w-2 rounded-full ${s.complete ? 'bg-bond-500' : 'bg-paper-300'}`} />
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Whole-form roll-up: submit lives on the last step, but what blocks
            it may be three sections back. */}
        {issues.length > 0 && (
          <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
            <h3 className="overline mb-3 text-ink-400">Data checks</h3>
            <ValidationSummary issues={issues} />
          </div>
        )}

        <div className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
          <h3 className="overline mb-3 text-ink-400">Documents still needed</h3>
          {data.missing_documents.length === 0 ? (
            <EmptyState title="All set">All required documents are in.</EmptyState>
          ) : (
            <ul className="space-y-1.5 text-sm text-ink-700">
              {data.missing_documents.map((d) => (
                <li key={d.kind} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  {d.label}
                </li>
              ))}
            </ul>
          )}
          {ops && data.missing_documents.length > 0 && (
            <div className="mt-4">
              <WriteGate closed={retired}>
                <Button variant="secondary" disabled={busy} onClick={() => void sendReminder()}>
                  Send reminder to client
                </Button>
              </WriteGate>
              {reminderNote && (
                <p role="status" className="mt-2 text-xs text-ink-500">
                  {reminderNote}
                </p>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
