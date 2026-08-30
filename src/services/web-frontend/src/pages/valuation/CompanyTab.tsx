import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, ifMatch, describeActionFailure } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import {
  Button,
  ErrorNote,
  Field,
  inputClass,
  LoadError,
  Select,
  Spinner,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';
import { useWorkspace } from './ValuationWorkspace';
import { TagsPanel } from '../../components/valuation/TagsPanel';

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
  /** Migration 0151 — the three fields the `company_profile` agent drafts. */
  business_description: string | null;
  sic_code: string | null;
  naics_code: string | null;
  founded_on: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  cap_table_summary: string | null;
  /**
   * Optimistic-lock counter (migration 0166), echoed back as `If-Match` on
   * save. Optional so an older server that does not report it falls back to
   * last-write-wins rather than failing.
   */
  version?: number;
  updated_at: string;
}

/**
 * The profile columns the agent may fill — `AGENT_PROFILE_FIELDS` in the
 * valuation service's domain/companyProfile.ts. Only these are merged back
 * after an apply; see `applyAgent`.
 */
const AGENT_FIELDS = ['business_description', 'industry', 'sic_code', 'naics_code'] as const;
type AgentField = (typeof AGENT_FIELDS)[number];

const AGENT_FIELD_LABELS: Record<AgentField, string> = {
  business_description: 'Business description',
  industry: 'Industry',
  sic_code: 'SIC code',
  naics_code: 'NAICS code',
};

const SKIP_REASONS: Record<string, string> = {
  already_set: 'already filled in',
  malformed: 'the agent returned an unusable value',
  empty: 'the documents did not say',
};

/**
 * Mirrors `isSicCode` / `isNaicsCode` in the valuation service's
 * domain/companyProfile.ts, which refuse a malformed code at both the hand
 * editor and the agent's apply path. The reason it is worth refusing at all:
 * the comparable screen ranks the reference universe on the SIC, and a
 * malformed one matches no row — so it presents as "no comparable companies
 * found" rather than as the bad input it is.
 */
const SIC_PATTERN = /^\d{2,4}$/;
const NAICS_PATTERN = /^\d{2,6}$/;

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
  business_description: string;
  sic_code: string;
  naics_code: string;
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
  business_description: '',
  sic_code: '',
  naics_code: '',
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
    business_description: profile.business_description ?? '',
    sic_code: profile.sic_code ?? '',
    naics_code: profile.naics_code ?? '',
    founded_on: profile.founded_on ?? '',
    employee_count: profile.employee_count === null ? '' : String(profile.employee_count),
    revenue_range: profile.revenue_range ?? '',
    cap_table_summary: profile.cap_table_summary ?? '',
  };
}

/** Structured company details behind the engagement's company name —
 * editable by ops and the requesting client. */
