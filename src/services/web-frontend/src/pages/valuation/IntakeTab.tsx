import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useWorkspace } from './ValuationWorkspace';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../../components/ui';

/**
 * Client self-service intake wizard (feature 7). A sectioned questionnaire
 * (company info, financials, cap table, legal) with a live completion tracker,
 * an outstanding-documents checklist, and — for ops — a document reminder.
 */

type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'boolean' | 'select';
interface IntakeField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  hint?: string;
}
interface IntakeSection {
  key: string;
  title: string;
  description: string;
  fields: IntakeField[];
}
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

function fieldValue(answers: Record<string, unknown>, key: string): string {
  const v = answers[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

export function IntakeTab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);
  const [schema, setSchema] = useState<IntakeSection[] | null>(null);
  const [data, setData] = useState<QuestionnaireResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
    void api<{ sections: IntakeSection[] }>('/intake/schema')
      .then((r) => setSchema(r.sections))
      .catch(() => setSchema([]));
    void load();
  }, [load]);

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

  if (!schema || !data) return <Spinner />;

  const canEdit = data.can_edit;
  const section = schema[step];
  const completion = data.completion;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-5">
        {data.submitted_at ? (
          <div className="rounded-md border border-bond-200 bg-bond-50 px-4 py-3 text-sm text-bond-800">
            Questionnaire submitted. You can still update answers below if anything changes.
          </div>
        ) : (
          <div className="rounded-md border border-paper-300 bg-paper-50 px-4 py-3 text-sm text-ink-500">
            Complete the sections below to help us value {valuation.company_name}. Your answers save
            per section.
          </div>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}

        {section && (
          <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
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
                  <Field label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint}>
                    {f.type === 'textarea' ? (
                      <textarea
                        disabled={!canEdit}
                        value={fieldValue(answers, f.key)}
                        onChange={(e) => setField(f.key, e.target.value)}
                        rows={3}
                        className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none disabled:bg-paper-100"
                      />
                    ) : f.type === 'boolean' ? (
                      <Select
                        disabled={!canEdit}
                        value={fieldValue(answers, f.key)}
                        onChange={(e) => setField(f.key, e.target.value === 'yes')}
                      >
                        <option value="">—</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </Select>
                    ) : f.type === 'select' ? (
                      <Select
                        disabled={!canEdit}
                        value={fieldValue(answers, f.key)}
                        onChange={(e) => setField(f.key, e.target.value)}
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
                        value={fieldValue(answers, f.key)}
                        onChange={(e) =>
                          setField(f.key, f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)
                        }
                      />
                    )}
                  </Field>
                </div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="secondary" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
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
                    disabled={busy || !completion.ready}
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
        <div className="rounded-lg border border-paper-300 bg-white p-5 shadow-card">
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
            <div className="h-full rounded-full bg-bond-500" style={{ width: `${completion.percentComplete}%` }} />
          </div>
          <ul className="mt-4 space-y-1.5 text-sm">
            {completion.sections.map((s, i) => (
              <li key={s.key}>
                <button
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

        <div className="rounded-lg border border-paper-300 bg-white p-5 shadow-card">
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
              <Button variant="secondary" disabled={busy} onClick={() => void sendReminder()}>
                Send reminder to client
              </Button>
              {reminderNote && <p className="mt-2 text-xs text-ink-500">{reminderNote}</p>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
