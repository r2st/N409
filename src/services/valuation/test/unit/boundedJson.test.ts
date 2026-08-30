import { describe, expect, it } from 'vitest';
import { boundedJson, MAX_DEPTH, MAX_ITEMS, MAX_STRING } from '../../src/domain/boundedJson.js';

/**
 * The bound exists so `network_items` cannot outgrow the data it describes.
 * What it must never do is drop something silently: a list cut to fifty
 * elements with no marker reads as a list that had fifty, which would have a
 * reader concluding we sent the engine a short cap table.
 */
describe('boundedJson', () => {
  it('passes small payloads through unchanged', () => {
    const payload = {
      params: { allocation_method: 'opm', weight_market: 0.4 },
      inputs: { shares_outstanding_common: 8_000_000, share_classes: [{ name: 'A', pref: 1 }] },
    };
    expect(boundedJson(payload)).toEqual(payload);
  });

  it('is a detached copy, so a later mutation cannot rewrite what was recorded', () => {
    const payload = { inputs: { volatility: 0.6 } };
    const copy = boundedJson(payload) as typeof payload;
    payload.inputs.volatility = 999;
    expect(copy.inputs.volatility).toBe(0.6);
  });

  describe('nothing is dropped silently', () => {
    it('keeps the head of a long list and says how much was left', () => {
      const periods = Array.from({ length: MAX_ITEMS + 12 }, (_, i) => ({ period: i }));
      const out = boundedJson(periods) as unknown[];
      expect(out).toHaveLength(MAX_ITEMS + 1);
      expect(out[0]).toEqual({ period: 0 });
      expect(out[MAX_ITEMS]).toEqual({ __truncated__: '12 more items' });
    });

    it('summarises an object past the depth limit rather than copying it', () => {
      // One level deeper than the walk allows.
      let deep: unknown = { a: 1, b: 2 };
      for (let i = 0; i < MAX_DEPTH; i++) deep = { nest: deep };
      const out = JSON.stringify(boundedJson(deep));
      expect(out).toContain('__truncated__');
      expect(out).toContain('2 keys');
    });

    it('cuts a long string and counts the characters it cut', () => {
      const body = 'x'.repeat(MAX_STRING + 40);
      expect(boundedJson(body)).toBe(`${'x'.repeat(MAX_STRING)}… [40 more characters]`);
    });

    it('keeps a string exactly at the limit whole', () => {
      const body = 'x'.repeat(MAX_STRING);
      expect(boundedJson(body)).toBe(body);
    });

    it('marks the keys it dropped from a very wide object', () => {
      const wide = Object.fromEntries(Array.from({ length: MAX_ITEMS + 3 }, (_, i) => [`k${i}`, i]));
      const out = boundedJson(wide) as Record<string, unknown>;
      expect(out.__truncated__).toBe('3 more keys');
      expect(Object.keys(out)).toHaveLength(MAX_ITEMS + 1);
    });
  });

  describe('it runs on the failure path, so it cannot be the thing that throws', () => {
    it('cuts a cycle instead of overflowing the stack', () => {
      const cyclic: Record<string, unknown> = { name: 'engine compute' };
      cyclic.self = cyclic;
      const out = boundedJson(cyclic) as Record<string, unknown>;
      expect(out.name).toBe('engine compute');
      expect(out.self).toEqual({ __truncated__: 'circular reference' });
    });

    it('copies a value repeated across siblings both times — only a loop is a cycle', () => {
      // The same object referenced twice is not a cycle, and reporting it as
      // one would blank half of any payload that shares a share-class record.
      const shared = { name: 'Series A' };
      const out = boundedJson({ left: shared, right: shared }) as Record<string, unknown>;
      expect(out.left).toEqual({ name: 'Series A' });
      expect(out.right).toEqual({ name: 'Series A' });
    });

    it('records a non-finite number as null rather than emitting invalid JSON', () => {
      const out = boundedJson({ fmv: Number.NaN, equity: Infinity, ok: 1.5 });
      expect(out).toEqual({ fmv: null, equity: null, ok: 1.5 });
    });

    it('produces something JSON.stringify always accepts', () => {
      const hostile: Record<string, unknown> = {
        when: new Date('2026-01-02T03:04:05.000Z'),
        big: 10n,
        fn: () => 1,
        sym: Symbol('s'),
        nested: [Number.NaN, undefined, null],
      };
      hostile.loop = hostile;
      const json = JSON.stringify(boundedJson(hostile));
      expect(JSON.parse(json)).toMatchObject({
        when: '2026-01-02T03:04:05.000Z',
        big: '10',
        nested: [null, null, null],
      });
    });
  });
});

