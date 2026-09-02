import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeForUser, InternalServiceError, postJson, toProblem } from '../../src/clients/internal.js';

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
    // R198 wraps it: the upstream's sentence stays verbatim in the middle, with
    // a name for the work in front and the remedy after. What is pinned here is
    // that the pipe still carries the engine's own words end to end.
    expect(toProblem(err).detail).toContain('volatility is required');
    expect(toProblem(err).detail).toMatch(/^The calculation could not be run: /);
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
    // The withheld half is asserted by absence, not by an exact sentence: what
    // matters is that the body's *contents* did not come through, and pinning
    // the prose instead makes this test fail on an improvement to the wording.
    //
    // R357 narrowed "none of it" to "none of it but the paths". `loc` is a fact
    // about the shape of the request this service sent, not about what was in
    // it — the value is `input`, the prose is `msg`, and both are still
    // withheld here and asserted below. Withholding the path too was the whole
    // cost: the engine's remedy is "correct the inputs it names", and a schema
    // rejection named nothing at all.
    expect(problem.detail).not.toContain('Input should be greater than 0');
    expect(problem.detail).toContain('inputs.share_classes[0].shares');
    expect(JSON.stringify(problem.toBody('/x'))).not.toContain('cfo@acme.example');
    expect(JSON.stringify(problem.toBody('/x'))).not.toContain('Series A');
  });

  it('names every refused field, bounded, and counts the rest', async () => {
    // A badly-shaped payload produces one entry per field the schema expected,
    // so the sentence is bounded for the reason `describeIssues` is.
    const body = JSON.stringify({
      detail: [
        { type: 'missing', loc: ['body', 'params', 'valuation_date'], msg: 'Field required' },
        { type: 'missing', loc: ['body', 'params', 'currency'], msg: 'Field required' },
        { type: 'missing', loc: ['body', 'inputs', 'revenue'], msg: 'Field required' },
        { type: 'missing', loc: ['body', 'inputs', 'ebitda'], msg: 'Field required' },
        { type: 'missing', loc: ['body', 'inputs', 'shares'], msg: 'Field required' },
      ],
    });
    const detail = toProblem(await failWith(response(422, body))).detail ?? '';
    expect(detail).toContain('params.valuation_date, params.currency, inputs.revenue');
    expect(detail).toContain('(and 2 more fields)');
    expect(detail).not.toContain('Field required');
  });

  it('keeps naming the part of the request when it is not the body', async () => {
    // `body` leads every payload this client sends, so it says nothing; `query`
    // is the half that says where to look.
    const body = JSON.stringify({
      detail: [{ type: 'int_parsing', loc: ['query', 'paths'], msg: 'Input should be a valid integer' }],
    });
    expect(toProblem(await failWith(response(422, body))).detail).toContain('it refused query.paths');
  });

  it('prefers a sentence the upstream wrote over the field list', async () => {
    // The engine's own pre-flight message is written for the analyst and is
    // better than any list of paths; the fallback is for the refusals that
    // never had one.
    const body = JSON.stringify({ detail: 'volatility is required', errors: [{ loc: ['body', 'x'] }] });
    const detail = toProblem(await failWith(response(422, body))).detail ?? '';
    expect(detail).toContain('volatility is required');
    expect(detail).not.toContain('it refused');
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
    expect(problem.detail).not.toContain('Traceback');
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
    expect(toProblem(err).detail).not.toContain('10.0.1.4');
    expect(toProblem(err).detail).not.toContain('ECONNREFUSED');
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

    expect(problem.detail).not.toContain('secret');
    const rendered = JSON.stringify(problem.toBody('/x'));
    expect(rendered).toContain('volatility is required');
    expect(rendered).not.toContain('secret');
  });
});

