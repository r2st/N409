import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import {
  REQUEST_ID_HEADER,
  bindRequestId,
  currentRequestId,
  requestIdHeaders,
  runWithRequestId,
} from '../src/requestContext.js';

describe('ambient request id', () => {
  it('is undefined outside a request', () => {
    expect(currentRequestId()).toBeUndefined();
    expect(requestIdHeaders()).toEqual({});
  });

  it('is readable anywhere inside the bound scope', () => {
    const seen = runWithRequestId('req-1', () => currentRequestId());
    expect(seen).toBe('req-1');
  });

  it('survives an await, which is the whole point', async () => {
    // The engine call that needs the header happens several awaits deep in a
    // route handler; a binding that did not cross them would be useless.
    const seen = await runWithRequestId('req-2', async () => {
      await delay(1);
      await delay(1);
      return currentRequestId();
    });
    expect(seen).toBe('req-2');
  });

  it('does not leak out of the scope that bound it', async () => {
    await runWithRequestId('req-3', async () => {
      await delay(1);
    });
    expect(currentRequestId()).toBeUndefined();
  });

  it('keeps concurrent requests apart', async () => {
    // Two overlapping requests are the failure this design exists to prevent:
    // a module-level variable would have the second overwrite the first.
    const slow = runWithRequestId('req-slow', async () => {
      await delay(5);
      return currentRequestId();
    });
    const fast = runWithRequestId('req-fast', async () => {
      await delay(1);
      return currentRequestId();
    });
    expect(await Promise.all([slow, fast])).toEqual(['req-slow', 'req-fast']);
  });

  it('nests, with the inner binding winning until it returns', () => {
    const seen = runWithRequestId('outer', () => ({
      inner: runWithRequestId('inner', () => currentRequestId()),
      after: currentRequestId(),
    }));
    expect(seen).toEqual({ inner: 'inner', after: 'outer' });
  });

  it('bindRequestId affects the caller, unlike run', async () => {
    // Fastify onRequest hooks return rather than wrap, so the binding has to
    // outlive the call that made it.
    await runWithRequestId('placeholder', async () => {
      bindRequestId('req-hook');
      await delay(1);
      expect(currentRequestId()).toBe('req-hook');
    });
  });
});

describe('outbound header', () => {
  it('sends the active id downstream', () => {
    expect(runWithRequestId('req-4', () => requestIdHeaders())).toEqual({
      [REQUEST_ID_HEADER]: 'req-4',
    });
  });

  it('sends nothing rather than a minted id when unbound', () => {
    // A background job has no request to correlate to. Inventing an id here
    // would make the downstream service log one that appears nowhere else.
    expect(requestIdHeaders()).toEqual({});
  });

  it('uses the header name the Python tier reads', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});