/**
 * R217, methodology M6: the one thing this function promises about the write.
 *
 * The bounds keep the row small and the `null` for a non-finite number keeps
 * the insert from failing. An unpaired surrogate defeats the second: Postgres
 * refuses an unpaired `\ud800` escape, and `recordNetworkItem` swallows the
 * error — so the whole trace is lost, silently, on the failure path.
 */
describe('a string the JSONB insert can hold', () => {
  const GRIN = '\u{1F600}';

  it('does not cut an emoji in half at MAX_STRING', () => {
    // 1,999 characters then an emoji: the old `slice` landed between its halves.
    const out = boundedJson('a'.repeat(1_999) + GRIN + 'b'.repeat(100)) as string;
    expect(JSON.stringify(out).includes('\\ud')).toBe(false);
    expect(out).toContain('more characters');
  });

  it('never emits an unpaired surrogate at any offset around the bound', () => {
    for (let pad = 1_996; pad <= 2_002; pad++) {
      const out = boundedJson('a'.repeat(pad) + GRIN + 'tail') as string;
      expect(JSON.stringify(out).includes('\\ud'), `pad ${pad}`).toBe(false);
    }
  });

  it('replaces a half-character already in the payload rather than losing the row', () => {
    // Unlike a request body, where the name is refused rather than edited: this
    // is a diagnostic copy of something already sent, and U+FFFD beats no log.
    const out = boundedJson({ body: `Acme\uD800 Ltd` }) as { body: string };
    expect(out.body).toBe('Acme� Ltd');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('leaves whole astral characters exactly as they were', () => {
    const value = `${GRIN} 𠮷野家 𝄞 🇬🇧`;
    expect(boundedJson({ value })).toEqual({ value });
  });
});

describe('a diagnostic row is not a second copy of the client documents', () => {
  it('records the size of a document body, never its bytes', () => {
    const body = Buffer.from('OFFER LETTER — Ada Lovelace, 250,000 options').toString('base64');
    const out = boundedJson({
      valuation: { company_name: 'Zephyr Dynamics, Inc.' },
      documents: [{ id: 'd1', filename: 'Cap Table.xlsx', kind: 'cap_table', content_base64: body }],
    }) as { documents: Array<Record<string, unknown>> };
    const doc = out.documents[0]!;
    // Which document went in, still answerable.
    expect(doc.id).toBe('d1');
    expect(doc.filename).toBe('Cap Table.xlsx');
    expect(doc.content_type).toBeUndefined();
    // Its contents, not stored, and not silently either.
    expect(doc.content_base64).toEqual({ __truncated__: `content_base64, ${body.length} characters` });
    expect(JSON.stringify(out)).not.toContain(body.slice(0, 40));
  });

  it('records the size of pasted client text the same way', () => {
    // The `/ai/anonymize` body: up to 200,000 characters an operator pasted out
    // of a client's spreadsheet, which the 2,000-char bound made shorter and
    // did not make anonymous.
    const out = boundedJson({ text: 'Ada Lovelace holds 2,000,000 shares', document_ids: ['d1'] }) as Record<
      string,
      unknown
    >;
    expect(out.text).toEqual({ __truncated__: 'text, 35 characters' });
    expect(out.document_ids).toEqual(['d1']);
  });

  it('leaves a field of the same name that is not a body alone', () => {
    // The rule is about a string somebody typed or uploaded. A structured value
    // under one of these names is something else, and reporting a length for it
    // would be a claim about a value this was not written for.
    expect(boundedJson({ text: { blocks: 2 } })).toEqual({ text: { blocks: 2 } });
  });
});
