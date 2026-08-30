import { describe, expect, it, vi, afterEach } from 'vitest';
import { InternalServiceError, MAX_INTERNAL_BODY_BYTES, postJson } from '../../src/clients/internal.js';
import { MAX_INTEGRATION_JSON_BYTES } from '../../src/clients/deadline.js';
import {
  configureReportRenderer,
  MAX_RENDERED_PDF_BYTES,
  renderReportPdf,
} from '../../src/clients/reportRender.js';
import { circuits } from '../../src/clients/internal.js';
import { sampleReportPdfInput } from '../../src/domain/sampleReportPdf.js';

/**
 * How much of an upstream answer this service will hold.
 *
 * `res.text()` and `res.arrayBuffer()` read to the end of the stream before
 * they return, so the size of the buffer is the far end's choice. The
 * third-party clients settled this with `MAX_INTEGRATION_JSON_BYTES` and wrote
 * down why; the internal ones — engine, AI, report — read the same way with no
 * ceiling, on the argument that the upstream is ours. That argument is a
 * deployment fact rather than a property of the code: `ENGINE_URL`, `AI_URL`
 * and `REPORT_SERVICE_URL` are environment variables, and whatever answers on
 * that port is what gets buffered.
 *
 * The report client's rejection path is the sharper case, because it *looked*
 * bounded: `sliceChars(await res.text(), 500)` cuts a string that has already
 * been read whole, so the 500 was about the log line and never about the heap.
 */

/** A response whose body arrives in chunks and never declares a length. */
function endlessBody(bytes: number): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the ceiling on an internal upstream body', () => {
  it('is the same figure the third-party clients use', () => {
    expect(MAX_INTERNAL_BODY_BYTES).toBe(MAX_INTEGRATION_JSON_BYTES);
  });

  it('refuses a body that runs past it rather than buffering it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(endlessBody(MAX_INTERNAL_BODY_BYTES + 1024 * 1024)));

    const err = await postJson('engine', 'http://x/y', {}, { retries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServiceError);
    // Named, so the log says which limit was met rather than leaving a reader
    // to guess at a truncated JSON parse.
    expect((err as InternalServiceError).detail).toContain('larger than 16 MB');
  });

  it('reads an ordinary answer whole', async () => {
    const body = { rows: Array.from({ length: 200 }, (_, i) => i) };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(postJson('engine', 'http://x/y', {})).resolves.toEqual(body);
  });
});

describe('the ceiling on a rendered PDF', () => {
  afterEach(() => {
    configureReportRenderer(null);
    circuits.resetAll();
  });

  it('stops reading a render that never ends, and still produces a report', async () => {
    configureReportRenderer('http://report.test');
    let chunksPulled = 0;
    const fetchFn = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunksPulled += 1;
            const chunk = new Uint8Array(256 * 1024).fill(0x25);
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { 'content-type': 'application/pdf' } },
      )) as unknown as typeof fetch;

    const pdf = await renderReportPdf(sampleReportPdfInput('409a'), { fetchFn });

    // The fallback is the point: an offload that cannot be trusted to end is a
    // latency dependency, never an availability one.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // And the bound is real — the cap plus the stream's own read-ahead, not a
    // stream that runs until the process dies.
    expect(chunksPulled).toBeLessThanOrEqual(MAX_RENDERED_PDF_BYTES / (256 * 1024) + 2);
  });
});
