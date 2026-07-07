import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { editableFields, isOps } from '../lib/rbac';
import { formatDate, formatDateTime, STATE_LABELS } from '../lib/format';
import { VALUATION_STATES } from '../lib/types';
import type { Valuation, ValuationEvent } from '../lib/types';
import { Button, ErrorNote, Field, KindBadge, Select, Spinner, StateBadge, TextInput } from '../components/ui';
import { CommentsSection } from '../components/CommentThread';

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="overline text-ink-400">{label}</dt>
      <dd className="mt-1 text-sm text-ink-900">{value ?? '—'}</dd>
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  valuation_created: 'Valuation created',
  valuation_updated: 'Details updated',
  state_changed: 'State changed',
  comment_added: 'Comment added',
  email_received: 'Email received',
  valuation_cloned: 'Cloned from another valuation',
};

export function ValuationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [events, setEvents] = useState<ValuationEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [form, setForm] = useState({ company_name: '', service_name: '', state: '' });

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [{ valuation: v }, { events: ev }] = await Promise.all([
        api<{ valuation: Valuation }>(`/valuations/${id}`),
        api<{ events: ValuationEvent[] }>(`/valuations/${id}/events`),
      ]);
      setValuation(v);
      setEvents(ev);
      setForm({ company_name: v.company_name, service_name: v.service_name ?? '', state: v.state });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This valuation does not exist or you do not have access to it.'
          : 'Could not load the valuation.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="max-w-xl">
        <ErrorNote>{error}</ErrorNote>
        <Link to="/valuations" className="mt-4 inline-block text-sm font-semibold text-bond-600 hover:text-bond-700">
          ← Back to valuations
        </Link>
      </div>
    );
  }
  if (!valuation) return <Spinner />;

  const editable = editableFields(user, valuation);
  const canEdit = editable.size > 0;
  const ops = isOps(user);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    setBusy(true);
    const patch: Record<string, unknown> = {};
    if (editable.has('company_name') && form.company_name.trim() !== valuation.company_name)
      patch.company_name = form.company_name.trim();
    if (editable.has('service_name') && (form.service_name.trim() || null) !== valuation.service_name)
      patch.service_name = form.service_name.trim() || null;
    if (editable.has('state') && form.state !== valuation.state) patch.state = form.state;
    try {
      if (Object.keys(patch).length > 0) {
        await api(`/valuations/${valuation.id}`, { method: 'PATCH', body: patch });
        await load();
      }
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save changes.');
    } finally {
      setBusy(false);
    }
  };

  const clone = async (rollForward: boolean) => {
    setCloning(true);
    setSaveError(null);
    try {
      const res = await api<{ valuation: Valuation }>(`/valuations/${valuation.id}/clone`, {
        method: 'POST',
        body: { roll_forward: rollForward },
      });
      navigate(`/valuations/${res.valuation.id}`);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not clone the valuation.');
    } finally {
      setCloning(false);
    }
  };

  return (
    <div>
      <Link to="/valuations" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
        ← Valuations
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink-900">{valuation.company_name}</h1>
        <KindBadge kind={valuation.kind} />
        <StateBadge state={valuation.state} />
        {valuation.waiting_on_client && (
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
            Waiting on client
          </span>
        )}
        <span className="ml-auto flex gap-2">
          <Button variant="secondary" disabled={cloning} onClick={() => clone(false)}>
            {cloning ? 'Cloning…' : 'Clone'}
          </Button>
          <Button
            variant="secondary"
            disabled={cloning}
            onClick={() => clone(true)}
            title="Duplicate this engagement for the next valuation date"
          >
            Roll forward →
          </Button>
        </span>
      </div>
      <p className="tnum mt-1.5 text-xs text-ink-400">
        Ref {valuation.id}
        {valuation.number != null && <> · #{valuation.number}</>}
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-8">
          {/* Facts */}
          <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
            <h2 className="overline mb-5 text-ink-400">Engagement details</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
              <Meta label="Service" value={valuation.service_name} />
              <Meta label="Currency" value={valuation.currency} />
              <Meta label="Created" value={formatDate(valuation.created_at)} />
              <Meta label="Due date" value={formatDate(valuation.due_date)} />
              <Meta
                label="Delivery SLA"
                value={valuation.delivery_days ? `${valuation.delivery_days} days` : null}
              />
              <Meta
                label="Payment"
                value={
                  valuation.paid_status === 'unpaid'
                    ? 'Unpaid'
                    : valuation.paid_status === 'paid_by_partner'
                      ? 'Paid by partner'
                      : 'Paid'
                }
              />
              {ops && <Meta label="Source" value={valuation.source} />}
              {ops && <Meta label="Reviewer" value={valuation.assigned_reviewer_id} />}
              <Meta
                label="QSBS attestation"
                value={
                  valuation.qsbs_attestation === null ? '—' : valuation.qsbs_attestation ? 'Yes' : 'No'
                }
              />
            </dl>
          </section>

          {/* Edit — only fields this role may patch */}
          {canEdit && (
            <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
              <h2 className="overline mb-5 text-ink-400">Edit</h2>
              <form onSubmit={save} className="space-y-5">
                {saveError && <ErrorNote>{saveError}</ErrorNote>}
                {saved && (
                  <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
                    Changes saved.
                  </div>
                )}
                <div className="grid gap-5 sm:grid-cols-2">
                  {editable.has('company_name') && (
                    <Field label="Company name">
                      <TextInput
                        value={form.company_name}
                        onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
                        required
                        maxLength={300}
                      />
                    </Field>
                  )}
                  {editable.has('service_name') && (
                    <Field label="Service name">
                      <TextInput
                        value={form.service_name}
                        onChange={(e) => setForm((f) => ({ ...f, service_name: e.target.value }))}
                        maxLength={300}
                        placeholder="e.g. 409A FY26 refresh"
                      />
                    </Field>
                  )}
                  {editable.has('state') && (
                    <Field label="State" hint="Operations only — recorded to the audit trail.">
                      <Select
                        value={form.state}
                        onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                      >
                        {VALUATION_STATES.map((s) => (
                          <option key={s} value={s}>
                            {STATE_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
                <Button type="submit" disabled={busy || !form.company_name.trim()}>
                  {busy ? 'Saving…' : 'Save changes'}
                </Button>
              </form>
            </section>
          )}

          {/* Client chat + sticky notes + threaded email (M3) */}
          <CommentsSection valuationId={valuation.id} />
        </div>

        {/* Audit timeline */}
        <aside>
          <h2 className="overline mb-4 text-ink-400">Activity</h2>
          {!events && <Spinner />}
          {events && events.length === 0 && <p className="text-sm text-ink-400">No activity yet.</p>}
          {events && events.length > 0 && (
            <ol className="relative space-y-5 border-l border-paper-300 pl-5">
              {events.map((ev) => (
                <li key={ev.id} className="relative">
                  <span className="absolute top-1.5 -left-[1.42rem] h-2.5 w-2.5 rounded-full border-2 border-paper-100 bg-bond-500" />
                  <div className="text-sm font-semibold text-ink-800">
                    {EVENT_LABELS[ev.type] ?? ev.type}
                  </div>
                  {ev.type === 'state_changed' && ev.payload && (
                    <div className="mt-0.5 text-xs text-ink-600">
                      {String((ev.payload as { from?: string }).from ?? '')} →{' '}
                      {String((ev.payload as { to?: string }).to ?? '')}
                    </div>
                  )}
                  <div className="tnum mt-0.5 text-xs text-ink-400">
                    {formatDateTime(ev.occurred_at)} · {ev.actor_type}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}
