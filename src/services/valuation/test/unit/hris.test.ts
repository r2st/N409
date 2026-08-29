import { describe, it, expect } from 'vitest';
import { isIsoCalendarDate } from '@n409/shared';
import { mapEmployees } from '../../src/clients/hris.js';
import { isStorableEmail } from '../../src/domain/email.js';

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

/**
 * The payload shapes a provider can actually send (round 201, M6).
 *
 * `mapEmployees` is handed `readJson`'s output, which is guaranteed to be an
 * object and nothing else. Everything under it — whether `employees` is a
 * list, whether its elements are records, whether `equityGrants` is an array —
 * was read as though the provider's schema were a promise.
 */
const NUL = String.fromCharCode(0);
const employee = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  fullName: 'Ada Lovelace',
  workEmail: 'ada@acme.com',
  ...over,
});
const withGrant = (grant: Record<string, unknown>, emp: Record<string, unknown> = {}) =>
  mapEmployees({ employees: [employee({ ...emp, equityGrants: [grant] })] });
const GOOD_GRANT = { id: 'g1', optionsGranted: 100, strikePrice: 1, grantDate: '2025-03-01' };

describe('the mapper is total over what a provider can send', () => {
  /**
   * Every one of these threw before, and the throw did not stop at the mapper:
   * it left `fetchRosterAndGrants` and reached `syncHrisConnection`'s fetch
   * catch, which writes `describeTransportFailure(err)` to
   * `hris_connections.last_error` — a column `toPublic` returns verbatim. So
   * the analyst was shown "Cannot read properties of null (reading
   * 'fullName')", attributed to the network, under a connection that then
   * reads as a transport problem.
   */
  it.each([
    ['a payload with no employees key at all', {}],
    ['employees as an object', { employees: { e1: {} } }],
    ['employees as a number', { employees: 5 }],
    ['employees as a string', { employees: 'nobody' }],
    ['a null element', { employees: [null] }],
    ['a string element', { employees: ['Ada'] }],
    ['a nested array element', { employees: [[]] }],
    ['equityGrants as an object', { employees: [employee({ equityGrants: { g1: {} } })] }],
    ['a null grant', { employees: [employee({ equityGrants: [null] })] }],
    ['a string grant', { employees: [employee({ equityGrants: ['g1'] })] }],
    ['a null payload', null],
  ])('walks %s without throwing', (_label, payload) => {
    const result = mapEmployees(payload);
    expect(Array.isArray(result.roster)).toBe(true);
    expect(Array.isArray(result.grants)).toBe(true);
    expect(result.grants).toEqual([]);
  });

  it('keeps the employees it can read when one element it cannot sits between them', () => {
    // A `null` in the middle used to take the whole roster down with it,
    // including the records after it that were perfectly fine.
    const { roster } = mapEmployees({
      employees: [employee({ id: 'e1' }), null, employee({ id: 'e2', fullName: 'Alan Turing' })],
    });
    expect(roster.map((r) => r.external_id)).toEqual(['e1', 'e2']);
  });
});

