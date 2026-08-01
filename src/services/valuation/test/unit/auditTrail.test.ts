import { describe, expect, it } from 'vitest';
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  EVENT_SEVERITIES,
  changeLogCsv,
  describeEvent,
  describeEventType,
  diffRecords,
  extractChanges,
  fieldHistory,
  filterAuditEntries,
  formatAuditValue,
  humanizeField,
  summarizeAuditTrail,
  summarizeChanges,
  type AuditEntry,
  type RawAuditEvent,
} from '../../src/domain/auditTrail.js';
import { EVENT_TYPES } from '../../src/domain/valuation.js';
import { PIPELINE_EVENT_TYPES } from '../../src/domain/pipeline.js';
import { ENGAGEMENT_EVENT_TYPES } from '../../src/domain/engagement.js';
import { GRANT_EVENT_TYPES } from '../../src/domain/vesting.js';
import { OPERATIONS_EVENT_TYPES } from '../../src/domain/operations.js';
import { BOARD_EVENT_TYPES } from '../../src/domain/boardResolution.js';
import { INTAKE_EVENT_TYPES } from '../../src/domain/intake.js';
import { MONITOR_EVENT_TYPES } from '../../src/domain/monitoring.js';
import { CAP_TABLE_EVENT_TYPES } from '../../src/domain/capTable.js';
import { M4_HISTORY_EVENT_TYPES } from '../../src/repos/transactions.js';

const at = (iso: string) => new Date(iso);

