import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  mergeSettings,
  publicSubset,
  PUBLIC_SETTING_KEYS,
  SYSTEM_SETTINGS_DEFAULTS,
  SYSTEM_SETTING_KEYS,
} from '../../src/domain/systemSettings.js';
import { SystemSettingsStore } from '../../src/repos/systemSettings.js';

/** A pool stand-in that only answers the two queries the store issues. */
function fakePool(rows: Array<{ key: string; value: unknown }>, onQuery = vi.fn()) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      onQuery(sql, params);
      return { rows, rowCount: rows.length };
    }),
  } as unknown as pg.Pool;
}

describe('mergeSettings', () => {
  it('returns the defaults for an empty table', () => {
    expect(mergeSettings([])).toEqual(SYSTEM_SETTINGS_DEFAULTS);
  });

  it('overlays stored values on the defaults', () => {
    const merged = mergeSettings([
      { key: 'maintenance_mode', value: true },
      { key: 'password_min_length', value: 20 },
    ]);
    expect(merged.maintenance_mode).toBe(true);
    expect(merged.password_min_length).toBe(20);
    expect(merged.registration_enabled).toBe(SYSTEM_SETTINGS_DEFAULTS.registration_enabled);
  });

  it('falls back to the default for a value the schema rejects', () => {
    // A hand-edited or downgraded row must not take the platform down.
    const merged = mergeSettings([
      { key: 'maintenance_mode', value: 'yes please' },
      { key: 'password_min_length', value: 2 },
      { key: 'support_email', value: null },
    ]);
    expect(merged.maintenance_mode).toBe(false);
    expect(merged.password_min_length).toBe(10);
    expect(merged.support_email).toBe(SYSTEM_SETTINGS_DEFAULTS.support_email);
  });

  it('ignores keys that are no longer part of the schema', () => {
    expect(mergeSettings([{ key: 'retired_flag', value: 1 }])).toEqual(SYSTEM_SETTINGS_DEFAULTS);
  });
});

describe('publicSubset', () => {
  it('exposes only the advertised public keys', () => {
    const pub = publicSubset({ ...SYSTEM_SETTINGS_DEFAULTS, password_min_length: 30 });
    expect(Object.keys(pub).sort()).toEqual([...PUBLIC_SETTING_KEYS].sort());
  });

  it('never leaks an operational setting', () => {
    const pub = publicSubset(SYSTEM_SETTINGS_DEFAULTS) as Record<string, unknown>;
    for (const key of ['password_min_length', 'default_delivery_days']) {
      expect(pub[key]).toBeUndefined();
    }
  });
});

describe('SYSTEM_SETTING_KEYS', () => {
  it('covers every key in the defaults', () => {
    expect([...SYSTEM_SETTING_KEYS].sort()).toEqual(Object.keys(SYSTEM_SETTINGS_DEFAULTS).sort());
  });
});

describe('SystemSettingsStore', () => {
  it('caches reads within the TTL and refreshes after it', async () => {
    const pool = fakePool([{ key: 'maintenance_mode', value: true }]);
    let now = 1_000;
    const store = new SystemSettingsStore(pool, 5_000, () => now);

    expect(await store.get('maintenance_mode')).toBe(true);
    await store.read();
    expect(pool.query).toHaveBeenCalledTimes(1);

    now += 4_999;
    await store.read();
    expect(pool.query).toHaveBeenCalledTimes(1);

    now += 2;
    await store.read();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache on write so the author sees their own change', async () => {
    const rows = [{ key: 'maintenance_mode', value: false }];
    const pool = fakePool(rows);
    let now = 0;
    const store = new SystemSettingsStore(pool, 60_000, () => now);

    expect(await store.get('maintenance_mode')).toBe(false);
    rows[0]!.value = true; // stands in for the row the write just persisted
    const after = await store.write({ maintenance_mode: true }, '01ABC');
    expect(after.maintenance_mode).toBe(true);
  });

  it('serves the defaults rather than throwing when the database is unreachable', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as pg.Pool;
    const store = new SystemSettingsStore(pool);
    // A failed settings read must never be the reason a request 500s.
    expect(await store.read()).toEqual(SYSTEM_SETTINGS_DEFAULTS);
  });

  it('serves the last known good values when a later read fails', async () => {
    let fail = false;
    const pool = {
      query: vi.fn(async () => {
        if (fail) throw new Error('connection refused');
        return { rows: [{ key: 'password_min_length', value: 24 }], rowCount: 1 };
      }),
    } as unknown as pg.Pool;
    let now = 0;
    const store = new SystemSettingsStore(pool, 1_000, () => now);

    expect(await store.get('password_min_length')).toBe(24);
    fail = true;
    now += 2_000;
    expect(await store.get('password_min_length')).toBe(24);
  });
});
