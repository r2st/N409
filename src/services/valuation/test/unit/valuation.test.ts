import { describe, expect, it } from 'vitest';
import {
  VALUATION_KINDS,
  VALUATION_STATES,
  VALUATION_SOURCES,
  EVENT_TYPES,
} from '../../src/domain/valuation.js';

describe('VALUATION_KINDS', () => {
  it('includes core 409a type', () => {
    expect(VALUATION_KINDS).toContain('409a');
  });

  it('includes all expected valuation types', () => {
    const expected = ['409a', 'fmv', '718', '820', 'debt', 'fund', 'ip'];
    for (const kind of expected) {
      expect(VALUATION_KINDS).toContain(kind);
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(VALUATION_KINDS);
    expect(unique.size).toBe(VALUATION_KINDS.length);
  });

  it('all entries are lowercase strings', () => {
    for (const kind of VALUATION_KINDS) {
      expect(kind).toBe(kind.toLowerCase());
    }
  });
});

describe('VALUATION_STATES', () => {
  it('starts with pending and includes published', () => {
    expect(VALUATION_STATES[0]).toBe('pending');
    expect(VALUATION_STATES).toContain('published');
  });

  it('contains terminal halted states', () => {
    expect(VALUATION_STATES).toContain('cancelled');
    expect(VALUATION_STATES).toContain('timeout');
    expect(VALUATION_STATES).toContain('ignored');
  });

  it('has no duplicates', () => {
    const unique = new Set(VALUATION_STATES);
    expect(unique.size).toBe(VALUATION_STATES.length);
  });

  it('contains the draft workflow cycle', () => {
    expect(VALUATION_STATES).toContain('drafted');
    expect(VALUATION_STATES).toContain('draft_changes');
    expect(VALUATION_STATES).toContain('draft_accepted');
  });
});

describe('VALUATION_SOURCES', () => {
  it('contains expected lead sources', () => {
    expect(VALUATION_SOURCES).toContain('partner');
    expect(VALUATION_SOURCES).toContain('referral');
    expect(VALUATION_SOURCES).toContain('ads');
    expect(VALUATION_SOURCES).toContain('repeat');
  });

  it('has no duplicates', () => {
    const unique = new Set(VALUATION_SOURCES);
    expect(unique.size).toBe(VALUATION_SOURCES.length);
  });
});

describe('EVENT_TYPES', () => {
  it('maps lifecycle events to string constants', () => {
    expect(EVENT_TYPES.created).toBe('valuation_created');
    expect(EVENT_TYPES.updated).toBe('valuation_updated');
    expect(EVENT_TYPES.stateChanged).toBe('state_changed');
  });

  it('maps M2 output events', () => {
    expect(EVENT_TYPES.overwriteApplied).toBe('overwrite_applied');
    expect(EVENT_TYPES.overwriteReverted).toBe('overwrite_reverted');
    expect(EVENT_TYPES.reportSaved).toBe('report_saved');
    expect(EVENT_TYPES.reportRendered).toBe('report_rendered');
  });

  it('all values are unique strings', () => {
    const values = Object.values(EVENT_TYPES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) expect(typeof v).toBe('string');
  });
});