export function CompanyTab() {
  const { valuation, retired } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** The AI drafting panel — ops-only, because the AI routes are. */
  const [agentPhase, setAgentPhase] = useState<'drafting' | 'applying' | null>(null);
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  /**
   * The profile version this form was filled in from, sent back as `If-Match`.
   *
   * The save below posts all sixteen columns whether the analyst touched them
   * or not, so it does not say "set the website" — it says "make the row look
   * like it did when I opened this tab". Three writers reach that row (ops, the
   * client from their portal, and the `company_profile` agent's apply), and
   * without this the last of them to press Save reverts the other two
   * silently, with a 200 (migration 0166).
   *
   * Undefined until a profile exists: the GET returns `profile: null` and no
   * ETag before the first save, and `ifMatch` then sends nothing.
   */
  const [version, setVersion] = useState<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const { profile } = await api<{ profile: CompanyProfile | null }>(
        `/valuations/${valuation.id}/company-profile`,
      );
      setDraft(toDraft(profile));
      setVersion(profile?.version);
      return true;
    } catch {
      setError('Could not load the company profile.');
      return false;
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!draft) return <Spinner />;

  const set = (key: keyof Draft) => (value: string) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSaved(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    setSaved(false);

    // Two refusals, not one: `10000001` is a whole number, and telling the
    // analyst who typed it that it is not sends them looking for a typo that
    // isn't there. The ceiling matches the API's own `max(10_000_000)`.
    const employeeCount = draft.employee_count.trim();
    if (employeeCount !== '' && !/^\d+$/.test(employeeCount)) {
      setFieldError('Employee count must be a whole number.');
      return;
    }
    if (employeeCount !== '' && Number(employeeCount) > 10_000_000) {
      setFieldError('Employee count must be 10,000,000 or fewer.');
      return;
    }

    // Refused here as well as by the API, because the failure a malformed code
    // causes is silent and far away: it reaches the comparable screen, ranks
    // against no universe row, and reads as "no comparable companies found".
    const sic = draft.sic_code.trim();
    if (sic !== '' && !SIC_PATTERN.test(sic)) {
      setFieldError('A SIC code is 2–4 digits.');
      return;
    }
    const naics = draft.naics_code.trim();
    if (naics !== '' && !NAICS_PATTERN.test(naics)) {
      setFieldError('A NAICS code is 2–6 digits.');
      return;
    }

    const nullable = (v: string) => (v.trim() === '' ? null : v.trim());
    setSaving(true);
    try {
      const { profile: saved } = await api<{ profile?: CompanyProfile }>(
        `/valuations/${valuation.id}/company-profile`,
        {
          method: 'PATCH',
          headers: ifMatch(version),
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
            business_description: nullable(draft.business_description),
            sic_code: nullable(draft.sic_code),
            naics_code: nullable(draft.naics_code),
            founded_on: nullable(draft.founded_on),
            employee_count: employeeCount === '' ? null : Number(employeeCount),
            revenue_range: nullable(draft.revenue_range),
            cap_table_summary: nullable(draft.cap_table_summary),
          },
        },
      );
      // Take the version the write produced, so a second save from this same
      // form is not refused for a change this user just made themselves.
      setVersion(saved?.version);
      setSaved(true);
    } catch (err) {
      // A conflict is an out-of-date form rather than a failed save: reload it
      // so the analyst reapplies onto what actually landed. Reloading is what
      // clears the stale fields this form would otherwise post again on the
      // next attempt — the agent's description among them.
      if (err instanceof ApiError && err.status === 409) {
        await load();
        setFieldError(
          err.problem.detail ??
            'Someone else changed this company profile while you were editing. It has been reloaded — please reapply your changes.',
        );
      } else {
        setFieldError(describeActionFailure(err, 'Could not save the company profile.'));
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * Run the `company_profile` agent over the engagement's own documents and
   * apply what it drafted.
   *
   * Run then apply, one button, for the reason the comparables tab gives: they
   * are two endpoints but one intention, and a failed run must not fall through
   * to an apply that would take whatever earlier run happened to succeed.
   *
   * **Only the agent's own four fields are merged back.** The apply returns the
   * whole stored row, and seeding the draft from it would discard any unsaved
   * edit elsewhere on this form — the analyst who typed a website, then asked
   * for a description, would silently lose the website. The agent writes four
   * columns; four is what comes back into the draft.
   */
  const applyAgent = async () => {
    setAgentError(null);
    setAgentNote(null);
    setAgentPhase('drafting');
    try {
      await api(`/valuations/${valuation.id}/ai/company_profile`, { method: 'POST' });
      setAgentPhase('applying');
      const res = await api<{
        profile: CompanyProfile;
        applied_fields: AgentField[];
        skipped_fields: Array<{ field: AgentField; reason: string }>;
      }>(`/valuations/${valuation.id}/ai/company_profile/apply`, {
        method: 'POST',
        body: { overwrite },
      });
      // Only the fields the apply says it *wrote*. Merging all four merged the
      // skipped ones too, and a skipped field is precisely one the server
      // declined to touch: with the overwrite box clear, an analyst who had
      // typed an industry without saving it got the stored value pushed over
      // their entry, under a note that read "Left alone: Industry (already
      // filled in)". Held back is held back on the form as well as in the row.
      const written = new Set<AgentField>(
        res.applied_fields.filter((f): f is AgentField => AGENT_FIELDS.includes(f)),
      );
      setDraft((d) => {
        if (d === null) return d;
        const next = { ...d };
        for (const field of written) next[field] = res.profile[field] ?? '';
        return next;
      });
      // The apply just wrote the row, so the version this form is holding is
      // now the stale one — and the writer that made it stale is this user.
      // Without this line the very next Save is refused for their own agent
      // run, which is a lost-update guard doing precisely the wrong thing.
      setVersion(res.profile.version);
      // The applied fields are already saved — the apply wrote them — so this
      // must not read as an unsaved change waiting on Save.
      setSaved(false);
      const applied = res.applied_fields.map((f) => AGENT_FIELD_LABELS[f] ?? f);
      const held = res.skipped_fields.map(
        (s) => `${AGENT_FIELD_LABELS[s.field] ?? s.field} (${SKIP_REASONS[s.reason] ?? s.reason})`,
      );
      setAgentNote(
        `Drafted and saved ${applied.join(', ')}.` +
          (held.length > 0 ? ` Left alone: ${held.join(', ')}.` : ''),
      );
    } catch (err) {
      setAgentError(describeActionFailure(err, 'Could not draft the company profile.'));
    } finally {
      setAgentPhase(null);
    }
  };

  return (
    /*
     * The tag panel is a *sibling* of the form, not a section inside it. Every
     * control it owns is a `button` with no explicit type, which inside a form
     * is a submit button — accepting a tag would have saved the profile, and
     * the two writes have nothing to do with each other.
     */
    <div className="max-w-3xl space-y-8">
      <form onSubmit={(e) => void submit(e)} className="space-y-8">
        <WriteGate closed={retired}>
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

          {/* The three fields the report's company section is written from — and,
          until now, the three the API accepted with nowhere on screen to type
          them. The classification sits beside the description because the codes
          are what the description is being classified *as*. */}
          <section>
            <h2 className="overline mb-4 text-ink-400">Business and classification</h2>
            {ops && (
              <div className="mb-4 rounded-lg border border-bond-200 bg-bond-50 px-4 py-3">
                <p className="text-sm text-bond-800">
                  Draft these from the engagement's own uploaded documents. The agent never looks the company
                  up and never sees its name — it reads the deck and the financials you have already uploaded,
                  so a reviewer can trace every sentence back to a document in the engagement.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={agentPhase !== null}
                    onClick={() => void applyAgent()}
                  >
                    {agentPhase === 'drafting'
                      ? 'Reading documents…'
                      : agentPhase === 'applying'
                        ? 'Applying…'
                        : 'Draft with AI'}
                  </Button>
                  {/* Blanks only by default: an analyst who classified this business
                  by hand and then ran the agent did not ask to have that
                  reconsidered. This is the explicit opt-in. */}
                  <label className="flex items-center gap-2 text-sm text-bond-800">
                    <input
                      type="checkbox"
                      checked={overwrite}
                      onChange={(e) => setOverwrite(e.target.checked)}
                    />
                    Replace values already on the profile
                  </label>
                </div>
                {agentPhase === 'drafting' && (
                  <p className="mt-2 text-xs text-bond-700">Free-tier models can take up to a minute…</p>
                )}
                {agentNote && (
                  <p role="status" className="mt-2 text-sm font-medium text-bond-800">
                    {agentNote}
                  </p>
                )}
                {agentError && (
                  <p className="mt-2 text-sm text-red-700" role="alert">
                    {agentError}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-4">
              <Field
                label="Business description"
                hint="What the company does, in the words the report's company section will be drafted from."
              >
                <textarea
                  className={`${inputClass} min-h-28`}
                  value={draft.business_description}
                  onChange={(e) => set('business_description')(e.target.value)}
                  maxLength={20000}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="SIC code" hint="2–4 digits — the comparable screen ranks the universe on it.">
                  <TextInput
                    inputMode="numeric"
                    value={draft.sic_code}
                    onChange={(e) => set('sic_code')(e.target.value)}
                    placeholder="e.g. 7372"
                  />
                </Field>
                <Field label="NAICS code" hint="2–6 digits.">
                  <TextInput
                    inputMode="numeric"
                    value={draft.naics_code}
                    onChange={(e) => set('naics_code')(e.target.value)}
                    placeholder="e.g. 511210"
                  />
                </Field>
              </div>
            </div>
          </section>

          <section>
            <h2 className="overline mb-4 text-ink-400">Registered address</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address line 1">
                <TextInput
                  value={draft.address_line1}
                  onChange={(e) => set('address_line1')(e.target.value)}
                />
              </Field>
              <Field label="Address line 2">
                <TextInput
                  value={draft.address_line2}
                  onChange={(e) => set('address_line2')(e.target.value)}
                />
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
            {saved && (
              <span role="status" className="text-sm font-medium text-bond-700">
                Saved.
              </span>
            )}
          </div>
        </WriteGate>
      </form>

      {/*
       * Engagement tags (409.ai parity gap #23). On the company tab because a
       * tag classifies the *business* — stage, revenue, model, geography —
       * which is what every other field on this screen also describes.
       *
       * Rendered for a client too, read-only: the filter and the precedent
       * query reason from these, so a client seeing how their engagement is
       * classified is the same disclosure as the rest of this tab. Writing is
       * operations-only, which is `canWrite`.
       */}
      <TagsPanel valuationId={valuation.id} canWrite={ops && !retired} />
    </div>
  );
}
