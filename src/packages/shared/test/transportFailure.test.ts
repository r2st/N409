import { describe, expect, it } from 'vitest';
import { describeTransportFailure } from '../src/failure.js';

/**
 * `fetch failed` is the message a person is shown when a delivery fails.
 *
 * Node's `fetch` collapses every transport failure into one `TypeError` whose
 * message is those two words, and the estate records `err.message` into columns
 * that people read: a partner's webhook delivery log, an email's failure line,
 * a sync connection's last error. The identifying fact is a syscall code on
 * `cause`, one property down — `classifyFailure` already walks that chain to
 * decide whether to retry, and drops the identity on the way out.
 *
 * These pin that the sentence a reader gets names the condition, and — the part
 * that is easy to lose in a refactor — that an error which *did* say something
 * keeps its own words rather than being flattened into a house phrase.
 */

/** A `TypeError: fetch failed` with `cause` set, exactly as undici raises it. */
function fetchFailure(code: string, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  (err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe('describeTransportFailure', () => {
  it('names the condition behind an opaque fetch rejection', () => {
    // The four a partner debugging their own endpoint actually hits.
    expect(describeTransportFailure(fetchFailure('ECONNREFUSED'))).toContain('connection was refused');
    expect(describeTransportFailure(fetchFailure('ENOTFOUND'))).toContain('does not resolve');
    expect(describeTransportFailure(fetchFailure('CERT_HAS_EXPIRED'))).toContain('certificate has expired');
    expect(describeTransportFailure(fetchFailure('ECONNRESET'))).toContain('connection was reset');
  });

  it('states a remedy for the conditions that have one', () => {
    // A name that does not resolve and an expired certificate are both somebody
    // going and changing something; saying which thing is the whole point.
    expect(describeTransportFailure(fetchFailure('ENOTFOUND'))).toMatch(/typo|DNS/);
    expect(describeTransportFailure(fetchFailure('CERT_HAS_EXPIRED'))).toMatch(/renew/i);
    expect(describeTransportFailure(fetchFailure('DEPTH_ZERO_SELF_SIGNED_CERT'))).toMatch(/authority/i);
    expect(describeTransportFailure(fetchFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toMatch(
      /intermediate/i,
    );
  });

  it('walks a nested cause chain', () => {
    // undici nests: TypeError → AggregateError → the socket error. Reading only
    // one level down finds nothing and the sentence falls back to the message.
    const inner = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:443'), {
      code: 'ECONNREFUSED',
    });
    const middle = Object.assign(new Error('all attempts failed'), { cause: inner });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: middle });
    expect(describeTransportFailure(outer)).toContain('connection was refused');
  });

  it('does not loop on an error that causes itself', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = err;
    expect(describeTransportFailure(err)).toBe(
      'the request could not be completed and the connection reported no reason',
    );
  });

  it('describes a deadline, which arrives as a name and no code', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(describeTransportFailure(timeout)).toContain('did not respond in time');
  });

  it('keeps an error that said something for itself', () => {
    // The guard against this becoming a message-flattener. An upstream that
    // answered wrote a better sentence than this table can, and a receiver
    // whose own error text names its own condition must survive intact.
    expect(describeTransportFailure(new Error('receiver responded 410'))).toBe('receiver responded 410');
    expect(describeTransportFailure(new Error('example.com resolves to 127.0.0.1'))).toBe(
      'example.com resolves to 127.0.0.1',
    );
  });

  it('replaces the messages that are only a shrug', () => {
    for (const opaque of ['fetch failed', 'terminated', 'other side closed', 'socket hang up', '   ']) {
      expect(describeTransportFailure(new Error(opaque)), opaque).toBe(
        'the request could not be completed and the connection reported no reason',
      );
    }
  });

  it('never returns nothing, whatever it is handed', () => {
    // Every caller is already on a failure path. A throw here, or an empty
    // string written to the column, is a failure that records nothing at all.
    for (const value of [null, undefined, '', 0, {}, [], Symbol('x')]) {
      const described = describeTransportFailure(value);
      expect(typeof described, String(value?.toString?.() ?? value)).toBe('string');
      expect(described.length).toBeGreaterThan(0);
    }
  });
});
