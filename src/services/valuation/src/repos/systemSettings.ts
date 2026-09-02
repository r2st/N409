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
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  // One statement, not one per key. The round trips were the smaller problem:
  // a per-key loop also meant a save that failed halfway left the console
  // showing some of the operator's changes applied and the rest not, with no
  // indication of which. A single multi-row upsert is atomic without needing a
  // transaction around it.
  const values = entries.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3}::jsonb, $1)`).join(', ');
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_by)
     VALUES ${values}
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [updatedBy, ...entries.flatMap(([key, value]) => [key, JSON.stringify(value)])],
  );
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
  #failedToCache = 0;
  #failedToDefaults = 0;
  #servingDefaults = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
    /** Where a failed read is reported. Optional so the tests can omit it. */
    private readonly log?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  /**
   * A failed read must never be the reason a request fails, so this degrades
   * rather than throws. What it degrades *to* matters, and the two cases are
   * not the same:
   *
   *  - **Warm cache.** Serving the last values actually read is right: they
   *    came from the table and are at most a TTL stale.
   *
   *  - **Cold cache.** There is nothing to serve but `SYSTEM_SETTINGS_DEFAULTS`,
   *    and every one of the three operational flags defaults to its permissive
   *    value — `registration_enabled: true`, `maintenance_mode: false`,
   *    `require_mfa: false`. So a replica that has never completed a read
   *    answers "registration is open", "the platform is not in maintenance"
   *    and "2FA is not mandatory" to an operator who set all three the other
   *    way. That is a fail-open, and it used to be an entirely silent one: no
   *    log, and `#readAt` was stamped as though the read had succeeded, so the
   *    permissive answer was then served from cache for a full TTL without
   *    another attempt.
   *
   * The cold-cache fallback stays — taking the platform down over the settings
   * table is worse — but it no longer pretends to be a read. The clock is not
   * stamped, so the next caller retries immediately instead of inheriting the
   * defaults, and both cases are logged so a fail-open window is visible in the
   * logs rather than inferred later from its consequences.
   */
  async read(): Promise<SystemSettings> {
    if (this.#cached && this.now() - this.#readAt < this.ttlMs) return this.#cached;
    try {
      this.#cached = await readSettings(this.pool);
      this.#readAt = this.now();
      this.#servingDefaults = false;
      return this.#cached;
    } catch (err) {
      if (this.#cached) {
        this.#failedToCache += 1;
        this.log?.warn({ err }, 'system settings read failed; serving the last values read');
        this.#readAt = this.now();
        return this.#cached;
      }
      this.#failedToDefaults += 1;
      this.#servingDefaults = true;
      this.log?.warn(
        { err },
        'system settings read failed with nothing cached; serving defaults, which are permissive ' +
          '(registration open, no maintenance mode, 2FA not mandatory) — retrying on the next read',
      );
      return { ...SYSTEM_SETTINGS_DEFAULTS };
    }
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

  /**
   * The fail-open above, as numbers a scrape can read.
   *
   * `read()` already says both cases out loud, and for a dozen rounds that was
   * treated as the record. It is not the *alerting* record: nothing on this box
   * consumes the journal (`infra/journald` is retention and rate-limit config
   * only), and `infra/monitoring/alerts.yml` is the one written answer to "how
   * would we know?". So the cold-cache branch — a replica answering
   * "registration is open", "not in maintenance" and "2FA is not mandatory" to
   * an operator who set all three the other way — could be running right now
   * and reach nobody, which is the same silence the branch was written to end.
   *
   * `servingDefaults` is a *current* state and is cleared by the next
   * successful read, so it is only meaningful while something is asking:
   * `maintenance_mode` is consulted on every authenticated mutating request, so
   * on a serving replica that is continuously. On an idle one it is the last
   * answer given, which is the honest reading — a flag nobody has asked for is
   * not being answered wrongly.
   *
   * The two failure tallies are cumulative for the reason
   * `background_sweep_failures_total` is: a count with no denominator cannot
   * separate "twice since boot" from "every read for an hour".
   */
  diagnostics(): { failedToCache: number; failedToDefaults: number; servingDefaults: boolean } {
    return {
      failedToCache: this.#failedToCache,
      failedToDefaults: this.#failedToDefaults,
      servingDefaults: this.#servingDefaults,
    };
  }
}
