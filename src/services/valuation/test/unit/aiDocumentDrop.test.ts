/**
 * An AI run that went ahead on fewer documents than the firm uploaded says so.
 *
 * `encodeDocuments` skips a blob it cannot read rather than failing the run,
 * which is right — one unreadable upload should not cost a firm its whole
 * analysis — and was silent, which is not. The skip changes what the model is
 * reasoning from: the run produces a confident answer from the smaller set,
 * with nothing anywhere recording that the set was smaller. That is a false
 * empty state one tier down — a discarded failure re-presented as a fact about
 * the data.
 *
 * It also hid the failure worth waking up for. `decodeFromStorage` is envelope
 * decryption, so a key that has gone wrong does not drop one document, it drops
 * every document on every run — and the only outward sign would have been
 * analyses that had quietly stopped citing anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDocuments, MAX_AI_REQUEST_DOCUMENT_BYTES } from '../../src/routes/ai.js';

type Doc = Parameters<typeof encodeDocuments>[1][number];

const doc = (over: Partial<Doc> & { id: string; storage_path: string }): Doc =>
  ({
    filename: `${over.id}.pdf`,
    kind: 'financials',
    content_type: 'application/pdf',
    size_bytes: 1024,
    ...over,
  }) as Doc;

function recorder() {
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warns,
    errors,
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => void warns.push({ obj, msg }),
      // `readStoredBlob` reports at error level with `alert: true`; a recorder
      // that only had `warn` would turn that call into a TypeError, which this
      // function's own catch would then file as an unreadable document — the
      // check passing by breaking.
      error: (obj: Record<string, unknown>, msg: string) => void errors.push({ obj, msg }),
    } as never,
  };
}

describe('documents that never reached the AI', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'n409-ai-docs-'));
    await writeFile(join(dir, 'readable.bin'), Buffer.from('a real document'));
    // An encrypted blob with no key configured — `decodeFromStorage` throws
    // rather than corrupting, which is the realistic shape of this failure.
    await writeFile(join(dir, 'sealed.bin'), Buffer.concat([Buffer.from('N409ENC1'), Buffer.alloc(48)]));
    // A blob that reads perfectly well and is not what was uploaded. With no
    // key configured `decodeFromStorage` hands these bytes back unchanged, so
    // the sha256 recorded at upload is the only thing that can tell.
    await writeFile(join(dir, 'damaged.bin'), Buffer.from('a real documenX'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('still returns what it could read', async () => {
    const { log } = recorder();
    const encoded = await encodeDocuments(
      dir,
      [doc({ id: 'ok', storage_path: 'readable.bin' }), doc({ id: 'gone', storage_path: 'missing.bin' })],
      log,
    );
    // The run goes ahead — that part was never in question.
    expect(encoded.map((e) => e.id)).toEqual(['ok']);
  });

  it('names each document it could not read', async () => {
    const { log, warns } = recorder();
    await encodeDocuments(dir, [doc({ id: 'gone', storage_path: 'missing.bin' })], log);

    const perDoc = warns.find((w) => w.msg === 'document unreadable — excluded from AI input');
    expect(perDoc, 'the per-document line is missing').toBeDefined();
    expect(perDoc!.obj).toMatchObject({ documentId: 'gone', kind: 'financials' });
    // The cause, not just the fact: ENOENT and a decryption failure are
    // different incidents and only the error tells them apart.
    expect(perDoc!.obj.err).toBeDefined();
  });

  it('does not log the filename, which on this platform names people', async () => {
    // Uploads here are offer letters and board consents. The redact list covers
    // structured name fields; a filename is free text that walks past it.
    const { log, warns } = recorder();
    await encodeDocuments(
      dir,
      [doc({ id: 'x', storage_path: 'missing.bin', filename: 'Offer - Jane Okafor.pdf' })],
      log,
    );
    expect(JSON.stringify(warns)).not.toContain('Jane Okafor');
  });

  it('tallies, so one bad upload is visibly different from all of them', async () => {
    // The envelope-key case. A count is what separates "a firm re-uploads one
    // corrupt PDF" from "this build cannot read anything it has ever stored".
    const { log, warns } = recorder();
    await encodeDocuments(
      dir,
      [
        doc({ id: 'a', storage_path: 'sealed.bin' }),
        doc({ id: 'b', storage_path: 'sealed.bin' }),
        doc({ id: 'c', storage_path: 'readable.bin' }),
      ],
      log,
    );

    const tally = warns.find((w) => w.msg === 'AI input is missing documents');
    expect(tally, 'the tally line is missing').toBeDefined();
    expect(tally!.obj).toMatchObject({ unreadable: 2, eligible: 3, sent: 1 });
  });

  it('says nothing when every document read cleanly', async () => {
    // Absence has to stay meaningful, or the line is noise on every run.
    const { log, warns } = recorder();
    await encodeDocuments(dir, [doc({ id: 'ok', storage_path: 'readable.bin' })], log);
    expect(warns).toEqual([]);
  });

  /**
   * The half of the check that decryption cannot do (round 223).
   *
   * `decodeFromStorage` authenticates, but only where there is a key to
   * authenticate with: on a deployment with `DOCUMENTS_ENCRYPTION_KEY` unset
   * it returns the file as it found it. So a truncated write or a flipped bit
   * reached the model as the document — right filename, right content type,
   * changed content — and whatever the model read out of it was applied to the
   * engagement's parameters. The download route has refused these since round
   * 197 by comparing `documents.sha256`; this path is the one that feeds a
   * valuation, and it was not comparing anything.
   */
  describe('a blob that reads cleanly and is not the document', () => {
    const damaged = () =>
      doc({
        id: 'tampered',
        storage_path: 'damaged.bin',
        sha256: createHash('sha256').update('a real document').digest('hex'),
      });

    it('is kept out of the AI input', async () => {
      const { log } = recorder();
      const encoded = await encodeDocuments(dir, [damaged()], log);
      expect(encoded).toEqual([]);
    });

    it('is reported as the data-loss event it is', async () => {
      const { log, errors } = recorder();
      await encodeDocuments(dir, [damaged()], log);
      const line = errors.find((e) => e.msg === 'stored document failed its integrity check');
      expect(line, 'the integrity failure was not reported').toBeDefined();
      expect(line!.obj).toMatchObject({ documentId: 'tampered', alert: true });
    });

    it('still lets the rest of the run go ahead, counted', async () => {
      const { log, warns } = recorder();
      const encoded = await encodeDocuments(
        dir,
        [damaged(), doc({ id: 'ok', storage_path: 'readable.bin' })],
        log,
      );
      expect(encoded.map((e) => e.id)).toEqual(['ok']);
      const tally = warns.find((w) => w.msg === 'AI input is missing documents');
      expect(tally!.obj).toMatchObject({ unreadable: 1, eligible: 2, sent: 1 });
    });

    it('serves a row with no recorded hash, which predates the column', async () => {
      // Refusing these would drop every document uploaded before `sha256`
      // existed — a migration turned into an outage.
      const { log } = recorder();
      const encoded = await encodeDocuments(
        dir,
        [doc({ id: 'legacy', storage_path: 'damaged.bin', sha256: null })],
        log,
      );
      expect(encoded.map((e) => e.id)).toEqual(['legacy']);
    });
  });

  it('works without a logger, which is what the many test call sites pass', async () => {
    await expect(encodeDocuments(dir, [doc({ id: 'gone', storage_path: 'missing.bin' })])).resolves.toEqual(
      [],
    );
  });
});

