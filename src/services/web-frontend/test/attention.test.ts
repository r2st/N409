import { describe, expect, it } from 'vitest';
import { attentionItems, classifyAttention, DUE_SOON_DAYS } from '../src/lib/attention';
import type { Valuation, ValuationState } from '../src/lib/types';

/**
 * The dashboard's "what needs a human today" ranking.
 *
 * Every case pins `now` explicitly. The rules are entirely about calendar
 * boundaries — due today vs. one day late — so a suite that read the real clock
 * would pass or fail depending on the day it ran.
 */

let seq = 0;
const v = (over: Partial<Valuation> = {}): Valuation =>
  ({
    id: `01N409VAL${String(seq++).padStart(17, '0')}`,
    kind: '409a',
    state: 'started' as ValuationState,
    company_name: 'Acme',
    service_name: null,
    user_id: 'u1',
    partner_id: null,
    source: null,
    currency: 'USD',
    service_countries: null,
    waiting_on_client: false,
    assigned_reviewer_id: null,
    due_date: null,
    delivery_days: null,
    paid_status: 'unpaid',
    qsbs_attestation: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...over,
  }) as Valuation;

/** Local midnight, matching how the module reads a `YYYY-MM-DD` due date. */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const NOW = at(2026, 8, 1);

describe('classifyAttention', () => {
  it('never flags closed work', () => {
    for (const state of ['cancelled', 'ignored', 'timeout'] as ValuationState[]) {
      expect(classifyAttention(v({ state, due_date: '2020-01-01' }), NOW)).toBeNull();
    }
  });

  it('flags published work only when something new has happened on it', () => {
    // A delivered report is not "late" however old its due date is…
    expect(classifyAttention(v({ state: 'published', due_date: '2020-01-01' }), NOW)).toBeNull();
    // …but an unread message on it still wants a reply.
    const unread = classifyAttention(v({ state: 'published', unread: true }), NOW);
    expect(unread).toMatchObject({ reason: 'new_activity', severity: 'medium', days: 0 });
  });

  it('counts overdue days from local midnight, so today is not yet late', () => {
    expect(classifyAttention(v({ due_date: '2026-08-01' }), NOW)).toMatchObject({
      reason: 'due_soon',
      days: 0,
      detail: 'Due today',
    });
    expect(classifyAttention(v({ due_date: '2026-07-31' }), NOW)).toMatchObject({
      reason: 'overdue',
      severity: 'high',
      days: 1,
      detail: '1 day past due',
    });
    expect(classifyAttention(v({ due_date: '2026-07-29' }), NOW)).toMatchObject({
      days: 3,
      detail: '3 days past due',
    });
  });

  it('treats the due-soon window as inclusive and ignores anything beyond it', () => {
    const edge = classifyAttention(v({ due_date: '2026-08-08' }), NOW);
    expect(edge).toMatchObject({ reason: 'due_soon', days: DUE_SOON_DAYS, detail: 'Due in 7 days' });
    expect(classifyAttention(v({ due_date: '2026-08-09' }), NOW)).toBeNull();
  });

  it('flags work held up pending information, with no due date needed', () => {
    expect(classifyAttention(v({ waiting_on_client: true }), NOW)).toMatchObject({
      reason: 'action_needed',
      severity: 'high',
      detail: 'Held up pending information',
    });
  });

  it('ranks a single reason per valuation, worst first', () => {
    // Late *and* waiting on the client: late is the fact that gets acted on.
    expect(
      classifyAttention(v({ due_date: '2026-07-01', waiting_on_client: true, unread: true }), NOW),
    ).toMatchObject({ reason: 'overdue' });
    // Waiting outranks merely approaching.
    expect(classifyAttention(v({ due_date: '2026-08-03', waiting_on_client: true }), NOW)).toMatchObject({
      reason: 'action_needed',
    });
    // Approaching outranks a valuation that has simply moved.
    expect(classifyAttention(v({ due_date: '2026-08-03', unread: true }), NOW)).toMatchObject({
      reason: 'due_soon',
    });
  });

  it('returns nothing for open work that is on track and unchanged', () => {
    expect(classifyAttention(v(), NOW)).toBeNull();
  });
});

describe('attentionItems', () => {
  it('sorts by reason, then by how long each has run, then by name', () => {
    const items = attentionItems(
      [
        v({ company_name: 'Unread Co', unread: true }),
        v({ company_name: 'Soon Later', due_date: '2026-08-05' }),
        v({ company_name: 'Late A little', due_date: '2026-07-30' }),
        v({ company_name: 'Waiting Co', waiting_on_client: true }),
        v({ company_name: 'Late A lot', due_date: '2026-07-01' }),
        v({ company_name: 'Soon Sooner', due_date: '2026-08-02' }),
      ],
      NOW,
    );

    expect(items.map((i) => i.company_name)).toEqual([
      // Overdue first, and within overdue the one that has run longest.
      'Late A lot',
      'Late A little',
      'Waiting Co',
      // Within due_soon the *soonest* leads — the opposite ordering, on purpose.
      'Soon Sooner',
      'Soon Later',
      'Unread Co',
    ]);
  });

  it('breaks ties inside a reason by company name, so the order is stable', () => {
    const items = attentionItems(
      [
        v({ company_name: 'Zeta', waiting_on_client: true }),
        v({ company_name: 'Alpha', waiting_on_client: true }),
        v({ company_name: 'Mid', waiting_on_client: true }),
      ],
      NOW,
    );
    expect(items.map((i) => i.company_name)).toEqual(['Alpha', 'Mid', 'Zeta']);
  });

  it('drops everything that does not need attention', () => {
    expect(attentionItems([v(), v({ state: 'cancelled' }), v({ state: 'published' })], NOW)).toEqual([]);
    expect(attentionItems([], NOW)).toEqual([]);
  });
});
