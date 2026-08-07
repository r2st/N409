import { describe, expect, it } from 'vitest';
import {
  filterIntakeAnswers,
  intakeCompanyName,
  intakeParamsPatch,
  INTAKE_LINK_STATUSES,
  intakeLinkStatus,
  isIntakeLinkOpen,
  summarizeIntakeLink,
  type IntakeLinkState,
} from '../../src/domain/clientIntake.js';

/**
 * A link carries five nullable timestamps that routinely disagree — submitted
 * and since expired, revoked but already opened. The precedence between them is
 * the product decision, so it is pinned here at each boundary rather than left
 * to whichever caller renders the badge.
 */

const NOW = new Date('2026-08-01T12:00:00Z');
const future = new Date('2026-09-01T00:00:00Z');
const past = new Date('2026-07-01T00:00:00Z');

function link(overrides: Partial<IntakeLinkState> = {}): IntakeLinkState {
  return {
    revoked_at: null,
    expires_at: future,
    submitted_at: null,
    valuation_id: null,
    last_accessed_at: null,
    ...overrides,
  };
}

describe('intakeLinkStatus', () => {
  it('is "sent" for a live link the client has not opened', () => {
    expect(intakeLinkStatus(link(), NOW)).toBe('sent');
  });

  it('becomes "in_progress" once the client has opened it', () => {
    expect(intakeLinkStatus(link({ last_accessed_at: past }), NOW)).toBe('in_progress');
  });

  it('reports "expired" strictly after the expiry instant', () => {
    // The boundary: expiring exactly now is expired, a second later is not.
    expect(intakeLinkStatus(link({ expires_at: NOW }), NOW)).toBe('expired');
    expect(intakeLinkStatus(link({ expires_at: new Date(NOW.getTime() + 1000) }), NOW)).toBe('sent');
  });

  it('prefers revoked over expired — a decision outranks a date', () => {
    expect(intakeLinkStatus(link({ revoked_at: past, expires_at: past }), NOW)).toBe('revoked');
  });

  it('keeps a submitted link "submitted" after it lapses or is withdrawn', () => {
    // The firm has the answers; calling this "expired" reads as though the
    // client's work were lost.
    expect(intakeLinkStatus(link({ submitted_at: past, expires_at: past }), NOW)).toBe('submitted');
    expect(intakeLinkStatus(link({ submitted_at: past, revoked_at: past }), NOW)).toBe('submitted');
  });

  it('reports "converted" once an engagement exists, over everything else', () => {
    expect(
      intakeLinkStatus(
        link({ valuation_id: '01N409VAL00000000000000AA', submitted_at: past, revoked_at: past }),
        NOW,
      ),
    ).toBe('converted');
  });

  it('accepts ISO strings as well as Dates, since JSON round-trips lose the type', () => {
    expect(intakeLinkStatus(link({ expires_at: past.toISOString() }), NOW)).toBe('expired');
    expect(intakeLinkStatus(link({ submitted_at: past.toISOString() }), NOW)).toBe('submitted');
  });

  it('only ever returns a declared status', () => {
    const states = [
      link(),
      link({ last_accessed_at: past }),
      link({ expires_at: past }),
      link({ revoked_at: past }),
      link({ submitted_at: past }),
      link({ valuation_id: 'v' }),
    ];
    for (const s of states) {
      expect(INTAKE_LINK_STATUSES).toContain(intakeLinkStatus(s, NOW));
    }
  });
});

describe('isIntakeLinkOpen', () => {
  it('is true only while the client can still answer', () => {
    expect(isIntakeLinkOpen(link(), NOW)).toBe(true);
    expect(isIntakeLinkOpen(link({ last_accessed_at: past }), NOW)).toBe(true);
  });

  it('is false once the link is submitted, revoked, expired or converted', () => {
    expect(isIntakeLinkOpen(link({ submitted_at: past }), NOW)).toBe(false);
    expect(isIntakeLinkOpen(link({ revoked_at: past }), NOW)).toBe(false);
    expect(isIntakeLinkOpen(link({ expires_at: past }), NOW)).toBe(false);
    expect(isIntakeLinkOpen(link({ valuation_id: 'v' }), NOW)).toBe(false);
  });
});

describe('filterIntakeAnswers', () => {
  it('keeps the fields the questionnaire defines', () => {
    const kept = filterIntakeAnswers({ legal_name: 'Acme, Inc.', employee_count: 42 });
    expect(kept).toEqual({ legal_name: 'Acme, Inc.', employee_count: 42 });
  });

  it('drops anything the questionnaire does not define', () => {
    // The endpoint is anonymous and writes straight to jsonb — without this an
    // intake link is free storage for whoever holds it.
    const kept = filterIntakeAnswers({
      legal_name: 'Acme, Inc.',
      // Computed so these are own properties — `__proto__:` in a literal sets
      // the prototype instead, which would make the assertion vacuous.
      ['__proto__']: 'x',
      ['constructor']: 'y',
      arbitrary_blob: 'z'.repeat(100),
      ['; DROP TABLE']: true,
    });
    expect(kept).toEqual({ legal_name: 'Acme, Inc.' });
    expect(Object.keys(kept)).toEqual(['legal_name']);
  });

  it('preserves falsy answers, which are real answers', () => {
    const kept = filterIntakeAnswers({ employee_count: 0, pending_litigation: false });
    expect(kept).toEqual({ employee_count: 0, pending_litigation: false });
  });

  it('returns an empty object rather than throwing on an empty payload', () => {
    expect(filterIntakeAnswers({})).toEqual({});
  });
});

