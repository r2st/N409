import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/lib/stats';
import { stateGroup } from '../src/lib/format';
import type { Valuation, ValuationState } from '../src/lib/types';

const v = (state: ValuationState, waiting = false): Valuation => ({
  id: `id-${state}-${Math.random().toString(36).slice(2, 6)}`,
  kind: '409a',
  state,
  company_name: 'Acme',
  service_name: null,
  user_id: 'u1',
  partner_id: null,
  source: null,
  currency: 'USD',
  service_countries: null,
  waiting_on_client: waiting,
  assigned_reviewer_id: null,
  due_date: null,
  delivery_days: null,
  paid_status: 'unpaid',
  qsbs_attestation: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
});

describe('dashboard stats', () => {
  it('groups lifecycle states like the ops dashboard', () => {
    expect(stateGroup('pending')).toBe('open');
    expect(stateGroup('completed')).toBe('open');
    expect(stateGroup('review')).toBe('in_review');
    expect(stateGroup('draft_changes')).toBe('drafted');
    expect(stateGroup('published')).toBe('published');
    expect(stateGroup('cancelled')).toBe('closed');
  });

  it('computes quick stats from a scoped list', () => {
    const stats = computeStats([
      v('pending'),
      v('started', true),
      v('review'),
      v('drafted'),
      v('published'),
      v('published'),
      v('cancelled'),
    ]);
    expect(stats).toEqual({
      total: 7,
      open: 2,
      inReview: 1,
      drafted: 1,
      published: 2,
      waitingOnClient: 1,
    });
  });
});
