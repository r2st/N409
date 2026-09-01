import { useCallback, useEffect, useState } from 'react';
import { api, describeActionFailure } from '../lib/api';
import type { ValuationList } from '../lib/types';
import { ErrorNote, Field, InfoTooltip, Select } from './ui';

/**
 * Attach a measurement subject — a fund portfolio, a debt instrument — to the
 * engagement whose report it belongs to.
 *
 * The link is what `loadFundReport` and `loadDebtReport` read: both look the
 * subject up *by* `valuation_id`, and both return null when nothing is
 * attached, at which point `routes/reports.ts` renders a deliverable with no
 * NAV schedule and no instrument pack in it. Nothing on the page says so — the
 * exhibits are simply absent, the way they are for every engagement that has
 * no fund and no instrument.
 *
 * `PUT /funds/:id/valuation` and `PUT /debt/instruments/:id/valuation` have
 * existed since 0109 and nothing in the product ever called either one, so the
 * link could not be made at all and the two report packs were unreachable
 * through the UI. This control is the missing half.
 */
export function MeasurementSubjectLink({
  endpoint,
  kind,
  linkedId,
  onChanged,
}: {
  /** The subject's link endpoint, e.g. `/funds/${id}/valuation`. */
  endpoint: string;
  /** Engagement kind whose engagements may hold this subject. */
  kind: 'fund' | 'debt';
  /** The engagement currently attached, or null. */
  linkedId: string | null;
  onChanged: () => void;
}) {
  const [options, setOptions] = useState<{ id: string; company_name: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ValuationList>(`/valuations?kind=${kind}&per_page=100`)
      .then((d) => live && setOptions(d.valuations.map((v) => ({ id: v.id, company_name: v.company_name }))))
      // The picker is an enhancement to a page that works without it; a failed
      // list leaves the current link stated and the select empty rather than
      // taking the page down. `options === null` renders as "could not load".
      .catch(() => live && setOptions(null));
    return () => {
      live = false;
    };
  }, [kind]);

  const save = useCallback(
    async (next: string) => {
      setSaving(true);
      setError(null);
      try {
        await api(endpoint, { method: 'PUT', body: { valuation_id: next === '' ? null : next } });
        onChanged();
      } catch (e) {
        setError(describeActionFailure(e, 'Could not change the linked engagement.'));
      } finally {
        setSaving(false);
      }
    },
    [endpoint, onChanged],
  );

  return (
    <div className="min-w-[16rem]">
      <Field
        label="Linked engagement"
        tooltip="The engagement whose report prints this subject's schedules. Until one is chosen the report renders without them."
      >
        <Select
          value={linkedId ?? ''}
          disabled={saving}
          onChange={(e) => void save(e.target.value)}
          aria-label="Linked engagement"
        >
          <option value="">— not linked —</option>
          {/* The current link stays selectable even when the list did not load
              or does not reach it, so opening the control cannot silently
              detach a subject that is already attached. */}
          {linkedId && !options?.some((o) => o.id === linkedId) && (
            <option value={linkedId}>{linkedId}</option>
          )}
          {(options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.company_name}
            </option>
          ))}
        </Select>
      </Field>
      {options === null && (
        <p className="mt-1 text-xs text-ink-500">
          Could not load the engagement list.{' '}
          <InfoTooltip
            label="About the engagement list"
            text="The link above is still what the server holds. Reload the page to try the list again."
          />
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
