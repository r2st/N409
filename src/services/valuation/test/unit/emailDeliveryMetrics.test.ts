import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  recordEmailDeliveryEvent,
  recordEmailSendAttempt,
  registerEmailDeliveryMetrics,
  resetEmailDeliveryMetrics,
} from '../../src/observability/emailDeliveryMetrics.js';
import { sendAndRecord } from '../../src/email/sendAttempt.js';
import type { EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

/**
 * Sending reputation, made visible to a scrape (R436, methodology M11).
 *
 * `GET /api/v1/admin/email/delivery-stats` already answers "what is the bounce
 * rate", but only to whoever happens to load it — an ops-session-gated,
 * pull-based dashboard is a number that is right the instant somebody looks and
 * silent every other instant. A complaint spike that gets the sending domain
 * blocklisted, or a relay that has started refusing every message outright,
 * produced nothing an alert could fire on.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const email = { id: '01JBQ7F0000000000000000000', template_key: 'draft_ready' } as EmailOutboxRow;

describe('the email send-attempt counter', () => {
  afterEach(() => resetEmailDeliveryMetrics());

  it('counts the outcome from the one call every send path shares', async () => {
    const registry = new MetricsRegistry();
    registerEmailDeliveryMetrics(registry);

    const sent: EmailTransport = { send: async () => undefined };
    await sendAndRecord(sent, email, { onSent: async () => undefined, onFailed: async () => undefined });

    const refused: EmailTransport = {
      send: async () => {
        throw new Error('SMTP RCPT failed: 550 no such user');
      },
    };
    await sendAndRecord(refused, email, { onSent: async () => undefined, onFailed: async () => undefined });

    const unrecordable: EmailTransport = { send: async () => undefined };
    await sendAndRecord(unrecordable, email, {
      onSent: async () => {
        throw new Error('pg blip');
      },
      onFailed: async () => undefined,
    });

    const text = registry.render();
    expect(text).toContain('email_send_attempts_total{outcome="sent"} 1');
    expect(text).toContain('email_send_attempts_total{outcome="failed"} 1');
    expect(text).toContain('email_send_attempts_total{outcome="unrecorded"} 1');
  });

  it('counts a bookkeeping failure as `unrecorded`, not `failed` — the transport still took it', async () => {
    // The exact miscount `sendAndRecord`'s own docstring exists to prevent, one
    // instrument over: a `pg` blip on the marking UPDATE must not read like the
    // relay refusing the message, or a rule built on `failed` pages on the
    // outbox's own bookkeeping rather than on the thing it is meant to watch.
    const registry = new MetricsRegistry();
    registerEmailDeliveryMetrics(registry);

    await sendAndRecord(
      { send: async () => undefined },
      email,
      {
        onSent: async () => {
          throw new Error('pg blip');
        },
        onFailed: async () => undefined,
      },
    );

    const text = registry.render();
    expect(text).not.toContain('email_send_attempts_total{outcome="failed"}');
    expect(text).toContain('email_send_attempts_total{outcome="unrecorded"} 1');
  });

  it('is inert before registration rather than throwing', async () => {
    await expect(
      sendAndRecord(
        { send: async () => undefined },
        email,
        { onSent: async () => undefined, onFailed: async () => undefined },
      ),
    ).resolves.toBe('sent');
    expect(() => recordEmailSendAttempt('sent')).not.toThrow();
  });

  it('is called from the one choke point all four send paths share', () => {
    const src = readFileSync(path.resolve(HERE, '../../src/email/sendAttempt.ts'), 'utf8');
    expect(src).toMatch(/recordEmailSendAttempt\('sent'\)/);
    expect(src).toMatch(/recordEmailSendAttempt\('failed'\)/);
    expect(src).toMatch(/recordEmailSendAttempt\('unrecorded'\)/);
  });
});

describe('the email delivery-event counter', () => {
  afterEach(() => resetEmailDeliveryMetrics());

  it('counts a signal by kind and bounce kind', () => {
    const registry = new MetricsRegistry();
    registerEmailDeliveryMetrics(registry);

    recordEmailDeliveryEvent('bounced', 'hard');
    recordEmailDeliveryEvent('complained', 'complaint');

    const text = registry.render();
    expect(text).toContain('email_delivery_events_total{kind="bounced",bounce="hard"} 1');
    expect(text).toContain('email_delivery_events_total{kind="complained",bounce="complaint"} 1');
  });

  it("sets bounce to 'none' for a signal that is not a bounce, so the label set is total", () => {
    // The same reason `sso_outcomes_total` always sets a value: a label
    // present only on the rows that happen to have one is a series that
    // silently changes shape depending on what has been seen so far.
    const registry = new MetricsRegistry();
    registerEmailDeliveryMetrics(registry);
    recordEmailDeliveryEvent('delivered', null);
    expect(registry.render()).toContain('email_delivery_events_total{kind="delivered",bounce="none"} 1');
  });

  it('is inert before registration rather than throwing', () => {
    expect(() => recordEmailDeliveryEvent('opened', null)).not.toThrow();
  });

  it('is called from the one ledger insert both the SMTP path and the webhook route fold through', () => {
    const src = readFileSync(path.resolve(HERE, '../../src/repos/emailDelivery.ts'), 'utf8');
    expect(src).toMatch(/if \(fresh\) recordEmailDeliveryEvent\(input\.kind, resolvedBounceKind\(input\)\)/);
  });
});