function event(over: Partial<RawAuditEvent> = {}): RawAuditEvent {
  return {
    id: 'evt-1',
    seq: '1',
    type: 'valuation_created',
    actor_type: 'human',
    actor_id: 'user-1',
    source: 'api',
    payload: {},
    occurred_at: at('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('EVENT_CATALOG', () => {
  it('covers every event type the platform records', () => {
    const declared = [
      ...Object.values(EVENT_TYPES),
      ...Object.values(PIPELINE_EVENT_TYPES),
      ...Object.values(ENGAGEMENT_EVENT_TYPES),
      ...Object.values(GRANT_EVENT_TYPES),
      ...Object.values(OPERATIONS_EVENT_TYPES),
      ...Object.values(BOARD_EVENT_TYPES),
      ...Object.values(INTAKE_EVENT_TYPES),
      ...Object.values(MONITOR_EVENT_TYPES),
      ...Object.values(CAP_TABLE_EVENT_TYPES),
      ...Object.values(M4_HISTORY_EVENT_TYPES),
    ];
    const missing = declared.filter((type) => !(type in EVENT_CATALOG));
    expect(missing).toEqual([]);
  });

  it('uses only known categories and severities', () => {
    for (const [type, descriptor] of Object.entries(EVENT_CATALOG)) {
      expect(EVENT_CATEGORIES, type).toContain(descriptor.category);
      expect(EVENT_SEVERITIES, type).toContain(descriptor.severity);
      expect(['client', 'internal'], type).toContain(descriptor.visibility);
      expect(descriptor.label.length, type).toBeGreaterThan(0);
    }
  });

  it('marks value-moving events critical', () => {
    for (const type of [
      'params_updated',
      'overwrite_applied',
      'cap_table_imported',
      'calculation_completed',
      'report_rendered',
    ]) {
      expect(EVENT_CATALOG[type]!.severity, type).toBe('critical');
    }
  });

  it('keeps analyst tooling internal-only', () => {
    for (const type of ['overwrite_applied', 'workbook_updated', 'report_saved', 'params_updated']) {
      expect(EVENT_CATALOG[type]!.visibility, type).toBe('internal');
    }
  });
});

describe('describeEventType', () => {
  it('returns the catalog entry for a known type', () => {
    expect(describeEventType('state_changed').label).toBe('Stage changed');
    expect(describeEventType('state_changed').category).toBe('lifecycle');
  });

  it('falls back to a safe default for unknown types', () => {
    const descriptor = describeEventType('something_new_we_added');
    expect(descriptor.category).toBe('other');
    expect(descriptor.severity).toBe('info');
    expect(descriptor.visibility).toBe('internal');
  });
});

describe('diffRecords', () => {
  it('reports only changed allow-listed columns', () => {
    const changes = diffRecords(
      { dlom: '0.20', dloc: '0.05', secret: 'a' },
      { dlom: '0.22', dloc: '0.05', secret: 'b' },
      ['dlom', 'dloc'],
    );
    expect(changes).toEqual({ dlom: { from: '0.20', to: '0.22' } });
  });

  it('ignores columns absent from the patch', () => {
    expect(diffRecords({ dlom: '0.20' }, {}, ['dlom'])).toEqual({});
  });

  it('normalises a missing previous value to null', () => {
    expect(diffRecords({}, { dlom: '0.22' }, ['dlom'])).toEqual({
      dlom: { from: null, to: '0.22' },
    });
  });

  it('treats an explicit null as a real change from a value', () => {
    expect(diffRecords({ dlom: '0.20' }, { dlom: null }, ['dlom'])).toEqual({
      dlom: { from: '0.20', to: null },
    });
  });

  it('returns an empty diff when nothing moved', () => {
    expect(diffRecords({ a: 1, b: 2 }, { a: 1, b: 2 }, ['a', 'b'])).toEqual({});
  });
});

describe('extractChanges', () => {
  it('flattens a { changes } payload', () => {
    const changes = extractChanges('params_updated', {
      changes: { dlom: { from: '0.20', to: '0.22' }, dloc: { from: null, to: '0.05' } },
    });
    expect(changes).toEqual([
      { field: 'dlom', from: '0.20', to: '0.22' },
      { field: 'dloc', from: null, to: '0.05' },
    ]);
  });

  it('reads state_changed as a change to the state field', () => {
    expect(extractChanges('state_changed', { from: 'review', to: 'drafted' })).toEqual([
      { field: 'state', from: 'review', to: 'drafted' },
    ]);
  });

  it('labels a bare from/to on other event types generically', () => {
    expect(extractChanges('revenue_change', { from: 100, to: 200 })).toEqual([
      { field: 'value', from: 100, to: 200 },
    ]);
  });

  it('namespaces auto-applied engine inputs', () => {
    expect(extractChanges('params_updated', { engine_inputs_applied: { volatility: 0.6 } })).toEqual([
      { field: 'engine_inputs.volatility', from: null, to: 0.6 },
    ]);
  });

  it('falls back to field names when only names were recorded', () => {
    expect(extractChanges('grant_updated', { grant_id: 'g1', fields: ['shares', 'strike'] })).toEqual([
      { field: 'shares', from: null, to: null },
      { field: 'strike', from: null, to: null },
    ]);
  });

  it('returns nothing for payloads with no change information', () => {
    expect(extractChanges('ai_job_completed', { pipeline: 'extract' })).toEqual([]);
  });

  it('handles a null payload defensively', () => {
    expect(extractChanges('valuation_created', {})).toEqual([]);
  });

  it('does not treat an array under changes as a change map', () => {
    expect(extractChanges('valuation_updated', { changes: ['a', 'b'] })).toEqual([]);
  });
});

describe('humanizeField', () => {
  it('title-cases snake_case names', () => {
    expect(humanizeField('company_name')).toBe('Company name');
  });

  it('upper-cases known acronyms', () => {
    expect(humanizeField('dlom')).toBe('DLOM');
    expect(humanizeField('dlom_method')).toBe('DLOM method');
  });

  it('drops the _cents storage suffix', () => {
    expect(humanizeField('ytd_revenue_cents')).toBe('YTD revenue');
  });

  it('uses the leaf of a namespaced field', () => {
    expect(humanizeField('engine_inputs.volatility')).toBe('Volatility');
  });
});

describe('formatAuditValue', () => {
  it('renders empties as a dash', () => {
    expect(formatAuditValue(null)).toBe('—');
    expect(formatAuditValue(undefined)).toBe('—');
    expect(formatAuditValue('')).toBe('—');
  });

  it('renders booleans as yes/no', () => {
    expect(formatAuditValue(true)).toBe('yes');
    expect(formatAuditValue(false)).toBe('no');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(200);
    const out = formatAuditValue(long);
    expect(out.length).toBe(78);
    expect(out.endsWith('…')).toBe(true);
  });

  it('summarises arrays by length', () => {
    expect(formatAuditValue([1, 2, 3])).toBe('3 items');
    expect(formatAuditValue([1])).toBe('1 item');
  });

  it('does not leak object internals', () => {
    expect(formatAuditValue({ secret: 'value' })).toBe('updated');
  });
});

describe('summarizeChanges', () => {
  it('renders from → to for each change', () => {
    expect(summarizeChanges([{ field: 'dlom', from: '0.20', to: '0.22' }])).toBe('DLOM: 0.20 → 0.22');
  });

  it('renders a set for first-time values', () => {
    expect(summarizeChanges([{ field: 'dloc', from: null, to: '0.05' }])).toBe('DLOC set to 0.05');
  });

  it('renders bare field names when no values were recorded', () => {
    expect(summarizeChanges([{ field: 'shares', from: null, to: null }])).toBe('Shares');
  });

  it('caps the list and counts the remainder', () => {
    const changes = ['a', 'b', 'c', 'd', 'e'].map((f) => ({ field: f, from: 1, to: 2 }));
    expect(summarizeChanges(changes)).toContain('(+2 more)');
  });

  it('is empty for no changes', () => {
    expect(summarizeChanges([])).toBe('');
  });
});

describe('describeEvent', () => {
  it('enriches a raw event with catalog metadata and changes', () => {
    const enriched = describeEvent(
      event({
        type: 'params_updated',
        payload: { changes: { dlom: { from: '0.20', to: '0.22' } } },
      }),
    );
    expect(enriched.label).toBe('Methodology parameters changed');
    expect(enriched.category).toBe('methodology');
    expect(enriched.severity).toBe('critical');
    expect(enriched.visibility).toBe('internal');
    expect(enriched.changes).toHaveLength(1);
    expect(enriched.summary).toBe('DLOM: 0.20 → 0.22');
  });

  it('preserves identity and actor fields', () => {
    const enriched = describeEvent(event({ id: 'evt-9', seq: '42', actor_type: 'ai' }));
    expect(enriched.id).toBe('evt-9');
    expect(enriched.seq).toBe('42');
    expect(enriched.actor_type).toBe('ai');
  });
});

// ── Filtering / roll-up over a small synthetic trail ───────────────────────

const TRAIL: AuditEntry[] = [
  describeEvent(
    event({ id: 'e1', seq: '1', type: 'valuation_created', occurred_at: at('2026-01-01T00:00:00Z') }),
  ),
  describeEvent(
    event({
      id: 'e2',
      seq: '2',
      type: 'params_updated',
      actor_type: 'human',
      occurred_at: at('2026-01-02T00:00:00Z'),
      payload: { changes: { dlom: { from: '0.20', to: '0.22' } } },
    }),
  ),
  describeEvent(
    event({
      id: 'e3',
      seq: '3',
      type: 'calculation_completed',
      actor_type: 'engine',
      occurred_at: at('2026-01-03T00:00:00Z'),
    }),
  ),
  describeEvent(
    event({
      id: 'e4',
      seq: '4',
      type: 'params_updated',
      actor_type: 'human',
      occurred_at: at('2026-01-04T00:00:00Z'),
      payload: { changes: { dlom: { from: '0.22', to: '0.25' } } },
    }),
  ),
];

describe('filterAuditEntries', () => {
  it('hides internal events from non-ops callers', () => {
    const visible = filterAuditEntries(TRAIL, { includeInternal: false });
    expect(visible.map((e) => e.type)).toEqual(['calculation_completed', 'valuation_created']);
  });

  it('returns everything for ops', () => {
    expect(filterAuditEntries(TRAIL, { includeInternal: true })).toHaveLength(4);
  });

  it('sorts newest first', () => {
    const all = filterAuditEntries(TRAIL, { includeInternal: true });
    expect(all.map((e) => e.id)).toEqual(['e4', 'e3', 'e2', 'e1']);
  });

  it('filters by category', () => {
    const methodology = filterAuditEntries(TRAIL, {
      includeInternal: true,
      category: 'methodology',
    });
    expect(methodology).toHaveLength(2);
  });

  it('filters by severity', () => {
    const critical = filterAuditEntries(TRAIL, { includeInternal: true, severity: 'critical' });
    expect(critical.every((e) => e.severity === 'critical')).toBe(true);
    expect(critical).toHaveLength(3);
  });

  it('filters by actor type', () => {
    expect(filterAuditEntries(TRAIL, { includeInternal: true, actorType: 'engine' })).toHaveLength(1);
  });

  it('filters by changed field', () => {
    expect(filterAuditEntries(TRAIL, { includeInternal: true, field: 'dlom' })).toHaveLength(2);
    expect(filterAuditEntries(TRAIL, { includeInternal: true, field: 'nope' })).toHaveLength(0);
  });

  it('filters by date window inclusively', () => {
    const window = filterAuditEntries(TRAIL, {
      includeInternal: true,
      from: at('2026-01-02T00:00:00Z'),
      to: at('2026-01-03T00:00:00Z'),
    });
    expect(window.map((e) => e.id)).toEqual(['e3', 'e2']);
  });

  it('combines filters conjunctively', () => {
    const out = filterAuditEntries(TRAIL, {
      includeInternal: true,
      category: 'methodology',
      from: at('2026-01-03T00:00:00Z'),
    });
    expect(out.map((e) => e.id)).toEqual(['e4']);
  });
});

describe('summarizeAuditTrail', () => {
  it('counts by category, severity and actor', () => {
    const summary = summarizeAuditTrail(TRAIL);
    expect(summary.total).toBe(4);
    expect(summary.by_category['methodology']).toBe(2);
    expect(summary.by_severity['critical']).toBe(3);
    expect(summary.by_actor_type['engine']).toBe(1);
    expect(summary.critical_changes).toBe(3);
  });

  it('lists the distinct changed fields sorted', () => {
    expect(summarizeAuditTrail(TRAIL).changed_fields).toEqual(['dlom']);
  });

  it('reports the first and last timestamps', () => {
    const summary = summarizeAuditTrail(TRAIL);
    expect(summary.first_at?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.last_at?.toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });

  it('handles an empty trail', () => {
    const summary = summarizeAuditTrail([]);
    expect(summary).toMatchObject({ total: 0, critical_changes: 0, first_at: null, last_at: null });
    expect(summary.changed_fields).toEqual([]);
  });
});

describe('fieldHistory', () => {
  it('returns every change to one field, newest first', () => {
    const history = fieldHistory(TRAIL, 'dlom');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ from: '0.22', to: '0.25', actor_type: 'human' });
    expect(history[1]).toMatchObject({ from: '0.20', to: '0.22' });
  });

  it('is empty for a field that never changed', () => {
    expect(fieldHistory(TRAIL, 'dloc')).toEqual([]);
  });

  it('carries the originating event type', () => {
    expect(fieldHistory(TRAIL, 'dlom')[0]!.type).toBe('params_updated');
  });
});