describe('the import is held to the bounds POST /grants enforces', () => {
  it.each([
    ['an options count past int4', { optionsGranted: 3_000_000_000 }],
    ['an options count that rounds past int4', { optionsGranted: 2_147_483_647.6 }],
    ['an options count of 1e300', { optionsGranted: 1e300 }],
    ['a negative strike price', { strikePrice: -0.01 }],
    ['a strike price past 1e9', { strikePrice: 1e12 }],
    ['an external id past the unique index', { id: 'g'.repeat(4000) }],
    ['an external id that is an object', { id: { nested: true } }],
    ['an external id that is only whitespace', { id: '   ' }],
    ['a NUL byte in the external id', { id: `g${NUL}1` }],
    ['a grant date in year zero', { grantDate: '0000-03-01' }],
  ])('drops a grant with %s and counts it', (_label, patch) => {
    const { grants, rejected } = withGrant({ ...GOOD_GRANT, ...patch });
    expect(grants).toEqual([]);
    expect(rejected).toBe(1);
  });

  it.each([
    ['a NUL byte', `Ada${NUL}Lovelace`],
    ['4 KB of it', 'A'.repeat(4000)],
  ])('drops a grant whose grantee name carries %s', (_label, fullName) => {
    // `grantee_name` is NOT NULL, so an unstorable one has nothing to fall
    // back to — unlike the email below.
    const { grants, rejected } = withGrant(GOOD_GRANT, { fullName, firstName: null, lastName: null });
    expect(grants).toEqual([]);
    expect(rejected).toBe(1);
  });

  it('still imports a grant for an employee the provider named nothing', () => {
    // 'Unknown' is the mapper's long-standing fallback for a record with no
    // name at all, and it is storable — so this is not the case above.
    const { grants, rejected } = withGrant(GOOD_GRANT, {
      fullName: '   ',
      firstName: null,
      lastName: null,
    });
    expect(rejected).toBe(0);
    expect(grants[0]).toMatchObject({ grantee_name: 'Unknown' });
  });

  it.each([
    ['not an address at all', 'n/a'],
    ['4 KB long', `${'a'.repeat(4000)}@acme.com`],
    ['a NUL byte', `ada${NUL}@acme.com`],
    ['not a string', 12345],
  ])('imports the grant with no email when the provider sends one that is %s', (_label, workEmail) => {
    // Nulled rather than refused: the column is nullable, the manual route
    // accepts a grant without one, and an address that is not an address
    // identifies nobody — so the grant is still worth having.
    const { grants, roster, rejected } = withGrant(GOOD_GRANT, { workEmail, email: undefined });
    expect(rejected).toBe(0);
    expect(grants[0]).toMatchObject({ grantee_email: null, external_id: 'g1' });
    expect(roster[0]!.email).toBeNull();
  });

  it('keeps a grant that sits exactly on each bound', () => {
    const { grants, rejected } = withGrant({
      id: 'g'.repeat(255),
      optionsGranted: 2_147_483_647,
      strikePrice: 1e9,
      grantDate: '2025-03-01',
    });
    expect(rejected).toBe(0);
    expect(grants[0]).toMatchObject({ options_count: 2_147_483_647, exercise_price: 1e9 });
  });

  it('imports the good grants either side of one it will not take', () => {
    const { grants, rejected } = mapEmployees({
      employees: [
        employee({
          equityGrants: [
            { ...GOOD_GRANT, id: 'before' },
            { ...GOOD_GRANT, id: 'bad', strikePrice: -1 },
            { ...GOOD_GRANT, id: 'after' },
          ],
        }),
      ],
    });
    expect(grants.map((g) => g.external_id)).toEqual(['before', 'after']);
    expect(rejected).toBe(1);
  });

  it('trims the padding a provider sends rather than storing it', () => {
    const { grants } = withGrant({ ...GOOD_GRANT, id: '  g1  ' });
    expect(grants[0]!.external_id).toBe('g1');
  });
});

/**
 * The census: whatever a provider sends, what comes out is storable.
 *
 * The bounded cases above each name a field. This one makes the claim the
 * import actually depends on — *`mapEmployees` is total, and everything it
 * returns fits the columns it is headed for* — and checks it against payloads
 * nobody wrote by hand.
 *
 * It exists because the failure mode is asymmetric. A grant this platform
 * refuses is one grant; a grant Postgres refuses ends the whole import at
 * whatever row it reached, leaves the rest of the roster unattempted, and
 * fails the same way on every scheduled retry. So a field added to `MappedGrant`
 * tomorrow with no bound on it should fail here rather than in the driver.
 *
 * Deterministic rather than random: a seeded generator means a failure is
 * reproducible from the seed printed with it, and a census that cannot be
 * re-run on the payload that broke it is a flake.
 */
