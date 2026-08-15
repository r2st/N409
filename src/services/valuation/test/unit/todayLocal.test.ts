import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '../../src/domain/calendarDate.js';
import { validateIntake } from '../../src/domain/intake.js';
import { specialtyEngineRequest } from '../../src/domain/specialty.js';

/**
 * "Today" is a question about where you are standing.
 *
 * Every assertion in this file is invisible on a UTC host — which is what CI
 * was, and why eleven call sites read the UTC day for months without anyone
 * noticing. `todayLocal` and `new Date().toISOString().slice(0, 10)` return the
 * same string whenever the process's offset is zero, so a test that does not
 * move the zone cannot tell the fix from the bug.
 *
 * Both directions matter and they fail differently, so both zones are exercised
 * rather than one standing in for the other:
 *
 *   * `Asia/Tokyo` (UTC+09:00, no DST) is ahead. For the first nine hours of
 *     the local day the UTC day is still *yesterday* — the browser case, where
 *     a client is told the date they just typed is in the future.
 *
 *   * `America/New_York` is behind, and is what the Hetzner host runs. From
 *     20:00 local the UTC day is already *tomorrow* — the server case, where a
 *     board resolution or a debt valuation is dated a day that has not happened.
 *
 * `process.env.TZ` is restored after each test: vitest reuses workers across
 * files, and a leaked zone would silently re-judge every date assertion in the
 * next one.
 */
const REAL_TZ = process.env.TZ;
afterEach(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

/** 22:00 UTC — after New York's rollover, and past midnight in Tokyo. */
const LATE_EVENING = new Date('2026-06-30T22:00:00.000Z');
/** 01:00 UTC — before Tokyo's rollover into the same day. */
const EARLY_MORNING = new Date('2026-07-01T01:00:00.000Z');

describe('the day the clock is actually on', () => {
  it('is tomorrow in UTC when a US evening has not ended (America/New_York)', () => {
    process.env.TZ = 'America/New_York';
    // The premise, asserted rather than assumed: if this stops holding, the
    // expectation below is passing for the wrong reason.
    expect(LATE_EVENING.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(todayLocal(LATE_EVENING)).toBe('2026-06-30');

    // 20:00 in New York on the 30th; the UTC day has already rolled over.
    const afterRollover = new Date('2026-07-01T02:00:00.000Z');
    expect(afterRollover.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(todayLocal(afterRollover)).toBe('2026-06-30');
  });

  it('is yesterday in UTC while an Asian morning is running (Asia/Tokyo)', () => {
    process.env.TZ = 'Asia/Tokyo';
    // 10:00 on 1 July in Tokyo; UTC still says 30 June.
    expect(EARLY_MORNING.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(todayLocal(EARLY_MORNING)).toBe('2026-07-01');

    expect(LATE_EVENING.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(todayLocal(LATE_EVENING)).toBe('2026-07-01');
  });

  it('agrees with the UTC day wherever the offset is zero', () => {
    // The reason this went unseen. Not a property worth relying on — a property
    // worth naming, so the next reader knows why CI was quiet.
    process.env.TZ = 'UTC';
    expect(todayLocal(LATE_EVENING)).toBe(LATE_EVENING.toISOString().slice(0, 10));
    expect(todayLocal(EARLY_MORNING)).toBe(EARLY_MORNING.toISOString().slice(0, 10));
  });

  it('defaults to now, which is what every call site passes', () => {
    process.env.TZ = 'Asia/Tokyo';
    const now = new Date();
    expect(todayLocal()).toBe(todayLocal(now));
  });
});

/**
 * The rule a client meets. `notFuture` compares the day they typed against
 * today, and reading today in UTC made "today" unenterable east of it.
 */
describe('a date the client can actually enter', () => {
  const incorporationDate = (value: string, today: Date) =>
    validateIntake({ incorporation_date: value }, { today });

  it('accepts today for a client whose morning is ahead of UTC', () => {
    process.env.TZ = 'Asia/Tokyo';
    // 10:00 on 1 July in Tokyo. The UTC day is 30 June, so the old comparison
    // read the client's own "today" as tomorrow and refused it — with no value
    // the field would take.
    expect(incorporationDate('2026-07-01', EARLY_MORNING)).toEqual([]);
  });

  it('still refuses a date that is genuinely in the future', () => {
    process.env.TZ = 'Asia/Tokyo';
    const issues = incorporationDate('2026-07-02', EARLY_MORNING);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'incorporation_date', severity: 'error' });
    expect(issues[0]?.message).toMatch(/future/i);
  });

  it('refuses tomorrow for a client whose evening is behind UTC', () => {
    process.env.TZ = 'America/New_York';
    // 22:00 UTC is 18:00 in New York on 30 June — the 1st is still tomorrow,
    // and stays refused. Two hours later the UTC day rolls over and the old
    // comparison would have accepted it.
    expect(incorporationDate('2026-07-01', LATE_EVENING)).toHaveLength(1);
    expect(incorporationDate('2026-07-01', new Date('2026-07-01T02:00:00.000Z'))).toHaveLength(1);
  });
});

/**
 * The server-side defaults. Each of these is a `date` column on something a
 * client receives, and each took the UTC day when the request did not name one.
 */
describe('a document is not dated into tomorrow', () => {
  const QSBS_ANSWERS = {
    entity_type: 'c_corp',
    industry: 'software',
    acquisition_date: '2020-01-15',
    gross_assets_before_issuance: 1_000_000,
    gross_assets_after_issuance: 4_000_000,
    active_business_asset_pct: 0.9,
    acquired_at_original_issue: true,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps a QSBS assessment with the day the server is on, not the UTC day', () => {
    process.env.TZ = 'America/New_York';
    // 22:15 on 30 June in New York. The clock the default reads says 1 July in
    // UTC, and the engine was being asked to assess a holding period against a
    // day that had not started. No `today` argument here — the default is the
    // thing under test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T02:15:00.000Z'));

    const request = specialtyEngineRequest('qsbs', QSBS_ANSWERS);
    const inputs = (request.body as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.assessment_date).toBe('2026-06-30');
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('stamps it with the local day east of UTC too', () => {
    process.env.TZ = 'Asia/Tokyo';
    // 10:15 on 1 July in Tokyo, where UTC is still on 30 June — the same
    // default, wrong in the other direction.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T01:15:00.000Z'));

    const request = specialtyEngineRequest('qsbs', QSBS_ANSWERS);
    const inputs = (request.body as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.assessment_date).toBe('2026-07-01');
  });
});
