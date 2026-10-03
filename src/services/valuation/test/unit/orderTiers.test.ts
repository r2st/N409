import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '../../migrations/0209_starter_growth_enterprise_tiers.sql');

describe('self-serve pricing tiers (migration 0209)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('seeds starter at $299 one-time', () => {
    expect(sql).toContain("'starter'");
    expect(sql).toContain('29900');
    expect(sql).toContain("'one_time'");
  });

  it('seeds growth at $199/month with 3 valuations', () => {
    expect(sql).toContain("'growth'");
    expect(sql).toContain('19900');
    // growth interval is month
    expect(sql).toMatch(/'growth'.*'month'/s);
  });

  it('seeds enterprise_monthly at $499/month unlimited', () => {
    expect(sql).toContain("'enterprise_monthly'");
    expect(sql).toContain('49900');
    expect(sql).toMatch(/'enterprise_monthly'.*NULL/s);
  });

  it('creates the orders table', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS orders');
    expect(sql).toContain('user_id');
    expect(sql).toContain('plan_tier');
    expect(sql).toContain('company_name');
    expect(sql).toContain('amount_cents');
    expect(sql).toContain('stripe_checkout_id');
  });

  it('uses upsert so re-running is safe', () => {
    expect(sql).toContain('ON CONFLICT (tier) DO UPDATE');
  });
});
