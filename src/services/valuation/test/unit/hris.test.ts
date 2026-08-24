import { describe, it, expect } from 'vitest';
import { mapEmployees } from '../../src/clients/hris.js';

describe('HRIS roster + grant mapping (feature 11)', () => {
  it('flattens employees into a roster and their equity grants', () => {
    const { roster, grants } = mapEmployees({
      companyName: 'Acme',
      employees: [
        {
          id: 'e1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          workEmail: 'ada@acme.com',
          jobTitle: 'Engineer',
          equityGrants: [
            {
              id: 'g1',
              optionsGranted: 10000,
              strikePrice: 1.25,
              grantDate: '2025-03-01',
              vesting: { startDate: '2025-03-01', months: 48, cliffMonths: 12, frequencyMonths: 1 },
            },
          ],
        },
        { id: 'e2', fullName: 'No Grants', email: 'ng@acme.com' },
      ],
    });

    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@acme.com', title: 'Engineer' });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      external_id: 'g1',
      grantee_name: 'Ada Lovelace',
      grantee_email: 'ada@acme.com',
      grant_date: '2025-03-01',
      options_count: 10000,
      exercise_price: 1.25,
      vesting_months: 48,
      cliff_months: 12,
      frequency_months: 1,
    });
  });

  it('applies default vesting terms when the provider omits them', () => {
    const { grants } = mapEmployees({
      people: [{ id: 'p1', name: 'Bob', grants: [{ grantId: 'gx', shares: 500, issueDate: '2026-01-15' }] }],
    });
    expect(grants[0]).toMatchObject({
      external_id: 'gx',
      options_count: 500,
      exercise_price: 0,
      vesting_start_date: '2026-01-15',
      vesting_months: 48,
      cliff_months: 12,
      frequency_months: 1,
    });
  });

  it('drops grants missing an id, date, or a positive option count', () => {
    const { grants } = mapEmployees({
      employees: [
        {
          id: 'e',
          name: 'X',
          equityGrants: [
            { optionsGranted: 100, grantDate: '2025-01-01' }, // no id → dropped
            { id: 'g', optionsGranted: 0, grantDate: '2025-01-01' }, // zero → dropped
            { id: 'g2', optionsGranted: 100 }, // no date → dropped
          ],
        },
      ],
    });
    expect(grants).toHaveLength(0);
  });
});

describe('HRIS grant mapping bounds the vesting schedule', () => {
  const grantWith = (vesting: unknown) =>
    mapEmployees({
      employees: [
        {
          id: 'e1',
          fullName: 'Ada Lovelace',
          equityGrants: [{ id: 'g1', optionsGranted: 1000, grantDate: '2025-03-01', vesting }],
        },
      ],
    }).grants[0]!;

  it('caps a schedule the grant routes would refuse', () => {
    // Written straight onto the row before this; `GET /grants/:id` then builds
    // one timeline point per cadence step over the term.
    expect(grantWith({ months: 2_000_000, cliffMonths: 999, frequencyMonths: 400 })).toMatchObject({
      vesting_months: 240,
      cliff_months: 120,
      frequency_months: 12,
    });
  });

  it('refuses a negative cadence the way the routes do', () => {
    expect(grantWith({ months: 48, cliffMonths: -12, frequencyMonths: -3 })).toMatchObject({
      vesting_months: 48,
      cliff_months: 0,
      frequency_months: 1,
    });
  });

  it('pulls a cliff past the end of the vest back to the vest', () => {
    expect(grantWith({ months: 24, cliffMonths: 36 })).toMatchObject({
      vesting_months: 24,
      cliff_months: 24,
    });
  });

  it('leaves an ordinary provider schedule untouched', () => {
    expect(grantWith({ months: 48, cliffMonths: 12, frequencyMonths: 3 })).toMatchObject({
      vesting_months: 48,
      cliff_months: 12,
      frequency_months: 3,
    });
  });

  it('still fills an absent schedule with the 48/12/1 defaults', () => {
    expect(grantWith(undefined)).toMatchObject({
      vesting_months: 48,
      cliff_months: 12,
      frequency_months: 1,
    });
  });
});

/**
 * `grant_date` and `vesting_start_date` are `date NOT NULL`. A day that does
 * not exist is therefore not a wrong value that gets stored — it is a driver
 * error raised inside `syncHrisConnection`'s uncaught insert loop, which ends
 * the sync with earlier grants committed, later ones never attempted, and
 * neither `recordSync` nor `recordSyncError` reached. The connection stays due
 * and fails the same way on every sweep.
 */
describe('HRIS grant mapping holds provider dates to a real calendar', () => {
  const grantWithDate = (grantDate: unknown, extra: Record<string, unknown> = {}) =>
    mapEmployees({
      employees: [
        {
          id: 'e1',
          fullName: 'Ada Lovelace',
          equityGrants: [{ id: 'g1', optionsGranted: 1000, grantDate, ...extra }],
        },
      ],
    }).grants;

  it('drops a grant dated to a day that does not exist', () => {
    // The shape check these passed admits all of these; the calendar does not.
    for (const day of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-02-29']) {
      expect(grantWithDate(day), day).toHaveLength(0);
    }
  });

  it('keeps a leap day in a year that has one', () => {
    expect(grantWithDate('2024-02-29')[0]).toMatchObject({ grant_date: '2024-02-29' });
  });

  it('still accepts a timestamp and takes the day off it', () => {
    expect(grantWithDate('2025-03-01T09:30:00Z')[0]).toMatchObject({ grant_date: '2025-03-01' });
  });

  it('falls back to the grant date when the vesting start is not a real day', () => {
    // `vesting_start_date` is the second `date NOT NULL` column on the row, so
    // it needed the same rule; the existing fallback covers the rest.
    expect(
      grantWithDate('2025-03-01', { vesting: { startDate: '2025-02-30', months: 48 } })[0],
    ).toMatchObject({ grant_date: '2025-03-01', vesting_start_date: '2025-03-01' });
  });

  it('leaves an ordinary vesting start alone', () => {
    expect(grantWithDate('2025-03-01', { vesting: { startDate: '2025-04-01' } })[0]).toMatchObject({
      vesting_start_date: '2025-04-01',
    });
  });
});
