import { logUnretried } from '@n409/shared';
import type { FastifyBaseLogger } from 'fastify';
import { recordEmailSendAttempt } from '../observability/emailDeliveryMetrics.js';
import type { EmailOutboxRow } from '../repos/emailOutbox.js';
import type { EmailTransport } from '../hooks/stateChange.js';

/** What became of one row, from the outbox's point of view. */
export type SendOutcome =
  /** The transport took it and the row says so. */
  | 'sent'
  /** The transport refused it; the caller's own handler recorded that. */
  | 'failed'
  /** The transport took it and the row could not be told. See below. */
  | 'unrecorded';

/**
 * Hand one outbox row to the transport, then write down what happened —
 * keeping those two things apart.
 *
 * Every send path on this service is transport-then-bookkeeping, and each of
 * the four wrote both steps inside one `try` with one `catch`. That catch can
 * only describe failures of the first step: it calls `describeTransportFailure`
 * on whatever it caught, marks the row 'failed', and offers the error to the
 * bounce classifier. So a database blip on the *second* step — a statement
 * timeout, a dropped backend, a failover that costs one connection — was
 * recorded as the relay refusing the message.
 *
 * That is not a mislabel an operator can shrug at. 'failed' is the retry
 * ladder's entry condition (0159): the row is stamped with a `next_attempt_at`
 * a few minutes out and the sweep sends it again. So one refused UPDATE turns a
 * message the relay already accepted into a duplicate, and leaves the outbox —
 * the platform's own record of what it sent — swearing the send failed. Mail
 * cannot be un-sent, which is what makes this the same family as the stale
 * settle `settleClaimedEmail` was pinned against, arriving by the other door.
 *
 * What the row should say instead is nothing: it stays 'queued', which is the
 * honest state for "handed over, outcome unknown to this table". The sweep may
 * still re-send it once the claim lease lapses — this is an at-least-once
 * pipeline and a lost acknowledgement genuinely is ambiguous — but that is
 * fifteen minutes and one attempt rather than a ladder started on a lie, and
 * `recordSendFailure` is not asked to classify a `pg` error as a bounce.
 *
 * The failure is logged through `logUnretried` because nothing ever comes back
 * to correct the row: no sweep re-reads a delivery that was never written down,
 * and the only trace that this message left the building is this line.
 *
 * `onFailed` is the caller's own failure path, called only for a refusal by the
 * transport. It is not wrapped here: the four sites contain it differently —
 * one has a pool, one has the sweep's client, one has a claim to settle — and
 * a helper that swallowed their bookkeeping errors would hide the very
 * distinction it exists to draw.
 */
export async function sendAndRecord(
  transport: EmailTransport,
  email: EmailOutboxRow,
  handlers: {
    /** Record a delivery the transport accepted. */
    onSent: () => Promise<void>;
    /** Record a refusal by the transport. */
    onFailed: (err: unknown) => Promise<void>;
    log?: FastifyBaseLogger;
    /** Extra fields for the unrecorded-delivery line (the row's origin request). */
    context?: Record<string, unknown>;
  },
): Promise<SendOutcome> {
  try {
    await transport.send(email);
  } catch (err) {
    await handlers.onFailed(err);
    recordEmailSendAttempt('failed');
    return 'failed';
  }
  try {
    await handlers.onSent();
  } catch (err) {
    if (handlers.log) {
      logUnretried(
        handlers.log,
        err,
        { ...handlers.context, emailId: email.id, templateKey: email.template_key },
        'email was delivered but the outbox could not be marked sent; the row stays queued and a sweep may deliver it again',
      );
    }
    // The transport still took it — counted 'unrecorded', not 'failed'. A
    // relay that is refusing this platform outright and a `pg` blip on the
    // bookkeeping write afterwards are different incidents, and folding the
    // second into the first's outcome is the exact miscount this module's
    // docstring already spent its whole existence arguing against.
    recordEmailSendAttempt('unrecorded');
    return 'unrecorded';
  }
  recordEmailSendAttempt('sent');
  return 'sent';
}
