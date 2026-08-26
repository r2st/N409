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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDocuments } from '../../src/routes/ai.js';

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
  return {
    warns,
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => void warns.push({ obj, msg }),
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

  it('works without a logger, which is what the many test call sites pass', async () => {
    await expect(encodeDocuments(dir, [doc({ id: 'gone', storage_path: 'missing.bin' })])).resolves.toEqual(
      [],
    );
  });
});
