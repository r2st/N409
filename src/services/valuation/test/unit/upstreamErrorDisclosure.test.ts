import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalServiceError, postJson, toProblem } from '../../src/clients/internal.js';

/**
 * What an upstream failure is allowed to tell the caller.
 *
 * `InternalServiceError.detail` is read by two things that want opposite
 * things from it. The log and the network-call record want the raw body —
 * that is where a traceback or a proxy's error page is worth having, and the
 * throw site says so. `toProblem` puts it in an HTTP response, where the same
 * bytes are a file path, a module layout, or the caller's own payload echoed
 * back inside a pydantic validation error.
 *
 * The split is by provenance, not by pattern-matching for anything that looks
 * dangerous: a `detail` string in a problem document was written for a caller
 * and passes through untouched, and everything else is kept for the log and
 * withheld from the response.
 */

function response(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failWith(res: Response): Promise<InternalServiceError> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
  const err = await postJson('engine', 'http://engine/compute', {}, { retries: 0 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InternalServiceError);
  return err as InternalServiceError;
}

describe('upstream error disclosure', () => {
  it('forwards a problem detail the upstream wrote for a caller', async () => {
    const err = await failWith(response(422, JSON.stringify({ detail: 'volatility is required' })));
    expect(err.opaque).toBe(false);
    // The whole point of the pipe: the engine's pre-flight message is the most
    // useful thing the analyst can be told.
    expect(toProblem(err).detail).toBe('engine rejected the request: volatility is required');
  });

  it('withholds a pydantic validation body, which echoes the submitted payload', async () => {
    // FastAPI's RequestValidationError handler answers with `detail` as a
    // *list*, and each entry carries `input` — the offending value, verbatim.
    const body = JSON.stringify({
      detail: [
        {
          type: 'greater_than',
          loc: ['body', 'inputs', 'share_classes', 0, 'shares'],
          msg: 'Input should be greater than 0',
          input: { name: 'Series A', shares: -1, holder_email: 'cfo@acme.example' },
        },
      ],
      request_id: '01K7Z9V2QW',
    });
    const err = await failWith(response(422, body));

    expect(err.opaque).toBe(true);
    // Kept where it is useful...
    expect(err.detail).toContain('cfo@acme.example');
    // ...and absent from what the caller is handed.
    const problem = toProblem(err);
    expect(problem.status).toBe(422);
    expect(problem.detail).toBe('engine rejected the request.');
    expect(JSON.stringify(problem.toBody('/x'))).not.toContain('cfo@acme.example');
  });

  it('withholds a traceback or an HTML error page', async () => {
    const traceback =
      'Traceback (most recent call last):\n' +
      '  File "/opt/N409/src/services/engine-wrapper/app/engine/compute.py", line 412, in allocate\n' +
      '    raise ZeroDivisionError\n';
    const err = await failWith(response(500, traceback, 'text/plain'));

    expect(err.opaque).toBe(true);
    const problem = toProblem(err);
    expect(problem.status).toBe(502);
    expect(problem.detail).toBe('engine is unavailable.');
    const body = JSON.stringify(problem.toBody('/x'));
    expect(body).not.toContain('/opt/N409');
    expect(body).not.toContain('compute.py');
  });

  it('withholds a transport failure that names internal topology', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.1.4:3003')));
    const err = (await postJson('engine', 'http://engine/compute', {}, { retries: 0 }).catch(
      (e: unknown) => e,
    )) as InternalServiceError;

    expect(err.detail).toContain('10.0.1.4');
    expect(toProblem(err).detail).toBe('engine is unavailable.');
  });

  it('still says the service timed out, because that sentence is ours', async () => {
    // Authored here, not upstream: it describes what this service did and
    // names nothing a caller should not see.
    const timeout = new Error('The operation timed out.');
    timeout.name = 'TimeoutError'; // what AbortSignal.timeout rejects with
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
    const err = (await postJson(
      'engine',
      'http://engine/compute',
      {},
      { retries: 0, timeoutMs: 5_000 },
    ).catch((e: unknown) => e)) as InternalServiceError;

    expect(err.abandoned).toBe(true);
    expect(err.opaque).toBe(false);
    expect(toProblem(err).detail).toMatch(/did not respond within/);
  });

  it('keeps the structured issue list even when the body around it is withheld', async () => {
    // `parseIssues` builds each issue field by field from a known shape, so
    // nothing unrecognised rides along — the issues survive an opaque body,
    // which is what lets the form still anchor its messages.
    const body = JSON.stringify({
      detail: [{ type: 'missing', loc: ['body', 'inputs'], input: { secret: 'x' } }],
      issues: [
        {
          code: 'required',
          field: 'inputs.volatility',
          message: 'volatility is required',
          severity: 'error',
        },
      ],
    });
    const err = await failWith(response(422, body));
    const problem = toProblem(err);

    expect(problem.detail).toBe('engine rejected the request.');
    const rendered = JSON.stringify(problem.toBody('/x'));
    expect(rendered).toContain('volatility is required');
    expect(rendered).not.toContain('secret');
  });
});