/**
 * The other side of the same wire.
 *
 * Each document is capped at 5 MB and no more than ten go, and the product of
 * those two — 66.7 MB once base64 has had it — is more than twice the 32 MiB
 * body the AI service accepts (`limits.py`). Five real uploads on one
 * engagement were therefore a 413, and a 413 is not retryable, so the AI step
 * failed permanently on exactly the engagements that had the most to reason
 * from.
 */
describe('the request budget the two ceilings did not add up to', () => {
  let dir: string;
  /** The per-document ceiling itself — the worst case the two caps allow. */
  const BIG = 5 * 1024 * 1024;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'n409-ai-budget-'));
    for (let i = 0; i < 6; i++) {
      await writeFile(join(dir, `big${i}.bin`), Buffer.alloc(BIG, 0x61));
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bigDocs = () =>
    Array.from({ length: 6 }, (_, i) => doc({ id: `big${i}`, storage_path: `big${i}.bin`, size_bytes: BIG }));

  it('sends no more base64 than the receiver will take', async () => {
    const { log } = recorder();
    const encoded = await encodeDocuments(dir, bigDocs(), log);

    const bytes = encoded.reduce((n, e) => n + String(e.content_base64).length, 0);
    expect(bytes).toBeLessThanOrEqual(MAX_AI_REQUEST_DOCUMENT_BYTES);
    // Not by refusing everything: what fits, goes. Three of these weigh
    // 20.97 MB encoded and a fourth would be 27.96 MB, over the budget.
    expect(encoded.map((e) => e.id)).toEqual(['big0', 'big1', 'big2']);
  });

  it('says so, because the run then reasons from a smaller set', async () => {
    const { log, warns } = recorder();
    const encoded = await encodeDocuments(dir, bigDocs(), log);

    const line = warns.find((w) => w.msg === 'AI input truncated to the request budget');
    expect(line, 'the truncation line is missing').toBeDefined();
    expect(line!.obj).toMatchObject({
      overBudget: 6 - encoded.length,
      eligible: 6,
      sent: encoded.length,
      budgetBytes: MAX_AI_REQUEST_DOCUMENT_BYTES,
    });
  });

  it('leaves an ordinary set alone', async () => {
    const { log, warns } = recorder();
    const encoded = await encodeDocuments(dir, [bigDocs()[0]!], log);

    expect(encoded).toHaveLength(1);
    expect(warns.some((w) => w.msg === 'AI input truncated to the request budget')).toBe(false);
  });

  /**
   * The budget decides before the read (R417, methodology M8).
   *
   * These assertions are about the *work*, and they have to be: the answer is
   * byte-for-byte the same whichever side of the read the decision is made on,
   * so nothing about `encoded` or about the tallies could ever have shown that
   * the three documents past the budget were being read off disk, decrypted and
   * hashed in full before being dropped. At the caps that is 30 MiB of Buffer
   * and 24.5 ms of event-loop-blocking crypto per run.
   *
   * The discriminator is the absence of the blobs themselves. A reader that
   * reaches for `big3`..`big5` gets ENOENT and files them as *unreadable*; one
   * that has already decided they do not fit never touches the disk and files
   * them as *over budget*. So the pre-fix source fails these by putting three
   * documents in the wrong bucket, and no mock is involved in saying so.
   */
  describe('the documents past the budget are not read', () => {
    let sparse: string;

    beforeAll(async () => {
      sparse = await mkdtemp(join(tmpdir(), 'n409-ai-budget-sparse-'));
      // Only the three that fit exist on disk. The other three are rows whose
      // blobs this function must never ask for.
      for (let i = 0; i < 3; i++) {
        await writeFile(join(sparse, `big${i}.bin`), Buffer.alloc(BIG, 0x61));
      }
    });

    afterAll(async () => {
      await rm(sparse, { recursive: true, force: true });
    });

    it('never opens a blob it has already decided will not fit', async () => {
      const { log, warns } = recorder();
      const encoded = await encodeDocuments(sparse, bigDocs(), log);

      // Output identity with the full directory above — this is the assertion
      // that makes the two below a statement about work and not about answers.
      expect(encoded.map((e) => e.id)).toEqual(['big0', 'big1', 'big2']);

      // Filed as over budget, which is what they are.
      const truncated = warns.find((w) => w.msg === 'AI input truncated to the request budget');
      expect(truncated!.obj).toMatchObject({ overBudget: 3, eligible: 6, sent: 3 });

      // And not as unreadable, which is what a read of a blob that is not there
      // would have made them.
      expect(warns.some((w) => w.msg === 'AI input is missing documents')).toBe(false);
    });

    it('still reads, and still refuses, a document inside the budget', async () => {
      // The pre-check must not become the only check: a row that claims to fit
      // is read, and what the read says about it is what counts. `big3` claims
      // 5 MiB, fits on its own, and is not on disk.
      const { log, warns } = recorder();
      const encoded = await encodeDocuments(sparse, [bigDocs()[3]!], log);

      expect(encoded).toEqual([]);
      expect(warns.find((w) => w.msg === 'AI input is missing documents')!.obj).toMatchObject({
        unreadable: 1,
        eligible: 1,
        sent: 0,
      });
    });

    it('holds the budget against the bytes when the recorded size is wrong', async () => {
      // `size_bytes` is written as `plain.length` by the upload route, so the
      // two agree for every row it wrote. If one ever does not, the read's own
      // check is the authority: three documents that understate themselves as
      // 1 kB each pass the pre-check and are still cut to what fits.
      const { log } = recorder();
      const encoded = await encodeDocuments(
        sparse,
        Array.from({ length: 3 }, (_, i) =>
          doc({ id: `big${i}`, storage_path: `big${i}.bin`, size_bytes: 1024 }),
        ),
        log,
      );

      const bytes = encoded.reduce((n, e) => n + String(e.content_base64).length, 0);
      expect(bytes).toBeLessThanOrEqual(MAX_AI_REQUEST_DOCUMENT_BYTES);
      expect(encoded.map((e) => e.id)).toEqual(['big0', 'big1', 'big2']);
    });
  });
});