describe('the bound on an upstream detail', () => {
  it('bounds a problem detail as tightly as it bounds a raw body', async () => {
    /*
     * The raw-text branch was cut at 500 and this one was not, so the bound
     * stopped applying exactly when the upstream's answer *parsed* — and that
     * is the answer that travels furthest: `opaque` is false, so `toProblem`
     * puts it verbatim into an HTTP response body, and the network-call record
     * puts it in a `text` column that no `boundedJson` pass reaches.
     */
    const err = await failWith(response(422, JSON.stringify({ detail: 'x'.repeat(5_000) })));
    expect(err.opaque).toBe(false);
    expect(err.detail.length).toBe(500);
    expect(toProblem(err).detail!.length).toBeLessThan(700);
  });

  it('bounds a `title` the same way', async () => {
    const err = await failWith(response(500, JSON.stringify({ title: 'y'.repeat(5_000) })));
    expect(err.detail.length).toBe(500);
  });

  it('never cuts an upstream body through a character', async () => {
    // One BMP character in front, so unit 499 is the *high* half of an emoji
    // and the cut lands inside it. The raw branch: a non-JSON body, so
    // `detail` is the text itself.
    const err = await failWith(response(502, `a${'\u{1F600}'.repeat(400)}`, 'text/html'));
    expect(err.opaque).toBe(true);
    // 499 units — the orphaned high surrogate dropped rather than kept.
    expect(err.detail.length).toBe(499);
    expect(err.detail).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // And it round-trips through UTF-8, which is what the column and the log
    // line both need of it.
    expect(Buffer.from(err.detail, 'utf8').toString('utf8')).toBe(err.detail);
  });
});

/**
 * R277, methodology M19. `toProblem` is not the only way an upstream failure
 * reaches a person, and it was the only one that asked.
 *
 * A bulk endpoint answers per row inside a 200; a failed `calculations` or
 * `ai_jobs` row stores the reason in a column the UI draws. Every one of those
 * sites reached for `err.message` — which is `${service}: ${detail}` with
 * nothing consulted, so it is the raw body on exactly the errors `opaque` marks
 * as raw. A stored one is worse than a leaked 502 body: it is redrawn every
 * time the row is listed.
 */
describe('the sentence for a failure that is not answered with a problem', () => {
  // Built directly rather than through `failWith`: the breaker is module-level
  // and the tests above have already opened it for `engine`, so a call made
  // here answers with the breaker's own sentence instead of the body.
  const opaqueFailure = (detail: string) => new InternalServiceError('engine', 500, detail, [], false, true);

  it('withholds the same traceback the problem document withholds', () => {
    const err = opaqueFailure(
      'Traceback (most recent call last):\n' +
        '  File "/opt/N409/src/services/engine-wrapper/app/engine/compute.py", line 412, in allocate\n' +
        '    raise ZeroDivisionError\n',
    );

    // What the six call sites used to store or return.
    expect(err.message).toContain('/opt/N409');
    expect(describeForUser(err)).not.toContain('Traceback');
    expect(describeForUser(err)).not.toContain('/opt/N409');
    expect(describeForUser(err)).not.toContain('compute.py');
  });

  it('withholds the payload a pydantic body echoes back', () => {
    const err = opaqueFailure(
      JSON.stringify({
        detail: [{ msg: 'Input should be greater than 0', input: { holder_email: 'cfo@acme.example' } }],
      }),
    );
    expect(err.message).toContain('cfo@acme.example');
    expect(describeForUser(err)).not.toContain('cfo@acme.example');
  });

  it('keeps the upstream sentence when the upstream wrote one for a caller', () => {
    // The narrowing to `InternalServiceError` was there for a reason — this is
    // it, and it survives.
    const err = new InternalServiceError('engine', 422, 'volatility is required');
    expect(describeForUser(err)).toContain('volatility is required');
  });

  it('never names the internal service the way `err.message` does', () => {
    const err = new InternalServiceError('engine', 500, 'boom', [], false, true);
    expect(err.message).toMatch(/^engine: /);
    expect(describeForUser(err)).not.toMatch(/^engine: /);
  });
});
