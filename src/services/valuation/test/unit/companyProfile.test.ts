import { describe, expect, it } from 'vitest';
import {
  AiCompanyProfileError,
  draftFromAgentResult,
  isNaicsCode,
  isSicCode,
  narrativeProfilePayload,
} from '../../src/domain/companyProfile.js';

/**
 * The company profile's typed fields and the AI draft that fills them
 * (migrations 0151/0152).
 *
 * Two rules carry the feature. A value somebody typed is theirs — an apply that
 * silently replaced a hand-classified SIC is one an analyst would learn not to
 * run. And a malformed code is refused rather than stored, because the
 * comparable screen ranks the universe on the SIC and a malformed one matches
 * no row, presenting as "no comparable companies found" rather than as bad
 * input.
 */

const RESULT = {
  business_description: 'Sells a subscription analytics platform to mid-market retailers.',
  industry: 'Retail analytics software',
  sic_code: '7372',
  naics_code: '511210',
  key_metrics: [{ key: 'revenue', value: '$4.2M ARR' }],
  gaps: ['No customer count in the documents.'],
};

describe('classification codes', () => {
  it('accepts a SIC of two to four digits and nothing else', () => {
    expect(isSicCode('73')).toBe(true);
    expect(isSicCode('7372')).toBe(true);
    expect(isSicCode('7')).toBe(false);
    expect(isSicCode('73721')).toBe(false);
    expect(isSicCode('SIC 7372')).toBe(false);
    expect(isSicCode('73.7')).toBe(false);
  });

  it('accepts a NAICS of two to six digits and nothing else', () => {
    expect(isNaicsCode('51')).toBe(true);
    expect(isNaicsCode('511210')).toBe(true);
    expect(isNaicsCode('5112101')).toBe(false);
    expect(isNaicsCode('abc')).toBe(false);
  });

  it('tolerates surrounding whitespace, which is how a pasted code arrives', () => {
    expect(isSicCode(' 7372 ')).toBe(true);
  });
});

describe('draftFromAgentResult', () => {
  it('fills every field on an empty profile', () => {
    const { fields, skipped } = draftFromAgentResult(RESULT, null);
    expect(fields).toEqual({
      business_description: RESULT.business_description,
      industry: 'Retail analytics software',
      sic_code: '7372',
      naics_code: '511210',
    });
    expect(skipped).toEqual([]);
  });

  it('leaves a field somebody already typed alone, and says it did', () => {
    const { fields, skipped } = draftFromAgentResult(RESULT, { sic_code: '3559' });
    expect(fields.sic_code).toBeUndefined();
    expect(fields.industry).toBe('Retail analytics software');
    expect(skipped).toContainEqual({ field: 'sic_code', reason: 'already_set' });
  });

  it('treats a blank stored value as unset — it is not a judgement anybody made', () => {
    const { fields } = draftFromAgentResult(RESULT, { sic_code: '   ', industry: null });
    expect(fields.sic_code).toBe('7372');
    expect(fields.industry).toBe('Retail analytics software');
  });

  it('replaces a set field only when overwrite is asked for explicitly', () => {
    const { fields, skipped } = draftFromAgentResult(RESULT, { sic_code: '3559' }, { overwrite: true });
    expect(fields.sic_code).toBe('7372');
    expect(skipped).toEqual([]);
  });

  it('refuses a malformed code even though the agent should have dropped it', () => {
    // A stored job can predate the agent's own validation, so the check is
    // applied on read rather than trusted — as sanitizeExtractedInputs does.
    const { fields, skipped } = draftFromAgentResult({ ...RESULT, sic_code: '73721' }, null);
    expect(fields.sic_code).toBeUndefined();
    expect(skipped).toContainEqual({ field: 'sic_code', reason: 'malformed' });
    expect(fields.naics_code).toBe('511210');
  });

  it('reports a field the run produced empty rather than dropping it silently', () => {
    const { fields, skipped } = draftFromAgentResult({ ...RESULT, industry: '   ' }, null);
    expect(fields.industry).toBeUndefined();
    expect(skipped).toContainEqual({ field: 'industry', reason: 'empty' });
  });

  it('ignores a field the run never produced', () => {
    const { skipped } = draftFromAgentResult({ industry: 'Software' }, null);
    expect(skipped).toEqual([]);
  });

  it('truncates an over-long description rather than refusing the whole draft', () => {
    const long = 'x'.repeat(25_000);
    const { fields } = draftFromAgentResult({ business_description: long }, null);
    expect(fields.business_description).toHaveLength(20_000);
  });

  it('refuses a job that stored no result object', () => {
    expect(() => draftFromAgentResult(null, null)).toThrow(AiCompanyProfileError);
    expect(() => draftFromAgentResult(['a'], null)).toThrow(AiCompanyProfileError);
  });

  it('refuses a run with nothing usable in it', () => {
    expect(() => draftFromAgentResult({ key_metrics: [] }, null)).toThrow(/no usable field/i);
  });

  it('names overwrite when every field it produced is already held', () => {
    expect(() =>
      draftFromAgentResult(RESULT, {
        business_description: 'Typed by the analyst.',
        industry: 'Software',
        sic_code: '7372',
        naics_code: '511210',
      }),
    ).toThrow(/pass overwrite to replace them/i);
  });
});

describe('narrativeProfilePayload', () => {
  it('ships what the company section needs and nothing identifying', () => {
    const payload = narrativeProfilePayload({
      business_description: 'Analytics for retailers.',
      industry: 'Retail analytics',
      sic_code: '7372',
      naics_code: '511210',
      revenue_range: '1m_10m',
      employee_count: 31,
      founded_on: '2019-04-01',
      // Present on the row and deliberately not forwarded — the narrative agent
      // has no section that wants a street address or a legal name.
      legal_name: 'Acme Robotics, Inc.',
      address_line1: '1 Industrial Way',
      city: 'Palo Alto',
    } as Record<string, unknown>);

    expect(payload).toEqual({
      business_description: 'Analytics for retailers.',
      industry: 'Retail analytics',
      sic_code: '7372',
      naics_code: '511210',
      revenue_range: '1m_10m',
      employee_count: 31,
      founded_on: '2019-04-01',
    });
  });

  it('is null when there is no profile at all', () => {
    expect(narrativeProfilePayload(null)).toBeNull();
  });

  it('is null when the profile holds none of the fields the section needs', () => {
    expect(
      narrativeProfilePayload({ legal_name: 'Acme', city: 'Palo Alto' } as Record<string, unknown>),
    ).toBeNull();
  });

  it('drops empty strings so the block is not a heading with nothing under it', () => {
    expect(narrativeProfilePayload({ industry: '  ', sic_code: '7372' })).toEqual({ sic_code: '7372' });
  });

  it('keeps a zero employee count — it is a figure, not a missing value', () => {
    expect(narrativeProfilePayload({ employee_count: 0 })).toEqual({ employee_count: 0 });
  });
});