describe('mapEmployees is total, and returns only what the columns take', () => {
  /** xorshift32 — small, seeded, and good enough to shuffle shapes with. */
  function generator(seed: number) {
    let x = seed || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 0x1_0000_0000;
    };
  }

  const INT4_MAX = 2_147_483_647;

  /**
   * What a mapped grant must be true of, stated as columns rather than as
   * preferences. Each line is `option_grants`' own declaration, or the index
   * over it, or the one character Postgres stores no text with.
   */
  function assertStorable(grants: ReturnType<typeof mapEmployees>['grants'], at: string): void {
    for (const g of grants) {
      const where = `${at}, grant ${JSON.stringify(g.external_id).slice(0, 40)}`;
      expect(
        g.external_id.length,
        `${where}: external_id fits option_grants_external_idx`,
      ).toBeLessThanOrEqual(255);
      expect(g.grantee_name.length, `${where}: grantee_name is NOT NULL`).toBeGreaterThan(0);
      expect(g.grantee_name.length, `${where}: grantee_name`).toBeLessThanOrEqual(200);
      expect(Number.isSafeInteger(g.options_count), `${where}: options_count is an integer`).toBe(true);
      expect(g.options_count, `${where}: options_count CHECK (> 0)`).toBeGreaterThan(0);
      expect(g.options_count, `${where}: options_count fits int4`).toBeLessThanOrEqual(INT4_MAX);
      expect(Number.isFinite(g.exercise_price), `${where}: exercise_price is a number`).toBe(true);
      expect(g.exercise_price, `${where}: exercise_price CHECK (>= 0)`).toBeGreaterThanOrEqual(0);
      expect(g.exercise_price, `${where}: exercise_price <= 1e9`).toBeLessThanOrEqual(1e9);
      expect(Number.isSafeInteger(g.vesting_months), `${where}: vesting_months`).toBe(true);
      expect(Number.isSafeInteger(g.cliff_months), `${where}: cliff_months`).toBe(true);
      expect(g.frequency_months, `${where}: frequency_months CHECK (>= 1)`).toBeGreaterThanOrEqual(1);
      for (const [field, value] of Object.entries(g)) {
        if (typeof value === 'string') {
          expect(value.includes(NUL), `${where}: ${field} carries a NUL byte`).toBe(false);
        }
      }
      for (const [field, value] of [
        ['grant_date', g.grant_date],
        ['vesting_start_date', g.vesting_start_date],
      ] as const) {
        expect(isIsoCalendarDate(value), `${where}: ${field} is ${value}`).toBe(true);
      }
      if (g.grantee_email !== null) {
        expect(isStorableEmail(g.grantee_email), `${where}: grantee_email ${g.grantee_email}`).toBe(true);
      }
    }
  }

  /**
   * One field of an otherwise-clean record, replaced with a value a provider
   * really can send.
   *
   * A purely random bag almost never produces a grant that survives the
   * options/date/id gates *and* carries a bad value in some fourth field, so on
   * its own it exercises the mapper's totality and not its bounds. Perturbing
   * exactly one field of a valid record puts a value on each boundary in turn,
   * which is what makes a field added tomorrow with no bound on it fail here.
   */
  const ATTACKS: Record<string, unknown[]> = {
    id: [{ nested: true }, 'g'.repeat(4000), `g${NUL}1`, '   ', 12345, [], null, undefined],
    optionsGranted: [3_000_000_000, 1e300, -1, 0, 2_147_483_647.6, '3000000000', '1e300', Number.NaN],
    strikePrice: [-1, -0.01, 1e12, 1e300, '$-5', Number.NaN, Number.POSITIVE_INFINITY, '-1'],
    grantDate: ['0000-01-01', '2026-02-31', '2026-13-01', 'nope', 12345, null, '2025-03-01T09:30:00Z'],
    vesting: [{ months: -5 }, { months: 1e9 }, { cliffMonths: 1e300 }, 'nope', { startDate: '0000-01-01' }],
    fullName: [`Ada${NUL}Lovelace`, 'A'.repeat(4000), 12345, null, '   '],
    workEmail: ['n/a', `${'a'.repeat(4000)}@acme.com`, `ada${NUL}@acme.com`, 12345, ''],
  };
  const ATTACK_FIELDS = Object.keys(ATTACKS);

  it('emits nothing the driver would refuse, whichever single field is wrong', () => {
    let emitted = 0;
    for (const field of ATTACK_FIELDS) {
      for (const [i, value] of ATTACKS[field]!.entries()) {
        const employee: Record<string, unknown> = {
          id: 'e1',
          fullName: 'Ada Lovelace',
          workEmail: 'ada@acme.com',
          equityGrants: [
            {
              id: 'g1',
              optionsGranted: 100,
              strikePrice: 1,
              grantDate: '2025-03-01',
              vesting: { months: 48, cliffMonths: 12, startDate: '2025-03-01' },
            },
          ],
        };
        if (field === 'fullName' || field === 'workEmail') employee[field] = value;
        else (employee.equityGrants as Array<Record<string, unknown>>)[0]![field] = value;
        const at = `${field}[${i}] = ${JSON.stringify(value)?.slice(0, 40)}`;
        let result;
        try {
          result = mapEmployees({ employees: [employee] });
        } catch (err) {
          throw new Error(`${at}: mapEmployees threw ${String(err)}`);
        }
        // Either the grant is refused, or it is storable. Never neither.
        expect(result.grants.length + result.rejected, at).toBe(1);
        assertStorable(result.grants, at);
        emitted += result.grants.length;
      }
    }
    // A guard on the guard: if every perturbation started being refused, the
    // assertions above would hold vacuously.
    expect(emitted).toBeGreaterThan(5);
  });

  it('never throws on a payload shape nobody wrote by hand', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = generator(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const scalar = (): unknown =>
        pick([
          null,
          undefined,
          0,
          -1,
          1e300,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          3_000_000_000,
          '',
          '   ',
          'ok',
          `nul${NUL}byte`,
          'x'.repeat(4000),
          '2025-03-01',
          '2026-02-31',
          '0000-01-01',
          '$1,250.00',
          true,
          {},
          [],
          { nested: { deep: true } },
          [1, 2, 3],
        ]);
      const bag = (keys: string[]): Record<string, unknown> =>
        Object.fromEntries(keys.filter(() => rnd() < 0.7).map((k) => [k, scalar()]));

      const payload = pick([
        scalar(),
        {
          companyName: scalar(),
          employees: pick([
            scalar(),
            Array.from({ length: Math.floor(rnd() * 4) }, () =>
              pick([
                scalar(),
                {
                  ...bag(['id', 'employeeId', 'fullName', 'name', 'firstName', 'lastName']),
                  ...bag(['workEmail', 'email', 'title', 'jobTitle', 'status', 'employmentStatus']),
                  equityGrants: pick([
                    scalar(),
                    Array.from({ length: Math.floor(rnd() * 4) }, () =>
                      pick([
                        scalar(),
                        {
                          ...bag(['id', 'grantId', 'optionsGranted', 'shares', 'quantity']),
                          ...bag(['grantDate', 'issueDate', 'date', 'strikePrice', 'exercisePrice']),
                          vesting: pick([
                            scalar(),
                            bag(['months', 'cliffMonths', 'cliff', 'frequencyMonths', 'startDate']),
                          ]),
                        },
                      ]),
                    ),
                  ]),
                },
              ]),
            ),
          ]),
        },
      ]);

      let result;
      try {
        result = mapEmployees(payload);
      } catch (err) {
        throw new Error(`seed ${seed}: mapEmployees threw ${String(err)}`);
      }
      assertStorable(result.grants, `seed ${seed}`);
    }
  });
});
