/**
 * The company profile's typed fields, and the AI draft that can fill them
 * (migrations 0151/0152).
 *
 * Two things live here because both the hand-editor and the agent's apply path
 * need them and must not disagree:
 *
 *   * what a well-formed SIC / NAICS code is. The comparable screen ranks the
 *     universe on the SIC, and a malformed one matches no row — so it presents
 *     as "no comparable companies found" rather than as the bad input it is.
 *     Refusing it at both entry points is what keeps that from happening.
 *   * which of an agent's fields may be written over which existing values.
 */

import { sliceChars } from './textSlice.js';

/** SIC is 2-4 digits (division, major group, industry group, industry). */
export const SIC_PATTERN = /^\d{2,4}$/;
/** NAICS is 2-6 digits, narrowing the same way. */
export const NAICS_PATTERN = /^\d{2,6}$/;

export function isSicCode(value: string): boolean {
  return SIC_PATTERN.test(value.trim());
}

export function isNaicsCode(value: string): boolean {
  return NAICS_PATTERN.test(value.trim());
}

/** An input problem the analyst has to fix — the route maps it to a 422. */
export class AiCompanyProfileError extends Error {}

/**
 * The profile fields the `report_narrative` agent receives.
 *
 * A whitelist, not the row. The row carries a street address, a postal code and
 * a legal name, and the narrative agent has no section that wants any of them —
 * shipping them would put the engagement's most identifying fields into a
 * prompt to buy nothing. What the company-overview section actually needs is
 * what the business does, what industry it is in, and its scale.
 *
 * Null when the profile has none of that, so the caller omits the block
 * entirely rather than sending a heading with nothing under it.
 */
export const NARRATIVE_PROFILE_FIELDS = [
  'business_description',
  'industry',
  'sic_code',
  'naics_code',
  'revenue_range',
  'employee_count',
  'founded_on',
] as const;
export type NarrativeProfileField = (typeof NARRATIVE_PROFILE_FIELDS)[number];

export function narrativeProfilePayload(
  profile: Partial<Record<NarrativeProfileField, unknown>> | null,
): Record<string, unknown> | null {
  if (profile === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of NARRATIVE_PROFILE_FIELDS) {
    const value = profile[field];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The profile columns the `company_profile` agent is allowed to fill. */
export const AGENT_PROFILE_FIELDS = ['business_description', 'industry', 'sic_code', 'naics_code'] as const;
export type AgentProfileField = (typeof AGENT_PROFILE_FIELDS)[number];

export interface ProfileDraft {
  /** What to write. Empty when the agent added nothing to what is already there. */
  fields: Partial<Record<AgentProfileField, string>>;
  /** Fields the agent produced that were left alone, and why. */
  skipped: Array<{ field: AgentProfileField; reason: 'already_set' | 'malformed' | 'empty' }>;
}

/** The existing row, as much of it as this module reads. */
export type ExistingProfile = Partial<Record<AgentProfileField, string | null>> | null;

const LIMITS: Record<AgentProfileField, number> = {
  business_description: 20_000,
  industry: 200,
  sic_code: 12,
  naics_code: 12,
};

function cleaned(value: unknown, field: AgentProfileField): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return sliceChars(trimmed, LIMITS[field]);
}

function wellFormed(field: AgentProfileField, value: string): boolean {
  if (field === 'sic_code') return isSicCode(value);
  if (field === 'naics_code') return isNaicsCode(value);
  return true;
}

/**
 * The fields to write from a stored `company_profile` agent result.
 *
 * **A value somebody typed is theirs.** By default the draft fills blanks only:
 * an analyst who classified this business as 7372 and then ran the agent did
 * not ask to have that reconsidered, and an apply that silently replaced it
 * would be the same failure the peer set avoids by carrying include/exclude
 * decisions across a re-screen. `overwrite` is the explicit opt-in, and the
 * skipped list is what tells the analyst there was something to opt into.
 *
 * **The codes are re-validated here, not trusted.** The agent drops a malformed
 * code before returning, but a stored job can predate that check — the same
 * reason `sanitizeExtractedInputs` re-checks extracted engine inputs on read
 * rather than at the moment they were produced.
 */
export function draftFromAgentResult(
  result: unknown,
  existing: ExistingProfile,
  options: { overwrite?: boolean } = {},
): ProfileDraft {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new AiCompanyProfileError('That company-profile run stored no result to apply');
  }
  const doc = result as Record<string, unknown>;
  const overwrite = options.overwrite === true;

  const fields: Partial<Record<AgentProfileField, string>> = {};
  const skipped: ProfileDraft['skipped'] = [];

  for (const field of AGENT_PROFILE_FIELDS) {
    const value = cleaned(doc[field], field);
    if (value === null) {
      // Absent rather than skipped-with-a-reason only when the agent never
      // produced it; an empty string it did produce is worth reporting, because
      // "the documents did not say" is a finding the analyst acts on.
      if (field in doc) skipped.push({ field, reason: 'empty' });
      continue;
    }
    if (!wellFormed(field, value)) {
      skipped.push({ field, reason: 'malformed' });
      continue;
    }
    const current = existing?.[field];
    if (!overwrite && typeof current === 'string' && current.trim() !== '') {
      skipped.push({ field, reason: 'already_set' });
      continue;
    }
    fields[field] = value;
  }

  if (Object.keys(fields).length === 0) {
    const allHeld = skipped.length > 0 && skipped.every((s) => s.reason === 'already_set');
    throw new AiCompanyProfileError(
      allHeld
        ? 'Every field this run produced is already set on the profile — pass overwrite to replace them'
        : 'That company-profile run produced no usable field to apply — re-run the agent',
    );
  }
  return { fields, skipped };
}
