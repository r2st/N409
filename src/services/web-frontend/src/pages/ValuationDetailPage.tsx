import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiDownload, ApiError, ifMatch, describeActionFailure } from '../lib/api';
import { required, useFormValidation } from '../lib/useFormValidation';
import { useAuth } from '../lib/auth';
import { editableFields, isOps } from '../lib/rbac';
import { eventLabel, formatDate, formatDateTime, sourceLabel, STATE_LABELS } from '../lib/format';
import { VALUATION_STATES } from '../lib/types';
import type { Valuation, ValuationEvent } from '../lib/types';
import { useWorkspace } from './valuation/ValuationWorkspace';
import {
  Button,
  ErrorNote,
  Field,
  Select,
  Spinner,
  SuccessNote,
  TextInput,
  WriteGate,
} from '../components/ui';
import { CommentsSection } from '../components/CommentThread';
import { WorkflowActions } from '../components/WorkflowActions';
import { FundingHistory } from '../components/FundingHistory';
import { PaymentHistory, PaymentSection } from '../components/PaymentSection';
import { SignaturePanel } from '../components/SignaturePanel';
import { BoardApprovalPanel } from '../components/BoardApprovalPanel';
import { OrgAssignmentCard } from '../components/valuation/OrgAssignmentCard';
import { AuditorAccessPanel } from '../components/valuation/AuditorAccessPanel';

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="overline text-ink-400">{label}</dt>
      <dd className="mt-1 text-sm text-ink-900">{value ?? '—'}</dd>
    </div>
  );
}

/**
 * How much of the spine the Activity sidebar asks for.
 *
 * The panel used to request the whole event history and render every row into
 * one `<ol>`. On an engagement rolled forward for years that is thousands of
 * rows with their payloads, fetched and laid out to fill a sidebar nobody
 * scrolls to the bottom of. The newest slice is what the panel is for; the
 * Change History tab is where the rest lives, and is where the note below
 * sends anyone who wants it.
 */
const ACTIVITY_LIMIT = 100;

