import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote, Field, PickerOverflowNote, Select } from '../ui';

interface Organization {
  id: string;
  name: string;
}

const ENTITY_ROLES = [
  { value: 'standalone', label: 'Standalone' },
  { value: 'parent', label: 'Parent' },
  { value: 'subsidiary', label: 'Subsidiary' },
  { value: 'portfolio_company', label: 'Portfolio company' },
];

/**
 * Assign this valuation (business) to an organization and set its entity role
 * (feature 6). Lightweight — lists the caller's organizations and posts the
 * assignment; the Portfolio page shows the consolidated roll-up.
 */
export function OrgAssignmentCard({ valuationId }: { valuationId: string }) {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [role, setRole] = useState('portfolio_company');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // A failed list used to be stored as an empty one, which rendered the "create
  // an organization on the Portfolio page" prose — telling an owner of six
  // organizations that they have none. Failure and emptiness are now distinct.
  const [listFailed, setListFailed] = useState(false);
  const [listCapped, setListCapped] = useState(false);

  useEffect(() => {
    api<{ organizations: Organization[]; truncated: boolean }>('/organizations')
      .then((r) => {
        setOrgs(r.organizations);
        setListCapped(r.truncated);
      })
      .catch(() => setListFailed(true));
  }, []);

  if (!orgs && !listFailed) return null;

  const assign = async () => {
    if (!orgId) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await api(`/organizations/${orgId}/entities`, {
        method: 'POST',
        body: { valuation_id: valuationId, entity_type: role },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not assign to the organization.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-4 text-ink-400">Portfolio</h2>
      {/* Past the guard above, a null list is a failed one. */}
      {!orgs ? (
        <ErrorNote>Could not load your organizations.</ErrorNote>
      ) : orgs.length === 0 ? (
        <p className="text-sm text-ink-400">
          Create an organization on the Portfolio page to group this entity into a fund or holding company.
        </p>
      ) : (
        <div className="space-y-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {saved && (
            <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
              Assigned to the organization.
            </div>
          )}
          <Field label="Organization">
            <Select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
              <option value="">Select…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
              <PickerOverflowNote truncated={listCapped} />
            </Select>
          </Field>
          <Field label="Entity role">
            <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Entity role">
              {ENTITY_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button disabled={busy || !orgId} onClick={assign}>
            {busy ? 'Assigning…' : 'Assign to portfolio'}
          </Button>
        </div>
      )}
    </section>
  );
}
