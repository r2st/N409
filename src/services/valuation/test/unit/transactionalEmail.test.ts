import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { sendTransactionalEmail, sendTransactionalEmailInBackground } from '../../src/email/transactional.js';

/**
 * `sendTransactionalEmail` promises that "delivery errors never propagate to the
 * caller", and for the transport it kept that promise. Everything around the
 * transport is a plain query, though — the outbox insert in front of the send,
 * and the 'failed' stamp inside the catch — and those reject on a pool timeout,
 * a dropped connection, a value too long for its column.
 *
 * Awaited by a route, a rejection there is a 500: not pleasant, but honest. Not
 * awaited it is an unhandled rejection, and this service installs a handler for
 * those that logs and exits so systemd restarts it. `POST /auth/forgot-password`
 * is unauthenticated and deliberately does not await — the response must not
 * take longer for an address that exists — so the crash was reachable by anyone,
 * at whatever moment the database was least happy.
 */

const template = {
  toUserId: 'usr_1',
  toEmail: 'founder@acme.test',
  templateKey: 'password_reset',
  subject: 'Reset your password',
  body: 'Follow the link.',
};

const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });

/** A pool whose every query rejects — a database that has stopped answering. */
function deadPool(): pg.Pool {
  return {
    query: () => Promise.reject(new Error('connection terminated unexpectedly')),
  } as unknown as pg.Pool;
}

/** A pool that answers the template lookup and the insert, and nothing else. */
function livePool(): pg.Pool {
  return {
    query: async (sql: string) => {
      if (/INSERT INTO email_outbox/i.test(sql)) return { rows: [{ id: 'eml_1', ...template }] };
      return { rows: [] };
    },
  } as unknown as pg.Pool;
}

/** Fails only on the UPDATE that stamps an outbox row — the marking query. */
function markFailsPool(): pg.Pool {
  return {
    query: async (sql: string) => {
      if (/INSERT INTO email_outbox/i.test(sql)) return { rows: [{ id: 'eml_1', ...template }] };
      if (/UPDATE email_outbox/i.test(sql)) throw new Error('connection terminated unexpectedly');
      return { rows: [] };
    },
  } as unknown as pg.Pool;
}

/**
 * A pool serving an enabled ops-authored override of the built-in copy, and
 * capturing the row that ends up in the outbox.
 */
