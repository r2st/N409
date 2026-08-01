import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REASONS,
  classifyAttention,
  countByReason,
  DUE_SOON_DAYS,
  rankAttention,
  STALE_REVIEW_DAYS,
  STALE_WAITING_DAYS,
  type FirmValuationRow,
} from '../../src/domain/firmDashboard.js';

/**
 * Firm triage rules. `now` is injected, so the boundaries are tested as
 * boundaries rather than "whatever today happens to be".
 */

const NOW = new Date('2026-07-31T12:00:00.000Z');
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

let seq = 0;
const row = (over: Partial<FirmValuationRow> = {}): FirmValuationRow => ({
  id: `01J0VAL${String((seq += 1)).padStart(19, '0')}`,
  number: seq,
  company_name: 'Northwind Robotics',
  state: 'review',
  due_date: daysFromNow(30),
  waiting_on_client: false,
  assigned_reviewer_id: '01J0USER0000000000000000AA',
  assigned_reviewer_name: 'Ada Lovelace',
  created_at: daysFromNow(-60),
  last_comment_at: daysFromNow(-1),
  ...over,
});

describe('classifyAttention — finished work', () => {
  it('never flags a published or closed engagement, however stale', () => {
    for (const state of ['published', 'cancelled', 'timeout', 'ignored'] as const) {
      const stale = row({
        state,
        due_date: daysFromNow(-90),
        waiting_on_client: true,
        assigned_reviewer_id: null,
        last_comment_at: daysFromNow(-200),
      });
      expect(classifyAttention(stale, NOW)).toBeNull();
    }
  });

  it('returns null for a healthy live engagement', () => {
    expect(classifyAttention(row(), NOW)).toBeNull();
  });
});

describe('classifyAttention — overdue', () => {
  it('flags a past due date as high severity with whole days late', () => {
    const item = classifyAttention(row({ due_date: daysFromNow(-3) }), NOW);
    expect(item).toMatchObject({ reason: 'overdue', severity: 'high', days: 3 });
    expect(item!.detail).toBe('3 days past due');
  });

  it('reads a same-day lapse as due today rather than "0 days past due"', () => {
    const item = classifyAttention(row({ due_date: daysFromNow(-0.5) }), NOW);
    expect(item).toMatchObject({ reason: 'overdue', days: 0 });
    expect(item!.detail).toBe('Due date passed today');
  });

  it('singularises one day', () => {
    expect(classifyAttention(row({ due_date: daysFromNow(-1) }), NOW)!.detail).toBe('1 day past due');
  });

  it('outranks every other reason on the same engagement', () => {
    // Late, unassigned, and stalled with the client all at once: a firm chases
    // the deadline first.
    const item = classifyAttention(
      row({
        due_date: daysFromNow(-5),
        assigned_reviewer_id: null,
        waiting_on_client: true,
        last_comment_at: daysFromNow(-60),
      }),
      NOW,
    );
    expect(item!.reason).toBe('overdue');
  });
});

describe('classifyAttention — unassigned', () => {
  it('flags review and drafting work with no reviewer', () => {
    for (const state of ['review', 'reviewed', 'drafted', 'draft_changes'] as const) {
      const item = classifyAttention(row({ state, assigned_reviewer_id: null }), NOW);
      expect(item).toMatchObject({ reason: 'unassigned', severity: 'high' });
    }
  });

  it('does not flag work that has not reached review yet', () => {
    // Nobody expects a reviewer on an engagement the client is still filling in.
    for (const state of ['pending', 'started', 'user_finished'] as const) {
      expect(classifyAttention(row({ state, assigned_reviewer_id: null }), NOW)).toBeNull();
    }
  });
});