describe('summarizeIntakeLink', () => {
  it('pairs the status with questionnaire completion', () => {
    const summary = summarizeIntakeLink({ ...link(), answers: { legal_name: 'Acme, Inc.' } }, NOW);
    expect(summary.status).toBe('sent');
    expect(summary.completion.requiredAnswered).toBe(1);
    expect(summary.completion.ready).toBe(false);
  });

  it('treats a link with no answers as zero percent, not as complete', () => {
    const summary = summarizeIntakeLink({ ...link(), answers: {} }, NOW);
    expect(summary.completion.percentComplete).toBe(0);
    expect(summary.completion.ready).toBe(false);
  });
});

/**
 * Conversion turns a submitted questionnaire into the engagement it was
 * collected for. What is mapped and what is deliberately not mapped is a
 * judgement, so it is pinned here rather than left to the route.
 */
describe('intakeCompanyName', () => {
  it('prefers the legal name the client typed', () => {
    expect(intakeCompanyName({ legal_name: '  Northwind Robotics, Inc. ' }, 'Northwind')).toBe(
      'Northwind Robotics, Inc.',
    );
  });

  it('falls back to the name the link was addressed to', () => {
    // A firm may convert a partial intake to get moving. A missing legal name
    // must not be an error about a field the client never filled in.
    expect(intakeCompanyName({}, 'Halcyon Bio')).toBe('Halcyon Bio');
    expect(intakeCompanyName({ legal_name: '   ' }, 'Halcyon Bio')).toBe('Halcyon Bio');
  });

  it('always produces a name, because a valuation must have one', () => {
    expect(intakeCompanyName({}, null)).toBe('Unnamed company');
    expect(intakeCompanyName({ legal_name: '' }, '  ')).toBe('Unnamed company');
  });

  it('keeps the name inside the column it is written to', () => {
    expect(intakeCompanyName({ legal_name: 'x'.repeat(400) }, null)).toHaveLength(300);
  });
});

describe('intakeParamsPatch', () => {
  it('maps the answers that have a typed column waiting for them', () => {
    expect(
      intakeParamsPatch({
        business_description: '  Autonomous warehouse robots. ',
        revenue_status: 'post_revenue',
        incorporation_date: '2021-03-04',
        last_round_date: '2024-05-01',
        last_fy_revenue: 1_234.56,
        ytd_revenue: 900,
      }),
    ).toEqual({
      business_overview: 'Autonomous warehouse robots.',
      revenue_status: 'post_revenue',
      inception_date: '2021-03-04',
      last_round_date: '2024-05-01',
      last_year_revenue_cents: 123_456,
      ytd_revenue_cents: 90_000,
    });
  });

  it('omits a key rather than nulling it', () => {
    // `patchParams` diffs what it is given: an absent key leaves the analyst's
    // own entry standing, an explicit null overwrites it.
    expect(intakeParamsPatch({})).toEqual({});
    expect(intakeParamsPatch({ business_description: '   ', last_fy_revenue: null })).toEqual({});
  });

  it('refuses a revenue stage that is not one of the two', () => {
    expect(intakeParamsPatch({ revenue_status: 'maybe' })).toEqual({});
    expect(intakeParamsPatch({ revenue_status: 7 })).toEqual({});
  });

  it('refuses a date that is not a real calendar day', () => {
    expect(intakeParamsPatch({ incorporation_date: '2023-02-30' })).toEqual({});
    expect(intakeParamsPatch({ incorporation_date: '04/03/2021' })).toEqual({});
  });

  it('refuses money that cannot be cents', () => {
    expect(intakeParamsPatch({ last_fy_revenue: -1 })).toEqual({});
    expect(intakeParamsPatch({ last_fy_revenue: Number.POSITIVE_INFINITY })).toEqual({});
    // Above MAX_SAFE_INTEGER the figure has already stopped being the one the
    // client typed, so it is not carried across as though it were.
    expect(intakeParamsPatch({ last_fy_revenue: 1e17 })).toEqual({});
  });

  it('rounds to whole cents rather than truncating', () => {
    expect(intakeParamsPatch({ ytd_revenue: 0.005 })).toEqual({ ytd_revenue_cents: 1 });
    expect(intakeParamsPatch({ ytd_revenue: 0 })).toEqual({ ytd_revenue_cents: 0 });
  });

  it('seeds nothing that is the analyst’s judgement', () => {
    const patch = intakeParamsPatch({
      business_description: 'Robots.',
      total_shares_outstanding: 10_000_000,
      option_pool_size: 1_000_000,
    });
    for (const key of ['weight_opm', 'weight_asset', 'dlom', 'dloc', 'allocation_method', 'runway_months']) {
      expect(patch).not.toHaveProperty(key);
    }
  });
});
