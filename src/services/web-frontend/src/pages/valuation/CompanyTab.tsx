import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote, Field, Select, Spinner, TextInput, inputClass } from '../../components/ui';
import { useWorkspace } from './ValuationWorkspace';

export interface CompanyProfile {
  valuation_id: string;
  legal_name: string | null;
  website: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  industry: string | null;
  founded_on: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  cap_table_summary: string | null;
  updated_at: string;
}

export const REVENUE_RANGE_LABELS: Record<string, string> = {
  pre_revenue: 'Pre-revenue',
  under_1m: 'Under $1M',
  '1m_10m': '$1M – $10M',
  '10m_50m': '$10M – $50M',
  '50m_100m': '$50M – $100M',
  over_100m: 'Over $100M',
};

type Draft = {
  legal_name: string;
  website: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  industry: string;
  founded_on: string;
  employee_count: string;
  revenue_range: string;
  cap_table_summary: string;
};

const EMPTY: Draft = {
  legal_name: '',
  website: '',
  address_line1: '',
  address_line2: '',
  city: '',
  region: '',
  postal_code: '',
  country: '',
  industry: '',
  founded_on: '',
  employee_count: '',
  revenue_range: '',
  cap_table_summary: '',
};

function toDraft(profile: CompanyProfile | null): Draft {
  if (!profile) return EMPTY;
  return {
    legal_name: profile.legal_name ?? '',
    website: profile.website ?? '',
    address_line1: profile.address_line1 ?? '',
    address_line2: profile.address_line2 ?? '',
    city: profile.city ?? '',
    region: profile.region ?? '',
    postal_code: profile.postal_code ?? '',
    country: profile.country ?? '',
    industry: profile.industry ?? '',
    founded_on: profile.founded_on ?? '',
    employee_count: profile.employee_count === null ? '' : String(profile.employee_count),
    revenue_range: profile.revenue_range ?? '',
    cap_table_summary: profile.cap_table_summary ?? '',
  };
}

/** Structured company details behind the engagement's company name —
 * editable by ops and the requesting client. */
export function CompanyTab() {
  const { valuation } = useWorkspace();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ profile: CompanyProfile | null }>(`/valuations/${valuation.id}/company-profile`)
      .then(({ profile }) => {
        if (!cancelled) setDraft(toDraft(profile));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the company profile.');
      });
    return () => {
      cancelled = true;
    };
  }, [valuation.id]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!draft) return <Spinner />;

  const set = (key: keyof Draft) => (value: string) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSaved(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    setSaved(false);

    const employeeCount = draft.employee_count.trim();
    if (employeeCount !== '' && (!/^\d+$/.test(employeeCount) || Number(employeeCount) > 10_000_000)) {
      setFieldError('Employee count must be a whole number.');
      return;
    }

    const nullable = (v: string) => (v.trim() === '' ? null : v.trim());
    setSaving(true);
    try {
      await api(`/valuations/${valuation.id}/company-profile`, {
        method: 'PATCH',
        body: {
          legal_name: nullable(draft.legal_name),
          website: nullable(draft.website),
          address_line1: nullable(draft.address_line1),
          address_line2: nullable(draft.address_line2),
          city: nullable(draft.city),
          region: nullable(draft.region),
          postal_code: nullable(draft.postal_code),
          country: nullable(draft.country),
          industry: nullable(draft.industry),
          founded_on: nullable(draft.founded_on),
          employee_count: employeeCount === '' ? null : Number(employeeCount),
          revenue_range: nullable(draft.revenue_range),
          cap_table_summary: nullable(draft.cap_table_summary),
        },
      });
      setSaved(true);
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : 'Could not save the company profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-3xl space-y-8">
      <section>
        <h2 className="overline mb-4 text-ink-400">Company</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name" hint={`Engagement name: ${valuation.company_name}`}>
            <TextInput value={draft.legal_name} onChange={(e) => set('legal_name')(e.target.value)} />
          </Field>
          <Field label="Website">
            <TextInput
              value={draft.website}
              onChange={(e) => set('website')(e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <Field label="Industry">
            <TextInput
              value={draft.industry}
              onChange={(e) => set('industry')(e.target.value)}
              placeholder="e.g. B2B SaaS — logistics"
            />
          </Field>
          <Field label="Founded">
            <TextInput
              type="date"
              value={draft.founded_on}
              onChange={(e) => set('founded_on')(e.target.value)}
            />
          </Field>
          <Field label="Employees">
            <TextInput
              inputMode="numeric"
              value={draft.employee_count}
              onChange={(e) => set('employee_count')(e.target.value)}
              placeholder="e.g. 42"
            />
          </Field>
          <Field label="Revenue range">
            <Select value={draft.revenue_range} onChange={(e) => set('revenue_range')(e.target.value)}>
              <option value="">Not set</option>
              {Object.entries(REVENUE_RANGE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section>
        <h2 className="overline mb-4 text-ink-400">Registered address</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address line 1">
            <TextInput value={draft.address_line1} onChange={(e) => set('address_line1')(e.target.value)} />
          </Field>
          <Field label="Address line 2">
            <TextInput value={draft.address_line2} onChange={(e) => set('address_line2')(e.target.value)} />
          </Field>
          <Field label="City">
            <TextInput value={draft.city} onChange={(e) => set('city')(e.target.value)} />
          </Field>
          <Field label="State / region">
            <TextInput value={draft.region} onChange={(e) => set('region')(e.target.value)} />
          </Field>
          <Field label="Postal code">
            <TextInput value={draft.postal_code} onChange={(e) => set('postal_code')(e.target.value)} />
          </Field>
          <Field label="Country">
            <TextInput value={draft.country} onChange={(e) => set('country')(e.target.value)} />
          </Field>
        </div>
      </section>

      <section>
        <h2 className="overline mb-4 text-ink-400">Cap table summary</h2>
        <Field
          label="Summary"
          hint="Free-form snapshot of share classes and ownership — the detailed cap table lives in Documents."
        >
          <textarea
            className={`${inputClass} min-h-28`}
            value={draft.cap_table_summary}
            onChange={(e) => set('cap_table_summary')(e.target.value)}
            maxLength={20000}
          />
        </Field>
      </section>

      {fieldError && <ErrorNote>{fieldError}</ErrorNote>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
        {saved && <span className="text-sm font-medium text-bond-700">Saved.</span>}
      </div>
    </form>
  );
}