describe('classifyAttention — stalled', () => {
  it('leaves a recent client wait alone and flags it at the threshold', () => {
    const waiting = (idleDays: number) =>
      classifyAttention(
        row({ waiting_on_client: true, state: 'started', last_comment_at: daysFromNow(-idleDays) }),
        NOW,
      );
    expect(waiting(STALE_WAITING_DAYS - 1)).toBeNull();
    expect(waiting(STALE_WAITING_DAYS)).toMatchObject({
      reason: 'stalled_with_client',
      severity: 'medium',
      days: STALE_WAITING_DAYS,
    });
  });

  it('falls back to creation when nothing has ever been said', () => {
    const item = classifyAttention(
      row({
        waiting_on_client: true,
        state: 'started',
        last_comment_at: null,
        created_at: daysFromNow(-40),
      }),
      NOW,
    );
    expect(item).toMatchObject({ reason: 'stalled_with_client', days: 40 });
  });

  it('flags a review nobody has touched', () => {
    const item = classifyAttention(
      row({ state: 'review', last_comment_at: daysFromNow(-STALE_REVIEW_DAYS) }),
      NOW,
    );
    expect(item).toMatchObject({ reason: 'stalled_in_review', severity: 'medium' });
  });

  it('does not call a drafted engagement stalled — that rule is for review', () => {
    expect(classifyAttention(row({ state: 'drafted', last_comment_at: daysFromNow(-60) }), NOW)).toBeNull();
  });
});

describe('classifyAttention — due soon', () => {
  it('flags a deadline inside the window and ignores one outside it', () => {
    expect(classifyAttention(row({ due_date: daysFromNow(DUE_SOON_DAYS + 1.5) }), NOW)).toBeNull();
    const item = classifyAttention(row({ due_date: daysFromNow(3) }), NOW);
    expect(item).toMatchObject({ reason: 'due_soon', severity: 'medium', days: 3 });
    expect(item!.detail).toBe('Due in 3 days');
  });

  it('says "Due today" for a deadline later the same day', () => {
    expect(classifyAttention(row({ due_date: daysFromNow(0.25) }), NOW)!.detail).toBe('Due today');
  });
});

describe('rankAttention', () => {
  it('puts high severity first, then most-overdue, and breaks ties by number', () => {
    const items = rankAttention(
      [
        row({ number: 3, due_date: daysFromNow(2) }),
        row({ number: 1, due_date: daysFromNow(-2) }),
        row({ number: 2, due_date: daysFromNow(-9) }),
        row({ number: 4, state: 'review', assigned_reviewer_id: null, due_date: null }),
      ],
      NOW,
    );
    expect(items.map((i) => [i.number, i.reason])).toEqual([
      [2, 'overdue'],
      [1, 'overdue'],
      [4, 'unassigned'],
      [3, 'due_soon'],
    ]);
  });

  it('sorts due_soon the other way — the nearest deadline is the urgent one', () => {
    const items = rankAttention(
      [row({ number: 1, due_date: daysFromNow(6) }), row({ number: 2, due_date: daysFromNow(1) })],
      NOW,
    );
    expect(items.map((i) => i.number)).toEqual([2, 1]);
  });

  it('drops healthy engagements and honours the limit', () => {
    const rows = [row(), row({ due_date: daysFromNow(-1) }), row({ due_date: daysFromNow(-2) })];
    expect(rankAttention(rows, NOW)).toHaveLength(2);
    expect(rankAttention(rows, NOW, 1)).toHaveLength(1);
  });

  it('is stable on an empty book', () => {
    expect(rankAttention([], NOW)).toEqual([]);
  });
});

describe('countByReason', () => {
  it('reports a zero for every reason, so the UI has no missing keys', () => {
    const counts = countByReason([]);
    expect(Object.keys(counts).sort()).toEqual([...ATTENTION_REASONS].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('counts each reason once per engagement', () => {
    const counts = countByReason(
      rankAttention(
        [
          row({ due_date: daysFromNow(-1) }),
          row({ due_date: daysFromNow(-2) }),
          row({ state: 'drafted', assigned_reviewer_id: null, due_date: null }),
        ],
        NOW,
      ),
    );
    expect(counts.overdue).toBe(2);
    expect(counts.unassigned).toBe(1);
    expect(counts.due_soon).toBe(0);
  });
});