/** Overview tab — engagement facts, role-gated editing, workflow, funding, audit. */
export function ValuationDetailPage() {
  const { valuation, reload, commentTick, retired } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [events, setEvents] = useState<ValuationEvent[] | null>(null);
  /** True when the engagement has older activity than this panel asked for. */
  const [eventsTruncated, setEventsTruncated] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
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
      // Ask for what the panel renders. The endpoint caps this anyway, but a
      // sidebar that asks for everything and then scrolls forever is not the
      // thing to build on top of the cap.
      const { events: ev, truncated } = await api<{ events: ValuationEvent[]; truncated: boolean }>(
        `/valuations/${valuation.id}/events?limit=${ACTIVITY_LIMIT}`,
      );
      setEvents(ev);
      setEventsTruncated(truncated);
      setEventsError(null);
    } catch (err) {
      // Emphatically not `setEvents([])`: an engagement with a full audit trail
      // would then render "No activity yet." — a wrong answer, on the one panel
      // whose job is to be the record of what happened.
      setEvents(null);
      setEventsError(describeActionFailure(err, 'Could not load the activity timeline.'));
    }
  }, [valuation.id]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const refresh = useCallback(async () => {
    await Promise.all([reload(), loadEvents()]);
  }, [reload, loadEvents]);

  const editable = editableFields(user, valuation);
  /**
   * A retired engagement is readable and not writable.
   *
   * The API refuses every write against one with a 409, and did so for the
   * board, auditor and payment routes before it did for the rest. This page
   * went on offering the buttons regardless, so the whole surface behaved as
   * though the file were live right up to the moment the server said otherwise
   * — and said it in a toast, one action at a time.
   *
   * Nothing links here for a retired engagement (they are out of every list),
   * so anyone seeing this arrived by bookmark or an old link and has no other
   * way to learn why their save failed. The banner that says so is the
   * workspace's now rather than this page's — it was only ever on Overview,
   * and the other twenty-four tabs said nothing at all.
   */
  const canEdit = editable.size > 0 && !retired;
  const ops = isOps(user);

  /*
   * Only `company_name` carries a rule — the state is a select and the service
   * name is genuinely free text. The rule is here rather than on the button
   * because the button was disabled on an empty name with nothing to say why,
   * which reads as a broken save on the one form whose job is renaming.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(form, {
    company_name: required('company_name', 'Company name'),
  });

  const save = handleSubmit(async () => {
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
        await api(`/valuations/${valuation.id}`, {
          method: 'PATCH',
          body: patch,
          // The version this form was rendered from. The server refuses the
          // write with a 409 if anyone saved since, rather than letting this
          // form's copy of the untouched fields overwrite their edit — the
          // workspace is shared between the analyst, the reviewer and ops, so
          // two people on one valuation is routine (migration 0137).
          headers: ifMatch(valuation.version),
        });
        await refresh();
      }
      setSaved(true);
    } catch (err) {
      // A conflict is not a failed save so much as an out-of-date page: reload
      // so the user is looking at what actually landed before they retype.
      if (err instanceof ApiError && err.status === 409) {
        await refresh();
        setSaveError(
          err.problem.detail ??
            'Someone else changed this valuation while you were editing. It has been reloaded — please reapply your changes.',
        );
      } else {
        setSaveError(describeActionFailure(err, 'Could not save changes.'));
      }
    } finally {
      setBusy(false);
    }
  });

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
      setSaveError(describeActionFailure(err, 'Could not clone the valuation.'));
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
      setSaveError(describeActionFailure(err, 'Could not export the evidence bundle.'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-8">
        {/* P0: Stripe checkout for unpaid engagements */}
        {!retired && <PaymentSection valuation={valuation} />}

        {/* P0: past checkout attempts with receipt links (hides when empty) */}
        <PaymentHistory valuation={valuation} />

        {/* Feature 6: assign this entity to an organization / fund */}
        {/* Feature 8: external auditor share links */}
        {/* Both refuse a retired engagement server-side — `organizations.ts`
            through `loadEditableValuation`, and `auditor-access` by hand — and
            minting a *new* auditor link for withdrawn work is the one of the
            two that would be read as the firm still standing behind it. */}
        <WriteGate closed={retired}>
          <OrgAssignmentCard valuationId={valuation.id} />
          <AuditorAccessPanel valuationId={valuation.id} />
        </WriteGate>

        {/* Facts */}
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
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
            {ops && <Meta label="Source" value={valuation.source ? sourceLabel(valuation.source) : null} />}
            {ops && <Meta label="Reviewer" value={valuation.assigned_reviewer_id} />}
            <Meta
              label="QSBS attestation"
              value={valuation.qsbs_attestation === null ? '—' : valuation.qsbs_attestation ? 'Yes' : 'No'}
            />
          </dl>
        </section>

        {/* M3: clone / roll-forward · evidence bundle (audit defense, ops-only) */}
        {/* Every one of these is refused for a retired engagement, so the row
            is not rendered at all rather than rendered disabled. The reason
            given here used to be that nothing would ever re-enable it, which
            R90 falsified — an admin can restore from Data retention. The row
            stays hidden on the weaker reason that survives: these are the
            actions that *start* something (a clone, a bundle, a new
            engagement), and offering them greyed out on a withdrawn file reads
            as a queue of work waiting to happen. */}
        {!retired && (
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
        )}

        {/* Edit — only fields this role may patch */}
        {canEdit && (
          <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <h2 className="overline mb-5 text-ink-400">Edit</h2>
            <form onSubmit={save} className="space-y-5" noValidate>
              {saveError && <ErrorNote>{saveError}</ErrorNote>}
              {saved && <SuccessNote>Changes saved.</SuccessNote>}
              <div className="grid gap-5 sm:grid-cols-2">
                {editable.has('company_name') && (
                  <Field label="Company name" error={errorFor('company_name')}>
                    <TextInput
                      value={form.company_name}
                      onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
                      onBlur={blurHandler('company_name')}
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
              <Button type="submit" disabled={busy}>
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
        {eventsError && <ErrorNote>{eventsError}</ErrorNote>}
        {!events && !eventsError && <Spinner />}
        {events && events.length === 0 && <p className="text-sm text-ink-400">No activity yet.</p>}
        {/*
          Above the list, not below it: the list runs oldest-first, so what the
          cap dropped sits off the *top*. A timeline that begins mid-history
          without saying so reads as the whole record on the one panel whose job
          is to be the record.
        */}
        {eventsTruncated && (
          <p className="mb-4 text-xs text-ink-500">
            Showing the {ACTIVITY_LIMIT} most recent entries.{' '}
            <Link to={`/valuations/${valuation.id}/audit-trail`} className="underline">
              See the full change history
            </Link>
            .
          </p>
        )}
        {events && events.length > 0 && (
          <ol className="relative space-y-5 border-l border-paper-300 pl-5">
            {events.map((ev) => (
              <li key={ev.id} className="relative">
                <span className="absolute top-1.5 -left-[1.42rem] h-2.5 w-2.5 rounded-full border-2 border-paper-100 bg-bond-500" />
                <div className="text-sm font-semibold text-ink-800">{ev.label ?? eventLabel(ev.type)}</div>
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
