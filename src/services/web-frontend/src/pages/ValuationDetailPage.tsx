import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { editableFields, isOps } from '../lib/rbac';
import { formatDate, formatDateTime, STATE_LABELS } from '../lib/format';
import { VALUATION_STATES } from '../lib/types';
import type { Valuation, ValuationEvent } from '../lib/types';
import { useWorkspace } from './valuation/ValuationWorkspace';
import { Button, ErrorNote, Field, Select, Spinner, TextInput } from '../components/ui';
import { CommentsSection } from '../components/CommentThread';
import { WorkflowActions } from '../components/WorkflowActions';
import { FundingHistory } from '../components/FundingHistory';
import { PaymentHistory, PaymentSection } from '../components/PaymentSection';
import { SignaturePanel } from '../components/SignaturePanel';
import { BoardApprovalPanel } from '../components/BoardApprovalPanel';

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
  review_decision: 'Review decision',
  email_received: 'Email received',
  valuation_cloned: 'Cloned from another valuation',
  overwrite_applied: 'Override applied',
  overwrite_reverted: 'Override reverted',
  workbook_updated: 'Workbook updated',
  report_saved: 'Report saved',
  report_reverted: 'Report version restored',
  report_rendered: 'Report PDF rendered',
  funding_round_added: 'Funding round added',
  funding_round_updated: 'Funding round updated',
  funding_round_deleted: 'Funding round removed',
  transaction_added: 'Transaction added',
  transaction_updated: 'Transaction updated',
  transaction_deleted: 'Transaction removed',
};

/** Overview tab — engagement facts, role-gated editing, workflow, funding, audit. */
export function ValuationDetailPage() {
  const { valuation, reload, commentTick } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [events, setEvents] = useState<ValuationEvent[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [form, setForm] = useState({
    company_name: valuation.company_name,
    service_name: valuation.service_name ?? '',
    state: valuation.state as string,
  });

  const loadEvents = useCallback(async () => {
    try {
      const { events: ev } = await api<{ events: ValuationEvent[] }>(`/valuations/${valuation.id}/events`);
      setEvents(ev);
    } catch {
      setEvents([]);
    }
  }, [valuation.id]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const refresh = useCallback(async () => {
    await Promise.all([reload(), loadEvents()]);
  }, [reload, loadEvents]);

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
        await refresh();
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

  const exportEvidence = async () => {
    setExporting(true);
    setSaveError(null);
    try {
      await apiDownload(
        `/valuations/${valuation.id}/evidence-bundle`,
        `evidence-bundle-${valuation.number ?? valuation.id}.zip`,
        { method: 'POST' },
      );
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not export the evidence bundle.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-8">
        {/* P0: Stripe checkout for unpaid engagements */}
        <PaymentSection valuation={valuation} />

        {/* P0: past checkout attempts with receipt links (hides when empty) */}
        <PaymentHistory valuation={valuation} />

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

        {/* M3: clone / roll-forward · evidence bundle (audit defense, ops-only) */}
        <div className="flex flex-wrap justify-end gap-2">
          {ops && (
            <Button
              variant="secondary"
              disabled={exporting}
              onClick={() => void exportEvidence()}
              title="Download the full audit trail — events, calculations, documents, signatures, AI provenance — as a ZIP"
            >
              {exporting ? 'Exporting…' : 'Export Evidence Bundle'}
            </Button>
          )}
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
        </div>

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

        {/* M4: workflow engine controls (ops) */}
        {ops && <WorkflowActions valuation={valuation} onChanged={refresh} />}

        {/* Signature gating before publish (ops) */}
        {ops && <SignaturePanel valuation={valuation} />}

        {/* Feature 5: board resolution + e-signature collection (ops) */}
        {ops && <BoardApprovalPanel valuation={valuation} />}

        {/* M4: transaction & funding-round history */}
        <FundingHistory
          valuationId={valuation.id}
          currency={valuation.currency}
          canEdit={ops || valuation.user_id === user?.id}
        />

        {/* M3: client chat + sticky notes + threaded email — live via SSE */}
        <CommentsSection valuationId={valuation.id} refreshKey={commentTick} />
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
                {ev.type === 'review_decision' && ev.payload && (
                  <div className="mt-0.5 text-xs text-ink-600">
                    {(ev.payload as { decision?: string }).decision === 'approve'
                      ? 'Approved'
                      : 'Changes requested'}
                    {' · '}
                    {String((ev.payload as { from?: string }).from ?? '')} →{' '}
                    {String((ev.payload as { to?: string }).to ?? '')}
                  </div>
                )}
                {(ev.type === 'overwrite_applied' || ev.type === 'overwrite_reverted') && ev.payload && (
                  <div className="mt-0.5 text-xs text-ink-600">
                    {String((ev.payload as { field_key?: string }).field_key ?? '')}
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
  );
}