function overridePool(override: { subject: string; body: string }) {
  const queued: Array<Record<string, unknown>> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (/FROM communication_templates WHERE key/i.test(sql))
        return { rows: [{ key: template.templateKey, enabled: true, ...override }] };
      if (/INSERT INTO email_outbox/i.test(sql)) {
        queued.push({ sql, params });
        return { rows: [{ id: 'eml_1', ...template }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, queued };
}

/** What the override rendered into, read back off the INSERT's parameters. */
const rendered = (queued: Array<Record<string, unknown>>) =>
  ((queued[0]!.params ?? []) as unknown[]).filter((p): p is string => typeof p === 'string').join(' | ');

/**
 * The `always` scope on a transactional send.
 *
 * `recipient_name`, `platform_name` and `support_email` are declared on every
 * template, and the editor's preview fills all three from the catalog's
 * samples. Not one of the eleven call sites that reach this function supplied
 * them, and `renderTemplate` leaves a name nobody answers verbatim — so an
 * ops-authored `password_reset` override reading "Hi {{recipient_name}}"
 * previewed as "Hi Dana" and reached the client as "Hi {{recipient_name}}".
 */
describe('the always scope a transactional send has to answer', () => {
  const OVERRIDE = {
    subject: 'Reset your {{platform_name}} password',
    body: 'Hi {{recipient_name}}, follow {{link}}. Questions? {{support_email}}',
  };

  it('leaves no always-scope placeholder unrendered, even with nothing in hand', async () => {
    const { pool, queued } = overridePool(OVERRIDE);

    await sendTransactionalEmail({ pool }, { ...template, vars: { link: 'https://app.test/r#t=1' } });

    const out = rendered(queued);
    expect(out).not.toMatch(/\{\{/);
    // The catalog promises the address where we hold no name, and the platform
    // where the send is not white-labelled.
    expect(out).toContain('Hi founder@acme.test');
    expect(out).toContain('Reset your N409 password');
  });

  it('prefers what the call site actually knows', async () => {
    const { pool, queued } = overridePool(OVERRIDE);

    await sendTransactionalEmail(
      { pool, settings: { get: async () => 'support@n409.test' } },
      {
        ...template,
        recipientName: 'Dana',
        platformName: 'Fidelity',
        vars: { link: 'https://app.test/r#t=1' },
      },
    );

    const out = rendered(queued);
    expect(out).toContain('Hi Dana');
    expect(out).toContain('Reset your Fidelity password');
    expect(out).toContain('support@n409.test');
  });

  it('still lets an explicit var win over this floor', async () => {
    const { pool, queued } = overridePool(OVERRIDE);

    await sendTransactionalEmail(
      { pool },
      { ...template, recipientName: 'Dana', vars: { link: 'x', recipient_name: 'Dr Okafor' } },
    );

    expect(rendered(queued)).toContain('Hi Dr Okafor');
  });

  it('renders the variable empty rather than failing the send when settings will not answer', async () => {
    const { pool, queued } = overridePool(OVERRIDE);
    const l = log();

    await sendTransactionalEmail(
      { pool, log: l as never, settings: { get: () => Promise.reject(new Error('no settings row')) } },
      { ...template, vars: { link: 'x' } },
    );

    // A missing support address is a gap in a sentence; a rejection here would
    // have been a password reset nobody received.
    expect(rendered(queued)).not.toMatch(/\{\{/);
    expect(l.warn).toHaveBeenCalled();
  });

  it('does not read settings at all when the built-in copy is what ships', async () => {
    const get = vi.fn(async () => 'support@n409.test');
    // No override row: the built-in body carries no placeholders, so there is
    // nothing to render and no reason to spend a query.
    await sendTransactionalEmail({ pool: livePool(), settings: { get } }, template);

    expect(get).not.toHaveBeenCalled();
  });
});

describe('sendTransactionalEmailInBackground', () => {
  it('swallows an outbox-insert failure instead of rejecting', async () => {
    const l = log();
    // A bare `void sendTransactionalEmail(...)` here is an unhandled rejection,
    // which this process answers by exiting.
    expect(() =>
      sendTransactionalEmailInBackground({ pool: deadPool(), log: l as never }, template),
    ).not.toThrow();
    await vi.waitFor(() =>
      expect(l.warn.mock.calls.map((c) => c[1])).toContain('background transactional email failed'),
    );
  });

  it('returns nothing to await — the response never waits on the mail path', () => {
    const l = log();
    // The point of the helper is that the caller cannot accidentally hold the
    // response open on it, and cannot accidentally leave it unhandled either.
    expect(
      sendTransactionalEmailInBackground({ pool: livePool(), log: l as never }, template),
    ).toBeUndefined();
  });

  it('still delivers on the happy path', async () => {
    const l = log();
    const sent: unknown[] = [];
    sendTransactionalEmailInBackground(
      {
        pool: livePool(),
        transport: { send: async (email: unknown) => void sent.push(email) } as never,
        log: l as never,
      },
      template,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(l.warn).not.toHaveBeenCalled();
  });
});

describe('sendTransactionalEmail', () => {
  it('does not let a failed "failed" stamp mask the delivery failure', async () => {
    // When the send fails *because* the database is unwell, the query that marks
    // the row 'failed' fails too — and it sat outside any try, so the rejection
    // it threw replaced the logged warning it was supposed to accompany.
    const l = log();
    await expect(
      sendTransactionalEmail(
        {
          pool: markFailsPool(),
          transport: { send: async () => Promise.reject(new Error('SMTP timeout')) } as never,
          log: l as never,
        },
        template,
      ),
    ).resolves.toBeUndefined();
    const messages = l.warn.mock.calls.map((c) => c[1]);
    expect(messages).toContain('could not mark transactional email failed');
    expect(messages).toContain('transactional email delivery failed; left in outbox');
  });

  it('still propagates an enqueue failure to a caller that awaits it', async () => {
    // Unchanged on purpose: a route that awaits the send wants the 500. Only the
    // sites that have already decided not to wait use the background helper.
    await expect(sendTransactionalEmail({ pool: deadPool() }, template)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });
});