describe('changeLogCsv', () => {
  const header =
    'occurred_at,seq,event_type,event,category,severity,actor_type,actor_id,source,field,field_label,from,to';

  it('emits a header even with no entries', () => {
    expect(changeLogCsv([]).trim()).toBe(header);
  });

  it('writes one row per changed field, not per event', () => {
    const multi = describeEvent(
      event({
        type: 'params_updated',
        payload: {
          changes: { dlom: { from: '0.20', to: '0.22' }, dloc: { from: null, to: '0.05' } },
        },
      }),
    );
    const rows = changeLogCsv([multi]).trim().split('\r\n');
    expect(rows).toHaveLength(3); // header + two changes
    expect(rows[1]).toContain('dlom');
    expect(rows[2]).toContain('dloc');
  });

  it('skips events that changed nothing', () => {
    const noChange = describeEvent(event({ type: 'ai_job_completed', payload: { pipeline: 'qa' } }));
    expect(changeLogCsv([noChange]).trim()).toBe(header);
  });

  it('carries the catalog metadata onto every row', () => {
    const row = changeLogCsv(TRAIL).trim().split('\r\n')[1]!;
    expect(row).toContain('params_updated');
    expect(row).toContain('methodology');
    expect(row).toContain('critical');
  });

  it('includes both the raw field and its human label', () => {
    const row = changeLogCsv(TRAIL)
      .trim()
      .split('\r\n')
      .find((r) => r.includes(',dlom,'))!;
    expect(row).toContain(',dlom,');
    expect(row).toContain('DLOM');
  });

  it('renders an absent previous value as a dash rather than blank', () => {
    const first = describeEvent(
      event({ type: 'params_updated', payload: { changes: { dlom: { from: null, to: '0.22' } } } }),
    );
    expect(changeLogCsv([first])).toContain('—');
  });

  it('quotes a value containing a comma so columns do not shift', () => {
    const comma = describeEvent(
      event({
        type: 'valuation_updated',
        payload: { changes: { company_name: { from: 'Acme', to: 'Acme, Inc.' } } },
      }),
    );
    expect(changeLogCsv([comma])).toContain('"Acme, Inc."');
  });

  it('neutralises a value that would be read as a spreadsheet formula', () => {
    const formula = describeEvent(
      event({
        type: 'valuation_updated',
        payload: { changes: { company_name: { from: 'Acme', to: '=cmd|calc' } } },
      }),
    );
    const csv = changeLogCsv([formula]);
    expect(csv).not.toMatch(/,=cmd/);
    expect(csv).toContain("'=cmd");
  });

  it('emits CRLF line endings per RFC 4180', () => {
    expect(changeLogCsv(TRAIL)).toContain('\r\n');
  });
});
