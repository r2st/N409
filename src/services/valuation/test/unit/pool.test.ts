import { describe, expect, it } from 'vitest';
import { buildPoolConfig, resolvePoolTuning } from '../../src/db/pool.js';

const URL = 'postgres://n409:pw@db.internal:5432/n409';

describe('resolvePoolTuning', () => {
  it('applies bounded default timeouts', () => {
    const t = resolvePoolTuning(URL, {});
    expect(t.statementTimeoutMs).toBe(15_000);
    expect(t.idleInTransactionTimeoutMs).toBe(15_000);
    expect(t.connectionTimeoutMs).toBe(10_000);
    expect(t.max).toBe(10);
  });

  it('reads overrides from env', () => {
    const t = resolvePoolTuning(URL, {
      DB_STATEMENT_TIMEOUT_MS: '5000',
      DB_CONNECTION_TIMEOUT_MS: '2000',
      DB_POOL_MAX: '25',
    });
    expect(t.statementTimeoutMs).toBe(5000);
    expect(t.connectionTimeoutMs).toBe(2000);
    expect(t.max).toBe(25);
  });

  it('falls back on non-numeric / negative env values', () => {
    const t = resolvePoolTuning(URL, { DB_STATEMENT_TIMEOUT_MS: 'nope', DB_POOL_MAX: '-3' });
    expect(t.statementTimeoutMs).toBe(15_000);
    expect(t.max).toBe(10);
  });

  it('requires TLS in production by default', () => {
    expect(resolvePoolTuning(URL, { NODE_ENV: 'production' }).ssl).toBe(true);
  });

  it('does not force TLS outside production', () => {
    expect(resolvePoolTuning(URL, { NODE_ENV: 'test' }).ssl).toBe(false);
    expect(resolvePoolTuning(URL, {}).ssl).toBe(false);
  });

  it('infers TLS from an sslmode in the connection string', () => {
    expect(resolvePoolTuning('postgres://h/db?sslmode=require', {}).ssl).toBe(true);
    expect(resolvePoolTuning('postgres://h/db?sslmode=disable', {}).ssl).toBe(false);
  });

  it('lets DB_SSL override everything', () => {
    expect(resolvePoolTuning(URL, { NODE_ENV: 'production', DB_SSL: 'disable' }).ssl).toBe(false);
    expect(resolvePoolTuning(URL, { DB_SSL: 'no-verify' }).ssl).toBe('no-verify');
    expect(resolvePoolTuning(URL, { DB_SSL: 'require' }).ssl).toBe(true);
  });
});

describe('buildPoolConfig', () => {
  it('maps tuning onto pg.PoolConfig with timeouts', () => {
    const cfg = buildPoolConfig(URL, resolvePoolTuning(URL, { NODE_ENV: 'production' }));
    expect(cfg.connectionString).toBe(URL);
    expect(cfg.statement_timeout).toBe(15_000);
    expect(cfg.idle_in_transaction_session_timeout).toBe(15_000);
    expect(cfg.connectionTimeoutMillis).toBe(10_000);
    expect(cfg.max).toBe(10);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('omits ssl when disabled and honours no-verify', () => {
    expect(buildPoolConfig(URL, resolvePoolTuning(URL, { DB_SSL: 'disable' })).ssl).toBeUndefined();
    expect(buildPoolConfig(URL, resolvePoolTuning(URL, { DB_SSL: 'no-verify' })).ssl).toEqual({
      rejectUnauthorized: false,
    });
  });
});
