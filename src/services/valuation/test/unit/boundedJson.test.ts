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
