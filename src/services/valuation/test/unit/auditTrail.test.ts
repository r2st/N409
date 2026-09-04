import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  EVENT_SEVERITIES,
  changeLogCsv,
  describeEvent,
  describeEventType,
  eventLabel,
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

  /**
   * The event the census above could not see.
   *
   * `repos/pipelineRuns.ts` chooses its type inline — `status === 'ready' ?
   * 'auto_pipeline_completed' : 'auto_pipeline_failed'` — so neither literal
   * appears in a `*_EVENT_TYPES` map and neither was ever compared against the
   * catalog. Three of the four `auto_pipeline_*` types had been added by hand
   * and the fourth had not, which is exactly the shape a hand-kept list fails
   * in: the omission is invisible next to its named siblings.
   */
  it('describes the end of an automated pipeline run', () => {
    for (const type of ['auto_pipeline_started', 'auto_pipeline_completed', 'auto_pipeline_failed']) {
      expect(describeEventType(type).label, type).not.toBe('Event recorded');
      expect(describeEventType(type).category, type).toBe('analysis');
    }
  });

  /**
   * What stops the next one, and the only part of it a runtime test can reach.
   *
   * `recordEvent` takes `ValuationEventType` — the catalog's own key union —
   * so a write of an uncatalogued type is a compile error at the line that
   * writes it. The guarantee lives in the type annotation, and a widening of
   * that annotation back to `string` would restore the old silence without
   * failing a single assertion. So the annotation itself is asserted.
   */
  it('accepts only catalogued types at the write site', () => {
    const source = readFileSync(new URL('../../src/events/record.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/type:\s*ValuationEventType;/);
    // And the union is a union: annotating the catalog as
    // `Record<string, EventDescriptor>` would make `keyof` collapse to
    // `string`, which compiles and checks nothing.
    const catalog = readFileSync(new URL('../../src/domain/auditTrail.ts', import.meta.url), 'utf8');
    expect(catalog).toMatch(/\}\s*satisfies Record<string, EventDescriptor>;/);
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

describe('eventLabel', () => {
  it('uses the catalog for a type it knows', () => {
    expect(eventLabel('state_changed')).toBe('Stage changed');
    expect(eventLabel('report_rendered')).toBe('Report generated');
  });

  it('uses the admin catalog for an admin type', () => {
    // The feeds union both tables and name their rows from one function.
    // `partner_created` happens to word-split to the same string; the two below
    // do not, which is what having the catalog buys.
    expect(eventLabel('partner_created')).toBe('Partner created');
    expect(eventLabel('user_promoted')).toBe('Role granted');
    expect(eventLabel('comparables_ai_applied')).toBe('AI comparables applied');
  });

  /**
   * The spine is append-only and older rows carry types this build has since
   * renamed. `describeEventType`'s "Event recorded" would be a step down from
   * the raw type for those rows, so the fallback here word-splits instead —
   * the same derivation `humanizeField` applies to field names, initialisms
   * included.
   */
  it('word-splits a type neither catalog carries', () => {
    expect(eventLabel('retired_thing_happened')).toBe('Retired thing happened');
    expect(eventLabel('ai_prompt_updated')).toBe('AI prompt updated');
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

  /*
   * R387, methodology M19. `deleteOrganization` writes every engagement the
   * holding company held a `portfolio_membership_changed` whose change list is
   * character for character the one a person removing a single engagement from
   * a roll-up produces. R384 saw that and put `organization_deleted: true`
   * beside `changes` — deliberately outside it, because nothing moved from one
   * value to another — and nothing read the flag, so the distinction it was
   * written for reached no reader.
   */
  const dissolution = () =>
    describeEvent(
      event({
        type: 'portfolio_membership_changed',
        payload: {
          changes: { organization_id: { from: '01H8XYZ', to: null } },
          organization_deleted: true,
        },
      }),
    );

  it('says the organization was dissolved, not just that the membership moved', () => {
    const enriched = dissolution();
    expect(enriched.note).toBe(
      'The organization was deleted; every engagement it held returned to standalone.',
    );
    expect(enriched.summary).toBe(
      'The organization was deleted; every engagement it held returned to standalone. ' +
        'Organization ID: 01H8XYZ → —',
    );
  });

  it('leaves the same change list unannotated when one engagement was detached', () => {
    // The discriminator: an unconditional note would be indistinguishable from
    // no note at all, and this is the row it has to differ from.
    const enriched = describeEvent(
      event({
        type: 'portfolio_membership_changed',
        payload: { changes: { organization_id: { from: '01H8XYZ', to: null } } },
      }),
    );
    expect(enriched.note).toBeNull();
    expect(enriched.summary).toBe('Organization ID: 01H8XYZ → —');
  });

  it('ignores a context flag that is present and not true', () => {
    const enriched = describeEvent(
      event({ type: 'portfolio_membership_changed', payload: { organization_deleted: false } }),
    );
    expect(enriched.note).toBeNull();
  });

  /*
   * R389, methodology M4. The census over the shape R387 named — a flag written
   * beside `changes` so a reader could tell two rows apart — found four more,
   * and each is the same failure: a sweep writing the event a person writes.
   */

  it('says a released engagement was released, not unassigned by hand', () => {
    // `releaseAssignedWork`'s change list is the one `patchValuation` writes
    // when an operator clears the reviewer themselves. The whole difference is
    // `reason`.
    const enriched = describeEvent(
      event({
        type: 'valuation_updated',
        payload: {
          changes: { assigned_reviewer_id: { from: '01HUSER', to: null } },
          reason: 'account_closed',
        },
      }),
    );
    expect(enriched.note).toBe('Released automatically when the account holding this work was closed.');
    expect(enriched.summary).toBe(
      'Released automatically when the account holding this work was closed. ' +
        'Assigned reviewer ID: 01HUSER → —',
    );
  });

  it('leaves the same change list unannotated when an operator cleared the reviewer', () => {
    const enriched = describeEvent(
      event({
        type: 'valuation_updated',
        payload: { changes: { assigned_reviewer_id: { from: '01HUSER', to: null } } },
      }),
    );
    expect(enriched.note).toBeNull();
  });

  it('states both halves of a reaped run: what ended it, and what is coming back', () => {
    // `reaped` alone "reads as an ending either way" — R268's reason for
    // putting `retry_scheduled` on the spine beside it. A note that stopped at
    // the first match would publish half the pair.
    const enriched = describeEvent(
      event({
        type: 'auto_pipeline_failed',
        payload: { run_id: '01HRUN', error: 'run exceeded 900s', reaped: true, retry_scheduled: true },
      }),
    );
    expect(enriched.note).toBe(
      'Abandoned by the stale-work sweep after passing its deadline; no worker reported this ending. ' +
        'Another attempt is scheduled.',
    );
  });

  it('says when a reaped run has run out of attempts', () => {
    const enriched = describeEvent(
      event({ type: 'auto_pipeline_failed', payload: { reaped: true, retry_scheduled: false } }),
    );
    expect(enriched.note).toBe(
      'Abandoned by the stale-work sweep after passing its deadline; no worker reported this ending. ' +
        'No further attempt is scheduled.',
    );
  });

  it('tells a board re-send from the first ask, and says the old link is dead', () => {
    // R396 wrote `resent` because "a re-send is not a repetition: it mints a
    // new token and kills the link the previous message carried". It declared
    // no note, so both sends rendered as the same line for four rounds.
    const resent = describeEvent(
      event({
        type: 'board_resolution_sent',
        payload: { resolution_id: '01HRES', signoff_id: '01HSIG', resent: true },
      }),
    );
    expect(resent.note).toBe(
      'A re-send: a new signing link was issued and the link in the previous message stopped working.',
    );
    const first = describeEvent(
      event({
        type: 'board_resolution_sent',
        payload: { resolution_id: '01HRES', signoff_id: '01HSIG', resent: false },
      }),
    );
    // The false arm is not filler: this event repeats per director, and which
    // of the two a given line is is the reader's whole question.
    expect(first.note).toBe('The first time this director was asked to sign.');
    expect(resent.summary).not.toBe(first.summary);
  });

  it('leaves a failure a worker actually reported unannotated', () => {
    const enriched = describeEvent(
      event({ type: 'auto_pipeline_failed', payload: { run_id: '01HRUN', error: 'extraction failed' } }),
    );
    expect(enriched.note).toBeNull();
  });

  it('tells a retry sweep start from an upload', () => {
    const requeued = describeEvent(
      event({ type: 'auto_pipeline_started', payload: { run_id: '01HRUN', trigger: 'upload', retry: true } }),
    );
    expect(requeued.note).toBe('Started by the retry sweep, not by an upload or an operator.');
    const first = describeEvent(
      event({ type: 'auto_pipeline_started', payload: { run_id: '01HRUN', trigger: 'upload' } }),
    );
    expect(first.note).toBeNull();
  });

  it('names why an owed retry was stood down', () => {
    const enriched = describeEvent(
      event({
        type: 'auto_pipeline_retry_abandoned',
        payload: { run_id: '01HRUN', reason: 'newer_run_active', attempts: 2 },
      }),
    );
    expect(enriched.note).toBe(
      'A newer run had already started for this engagement, so the outstanding retry was stood down.',
    );
  });

  it('says nothing for a reason it has no words for', () => {
    // The value-keyed form is an allow-list. An undeclared reason is silent
    // rather than rendered raw: the notes are sentences written for a reader,
    // not a payload field echoed back.
    const enriched = describeEvent(
      event({ type: 'valuation_updated', payload: { reason: 'something_else' } }),
    );
    expect(enriched.note).toBeNull();
  });

  it('does not let one event type answer for another type\u2019s flag', () => {
    // `applyOverwrite` puts the analyst's own typed justification on the
    // payload under `reason`. Flag-keyed, this row would have been annotated
    // with a sentence about an account closure that did not happen, on the
    // audit trail's own authority.
    const enriched = describeEvent(
      event({
        type: 'overwrite_applied',
        payload: { field_key: 'dlom', from: 0.2, to: 0.25, reason: 'account_closed' },
      }),
    );
    expect(enriched.note).toBeNull();
    expect(enriched.summary).toBe('Value: 0.2 \u2192 0.25');
  });

  it('renders a document re-file as the two pairs it is', () => {
    const enriched = describeEvent({
      ...event({ type: 'document_refiled' }),
      payload: {
        document_id: '01HDOC',
        filename: 'Board Consent March.pdf',
        changes: {
          category: { from: 'uploads', to: 'board_resolutions' },
          kind: { from: 'other', to: 'board_consent' },
        },
      },
    });
    expect(enriched.summary).toBe(
      'Category: uploads \u2192 board_resolutions, Kind: other \u2192 board_consent',
    );
  });

  it('says which way a pipeline toggle went', () => {
    // Not a circumstance — a value that moved, and therefore a change list.
    // `{ enabled: false }` reached the trail as a bare label, on the one row
    // where the direction is the entire content of the event.
    const enriched = describeEvent({
      ...event({ type: 'auto_pipeline_toggled' }),
      payload: { changes: { auto_pipeline: { from: true, to: false } } },
    });
    expect(enriched.summary).toBe('Auto pipeline: yes \u2192 no');
  });

  it('does not resolve a payload value up the prototype chain', () => {
    // The payload is `jsonb` read back off the spine. `reason: 'constructor'`
    // indexes a value-keyed map at a key every object has, and `toString` on
    // the type-keyed one above it.
    expect(
      describeEvent(event({ type: 'valuation_updated', payload: { reason: 'constructor' } })).note,
    ).toBeNull();
    expect(describeEvent(event({ type: 'toString', payload: { reason: 'account_closed' } })).note).toBeNull();
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
    'occurred_at,seq,event_type,event,category,severity,actor_type,actor_id,source,field,field_label,from,to,note';

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

  it('carries the circumstance into the file, not only onto the screen', () => {
    // The export is where an auditor asks the question the note answers, and
    // it was the surface that could not answer it: this change list and the
    // one below are identical.
    const dissolved = describeEvent(
      event({
        type: 'portfolio_membership_changed',
        payload: {
          changes: { organization_id: { from: '01H8XYZ', to: null } },
          organization_deleted: true,
        },
      }),
    );
    const detached = describeEvent(
      event({
        type: 'portfolio_membership_changed',
        payload: { changes: { organization_id: { from: '01H8XYZ', to: null } } },
      }),
    );
    const rows = changeLogCsv([dissolved, detached]).trim().split('\r\n');
    expect(rows[1]).toContain(
      ',The organization was deleted; every engagement it held returned to standalone.',
    );
    expect(rows[2]!.endsWith(',')).toBe(true);
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
