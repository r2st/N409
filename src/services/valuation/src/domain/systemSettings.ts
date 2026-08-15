import { z } from 'zod';
import { EmailAddress } from './email.js';

/**
 * Runtime-editable system settings — the handful of knobs an administrator
 * should be able to turn without a redeploy. Anything that needs a secret or a
 * restart (SMTP host, JWT TTL, service URLs) stays in the environment.
 *
 * Each setting is stored as its own `system_settings` row so two admins
 * editing different knobs never clobber each other. A missing or malformed row
 * falls back to the default below, which means the platform boots correctly on
 * a database that has never had a setting written to it.
 */
export const SYSTEM_SETTINGS_SCHEMA = z.object({
  /** Gates POST /auth/register. Invitations still work when this is off. */
  registration_enabled: z.boolean(),
  /**
   * Read-only mode: non-ops principals get 503 on every mutating request.
   * Ops keep full access so they can finish whatever the mode was declared for.
   */
  maintenance_mode: z.boolean(),
  /**
   * Floor for every password the platform accepts. 10 is the hard minimum
   * enforced by the route schemas, so this can only tighten the rule.
   */
  password_min_length: z.number().int().min(10).max(128),
  /** Surfaced publicly; shown to signed-out visitors on the contact page. */
  support_email: EmailAddress,
  /** Pre-filled turnaround on a new valuation when ops don't set one. */
  default_delivery_days: z.number().int().min(1).max(365),
  /**
   * When on, every password account must enrol in TOTP 2FA: an un-enrolled
   * user is allowed to sign in but is required to set it up before proceeding.
   */
  require_mfa: z.boolean(),
});

export type SystemSettings = z.infer<typeof SYSTEM_SETTINGS_SCHEMA>;
export type SystemSettingKey = keyof SystemSettings;

export const SYSTEM_SETTINGS_DEFAULTS: SystemSettings = {
  registration_enabled: true,
  maintenance_mode: false,
  password_min_length: 10,
  support_email: 'support@409.ai',
  default_delivery_days: 10,
  require_mfa: false,
};

export const SYSTEM_SETTING_KEYS = Object.keys(SYSTEM_SETTINGS_DEFAULTS) as [
  SystemSettingKey,
  ...SystemSettingKey[],
];

/** The subset anonymous visitors may read — never anything operational. */
export const PUBLIC_SETTING_KEYS = [
  'registration_enabled',
  'maintenance_mode',
  'support_email',
] as const satisfies readonly SystemSettingKey[];

export type PublicSystemSettings = Pick<SystemSettings, (typeof PUBLIC_SETTING_KEYS)[number]>;

export function publicSubset(settings: SystemSettings): PublicSystemSettings {
  return {
    registration_enabled: settings.registration_enabled,
    maintenance_mode: settings.maintenance_mode,
    support_email: settings.support_email,
  };
}

/**
 * Merges stored rows over the defaults, dropping any value the schema rejects.
 * A bad row is a bug, not a reason to take the platform down, so it degrades to
 * the default rather than throwing.
 */
export function mergeSettings(rows: ReadonlyArray<{ key: string; value: unknown }>): SystemSettings {
  const merged: Record<string, unknown> = { ...SYSTEM_SETTINGS_DEFAULTS };
  const shape = SYSTEM_SETTINGS_SCHEMA.shape as Record<string, z.ZodTypeAny>;
  for (const row of rows) {
    const field = shape[row.key];
    if (!field) continue;
    const parsed = field.safeParse(row.value);
    if (parsed.success) merged[row.key] = parsed.data;
  }
  return merged as SystemSettings;
}
