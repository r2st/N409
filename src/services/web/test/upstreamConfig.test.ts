import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

/**
 * The three upstream addresses this service is entirely made of, and what a
 * mistyped one used to do.
 *
 * The BFF is not much more than a static file server and a proxy: `/api/*` goes
 * to `VALUATION_URL`, and `/ready` probes that plus `AI_URL` and `ENGINE_URL`.
 * All three were read straight out of the environment with a string default, so
 * the only validation was whatever the consumer happened to do with them —
 * which for the proxy was an unhandled `TypeError: Invalid URL` thrown from
 * inside `@fastify/reply-from` during plugin registration, and for the two
 * probes was a readiness failure that reads exactly like the upstream being
 * down.
 *
 * The valuation service has parsed its own `AI_URL`/`ENGINE_URL` through
 * `z.string().url()` since M1. This is that rule, on the copies.
 */

const SAVED = {
  VALUATION_URL: process.env.VALUATION_URL,
  AI_URL: process.env.AI_URL,
  ENGINE_URL: process.env.ENGINE_URL,
};

afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('upstream URL configuration', () => {
  it('builds with the loopback defaults when nothing is set', () => {
    for (const name of Object.keys(SAVED)) delete process.env[name];
    const app = buildApp({ staticRoot: '/nonexistent' });
    expect(app).toBeTruthy();
    return app.close();
  });

  it.each([
    ['VALUATION_URL', '127.0.0.1:3001'],
    ['AI_URL', '127.0.0.1:3002'],
    ['ENGINE_URL', '127.0.0.1:3003'],
  ])('refuses a scheme-less %s and names the variable', (variable, value) => {
    // The obvious way to write it, and the way the systemd unit's own comments
    // describe these addresses. Previously: a stack trace naming
    // `reply-from/lib/request.js` and nothing else.
    process.env[variable] = value;
    expect(() => buildApp({ staticRoot: '/nonexistent' })).toThrow(
      new RegExp(`${variable} is not a URL — got "${value}"`),
    );
  });

  it('refuses an empty VALUATION_URL rather than proxying to nowhere', () => {
    // A bare `VALUATION_URL=` in the EnvironmentFile. `??` only falls back on
    // `undefined`, so the empty string was passed through as the upstream.
    process.env.VALUATION_URL = '';
    expect(() => buildApp({ staticRoot: '/nonexistent' })).toThrow(/VALUATION_URL is not a URL/);
  });

  it('refuses a non-HTTP scheme', () => {
    // `new URL` is perfectly happy with these; `@fastify/reply-from` is not, and
    // a `file:` upstream on the public origin is worth refusing by name.
    process.env.VALUATION_URL = 'file:///etc/passwd';
    expect(() => buildApp({ staticRoot: '/nonexistent' })).toThrow(
      /VALUATION_URL must be http or https/,
    );
  });

  it('accepts https and a path prefix', () => {
    process.env.VALUATION_URL = 'https://valuation.internal:8443';
    process.env.AI_URL = 'http://ai.internal/base';
    const app = buildApp({ staticRoot: '/nonexistent' });
    expect(app).toBeTruthy();
    return app.close();
  });

  it('validates an explicitly injected URL too, not just the environment', () => {
    // Tests and the readiness harness pass these directly. A guard that only
    // covers `process.env` is one the next caller walks around.
    expect(() => buildApp({ staticRoot: '/nonexistent', valuationUrl: 'nope' })).toThrow(
      /VALUATION_URL is not a URL/,
    );
  });
});
