import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_VARIABLES,
  collectPlaceholders,
  previewTemplate,
  sampleTemplateVars,
  unknownPlaceholders,
} from '../../src/domain/templateVariables.js';
import {
  TEMPLATE_CATEGORIES,
  renderTemplate,
  valuationTemplateVars,
} from '../../src/domain/communications.js';

describe('template variable catalog', () => {
  it('declares each variable once, with a sample', () => {
    const names = TEMPLATE_VARIABLES.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of TEMPLATE_VARIABLES) {
      expect(v.sample, `${v.name} has no sample`).toBeTruthy();
      expect(v.description.length, `${v.name} has no description`).toBeGreaterThan(10);
    }
  });

  it('collects placeholders across subject and body, in first-seen order', () => {
    expect(collectPlaceholders('Hi {{recipient_name}}', 'Your {{kind_label}} for {{company_name}}')).toEqual([
      'recipient_name',
      'kind_label',
      'company_name',
    ]);
  });

  it('reports a placeholder nothing will ever supply', () => {
    // The whole reason the catalog exists: renderTemplate leaves an unknown
    // name verbatim at send time, and the first report of that is the client
    // who received it.
    expect(unknownPlaceholders('Hi {{company_nmae}}')).toEqual(['company_nmae']);
    expect(unknownPlaceholders('Hi {{company_name}}')).toEqual([]);
  });

  it('does not mistake a known variable for an unknown one', () => {
    for (const v of TEMPLATE_VARIABLES) {
      expect(unknownPlaceholders(`{{${v.name}}}`), `${v.name} reported unknown`).toEqual([]);
    }
  });

  it('renders every declared variable from the samples alone', () => {
    // A preview that leaves braces on screen tells an operator their template
    // is broken when it is the preview that is.
    const all = TEMPLATE_VARIABLES.map((v) => `{{${v.name}}}`).join(' ');
    const { body } = previewTemplate({ subject: '', body: all });
    expect(body).not.toMatch(/\{\{/);
  });

  it('lets caller-supplied vars win over the samples', () => {
    const result = previewTemplate(
      { subject: '{{company_name}}', body: '{{company_name}} / {{platform_name}}' },
      { company_name: 'Longest Legal Name Ltd' },
    );
    expect(result.subject).toBe('Longest Legal Name Ltd');
    // The variable the caller had no answer for still fills from the sample
    // rather than surviving as braces mid-sentence.
    expect(result.body).toBe(`Longest Legal Name Ltd / ${sampleTemplateVars().platform_name}`);
  });

  it('reports unknown variables alongside the rendered preview', () => {
    const result = previewTemplate({ subject: 'Hi {{nope}}', body: '{{company_name}}' });
    expect(result.unknown_variables).toEqual(['nope']);
    // Still rendered — a warning, never a refusal.
    expect(result.subject).toBe('Hi {{nope}}');
  });
});

describe('valuation template vars', () => {
  const base = { company_name: 'Acme Corp', kind: '409a' };

  it('supplies every valuation-scoped name in the catalog', () => {
    const supplied = Object.keys(valuationTemplateVars(base));
    const declared = TEMPLATE_VARIABLES.filter((v) => v.scope === 'valuation').map((v) => v.name);
    expect([...supplied].sort()).toEqual([...declared].sort());
  });

  it('renders a not-yet-known field as an empty string, not as braces', () => {
    // The opposite of renderTemplate's treatment of an *unknown* name, and
    // deliberately: unknown means nobody will ever supply it; empty means we
    // do not know it yet, which is normal for most of an engagement's life.
    const vars = valuationTemplateVars(base);
    expect(vars.due_date).toBe('');
    expect(renderTemplate('Due {{due_date}}.', vars)).toBe('Due .');
  });

  it('truncates dates to the day, from a Date or a string', () => {
    expect(valuationTemplateVars({ ...base, due_date: new Date('2026-08-21T14:03:00Z') }).due_date).toBe(
      '2026-08-21',
    );
    expect(valuationTemplateVars({ ...base, valuation_date: '2026-08-07' }).valuation_date).toBe(
      '2026-08-07',
    );
  });

  it('humanises the lifecycle state', () => {
    expect(valuationTemplateVars({ ...base, state: 'draft_changes' }).state_label).toBe('Draft changes');
  });

  it('upper-cases the kind for prose', () => {
    expect(valuationTemplateVars(base).kind_label).toBe('409A');
    expect(valuationTemplateVars(base).kind).toBe('409a');
  });
});

describe('template categories', () => {
  it('lists the lifecycle groups plus account, in lifecycle order', () => {
    expect(TEMPLATE_CATEGORIES).toEqual(['account', 'open', 'in_review', 'drafted', 'published', 'closed']);
  });
});
