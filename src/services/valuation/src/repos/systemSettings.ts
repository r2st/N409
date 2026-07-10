import type pg from 'pg';
import {
  mergeSettings,
  SYSTEM_SETTINGS_DEFAULTS,
  type SystemSettingKey,
  type SystemSettings,
} from '../domain/systemSettings.js';

export interface SystemSettingRow {
  key: string;
  value: unknown;
  updated_at: Date;
  updated_by: string | null;
}

export async function readSettings(pool: pg.Pool): Promise<SystemSettings> {
  const { rows } = await pool.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM system_settings',
  );
  return mergeSettings(rows);
}

/** Rows for the admin console — includes who last touched each key. */
export async function readSettingRows(pool: pg.Pool): Promise<SystemSettingRow[]> {
  const { rows } = await pool.query<SystemSettingRow>(
    'SELECT key, value, updated_at, updated_by FROM system_settings',
  );
  return rows;
}

export async function writeSettings(
  pool: pg.Pool,
  patch: Partial<SystemSettings>,
  updatedBy: string,
): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), updatedBy],
    );
  }
}

/**
 * Settings are read on the hot path — `maintenance_mode` is consulted on every
 * authenticated mutating request — so they're cached for a beat rather than
 * queried per request. A write invalidates immediately, so an admin toggling a
 * flag sees it take effect on their next request; other service replicas pick
 * it up within the TTL.
 */
export class SystemSettingsStore {
  #cached: SystemSettings | null = null;
  #readAt = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<SystemSettings> {
    if (this.#cached && this.now() - this.#readAt < this.ttlMs) return this.#cached;
    try {
      this.#cached = await readSettings(this.pool);
    } catch {
      // A settings read must never be the reason a request fails. Serve the
      // last known good values, or the defaults on a cold cache.
      this.#cached ??= { ...SYSTEM_SETTINGS_DEFAULTS };
    }
    this.#readAt = this.now();
    return this.#cached;
  }

  async get<K extends SystemSettingKey>(key: K): Promise<SystemSettings[K]> {
    return (await this.read())[key];
  }

  async write(patch: Partial<SystemSettings>, updatedBy: string): Promise<SystemSettings> {
    await writeSettings(this.pool, patch, updatedBy);
    this.invalidate();
    return this.read();
  }

  invalidate(): void {
    this.#cached = null;
    this.#readAt = 0;
  }
}
