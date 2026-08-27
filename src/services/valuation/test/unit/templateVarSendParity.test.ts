import { describe, expect, it } from 'vitest';
import {
  PLATFORM_NAME,
  alwaysTemplateVars,
  renderTemplate,
  valuationLinkVars,
  valuationTemplateVars,
} from '../../src/domain/communications.js';
import { PLATFORM_BRANDING } from '../../src/domain/branding.js';
import {
  TEMPLATE_VARIABLES,
  collectPlaceholders,
  previewTemplate,
} from '../../src/domain/templateVariables.js';

/**
 * Preview/send parity for template variables.
 *
 * The catalog declares what a template may interpolate, the editor offers it as
 * a palette, and `previewTemplate` fills every name in it from
 * `sampleTemplateVars()`. So the operator authoring a campaign saw every
 * variable resolve. Nothing on either *send* path supplied the `always` or
 * `link` scopes at all, and the drip scan supplied three of the seven
 * `valuation` names — and `renderTemplate` leaves a name nobody answers
 * verbatim. The result was a preview reading "Hi Dana, … due 2026-08-21" and a
 * delivered email reading "Hi {{recipient_name}}, … due ".
 *
 * The existing census pinned `valuationTemplateVars`' *keys* against the
 * catalog, which is a statement about the function and not about any send. It
 * passed throughout. These pin the other half: what a send path can actually
 * put in front of a client.
 */

/** Every name the catalog declares in these scopes, as `{{name}}`. */
const namesIn = (...scopes: string[]): string[] =>
  TEMPLATE_VARIABLES.filter((v) => scopes.includes(v.scope)).map((v) => v.name);

/** A template naming every variable an engagement-scoped send must answer. */
const ENGAGEMENT_TEMPLATE = namesIn('always', 'valuation')
  .concat('valuation_link', 'payment_link')
  .map((n) => `${n}=[{{${n}}}]`)
  .join(' ');

/**
 * The var set an engagement-scoped send builds — the same three-way merge
 * `hooks/autoEmails.ts` and `hooks/stateChange.ts` both perform. Assembled here
 * from the same exported builders so this test fails if either builder stops
 * answering a name, and a matching integration test covers the wiring.
 */
function sendVars(overrides: Record<string, unknown> = {}) {
  return {
    ...alwaysTemplateVars({
      recipient_name: 'Dana',
      recipient_email: 'dana@client.test',
      platform_name: 'Fidelity',
      support_email: 'support@n409.test',
    }),
    ...valuationLinkVars('https://app.n409.test', '01JQVALUATION'),
    ...valuationTemplateVars({
      company_name: 'Acme Corp',
      kind: '409a',
      number: '1766',
      valuation_date: '2026-08-07',
      due_date: new Date('2026-08-21T14:03:00Z'),
      state: 'in_progress',
      partner_name: 'Fidelity',
    }),
    ...overrides,
  };
}

describe('template variables a real send can answer', () => {
  it('leaves no placeholder unrendered on an engagement-scoped send', () => {
    const rendered = renderTemplate(ENGAGEMENT_TEMPLATE, sendVars());
    // Braces surviving means nobody supplied the name at all — the failure that
    // put "{{recipient_name}}" in a client's inbox.
    expect(collectPlaceholders(rendered)).toEqual([]);
  });

  it('leaves no variable blank when the engagement has the data', () => {
    // A fully-populated partner engagement: every name in the catalog has an
    // answer, so any gap here is a send path that cannot reach one.
    const rendered = renderTemplate(ENGAGEMENT_TEMPLATE, sendVars());
    const blank = [...rendered.matchAll(/(\w+)=\[\]/g)].map((m) => m[1]);
    expect(blank).toEqual([]);
  });

  it('renders blank, not braces, for what the engagement genuinely has no answer to', () => {
    // The other half of the contract, and the reason the assertion above needs
    // a fully-populated fixture: a direct client has no partner and an
    // engagement with no measurement date set yet has no date. Both are normal
    // for most of an engagement's life, and both must read as a gap rather than
    // as literal braces.
    const rendered = renderTemplate(ENGAGEMENT_TEMPLATE, {
      ...sendVars(),
      ...valuationTemplateVars({ company_name: 'Acme Corp', kind: '409a' }),
    });
    expect(collectPlaceholders(rendered)).toEqual([]);
    expect(rendered).toContain('partner_name=[]');
    expect(rendered).toContain('valuation_date=[]');
  });

  it('supplies every name the preview does, for an engagement-scoped send', () => {
    // The preview is the promise; a send is the delivery. Any name the preview
    // fills and a send cannot is a template that previews well and mails badly.
    const supplied = new Set(Object.keys(sendVars()));
    const promised = namesIn('always', 'valuation');
    expect(promised.filter((n) => !supplied.has(n))).toEqual([]);
  });

  it('renders the same shape the operator previewed', () => {
    const template = 'Hi {{recipient_name}}, your {{kind_label}} for {{company_name}} is due {{due_date}}.';
    const preview = previewTemplate({ subject: '', body: template }).body;
    const sent = renderTemplate(template, sendVars());
    // Different values — the preview uses samples — but neither may carry
    // braces or a gap where a value belongs.
    expect(collectPlaceholders(preview, sent)).toEqual([]);
    expect(sent).toBe('Hi Dana, your 409A for Acme Corp is due 2026-08-21.');
  });
});

describe('alwaysTemplateVars', () => {
  it('falls back to the address when we hold no name', () => {
    // The catalog promises "their first name, or their email when we have no
    // name" — never a gap, because the sentence around it reads "Hi ,".
    for (const name of [null, undefined, '', '   ']) {
      expect(alwaysTemplateVars({ recipient_name: name, recipient_email: 'a@b.test' }).recipient_name).toBe(
        'a@b.test',
      );
    }
  });

  it('brands as the partner on a white-labelled send and the platform otherwise', () => {
    expect(alwaysTemplateVars({ recipient_email: 'a@b.test', platform_name: 'Fidelity' }).platform_name).toBe(
      'Fidelity',
    );
    expect(alwaysTemplateVars({ recipient_email: 'a@b.test' }).platform_name).toBe(PLATFORM_NAME);
  });

  it('names the platform the same thing the branding domain does', () => {
    // Duplicated to keep this module free of the branding domain; pinned so the
    // two spellings cannot drift into one email saying N409 and the next not.
    expect(PLATFORM_NAME).toBe(PLATFORM_BRANDING.name);
  });
});

describe('valuationLinkVars', () => {
  it('points both links at the engagement page', () => {
    // There is no `/pay` route — checkout is a control on the detail page, and
    // this is the same URL routes/payments.ts builds for a receipt.
    expect(valuationLinkVars('https://app.n409.test', '01JQ')).toEqual({
      valuation_link: 'https://app.n409.test/valuations/01JQ',
      payment_link: 'https://app.n409.test/valuations/01JQ',
    });
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(valuationLinkVars('https://app.n409.test/', '01JQ').valuation_link).toBe(
      'https://app.n409.test/valuations/01JQ',
    );
  });

  it('renders empty rather than as braces when no base URL is configured', () => {
    // Neither is good. A sentence with a gap is recoverable; a client emailing
    // support to ask what "{{payment_link}}" means is not.
    const vars = valuationLinkVars(undefined, '01JQ');
    expect(vars).toEqual({ valuation_link: '', payment_link: '' });
    expect(collectPlaceholders(renderTemplate('Go to {{payment_link}}', vars))).toEqual([]);
  });
});

describe('the catalog samples name routes that exist', () => {
  it('does not advertise a /pay or /payments URL', () => {
    // Both were sample URLs for routes the SPA has never had. A sample is what
    // an operator copies when they want to see the shape of the value.
    const linkSamples = TEMPLATE_VARIABLES.filter((v) => v.scope === 'link').map((v) => v.sample);
    expect(linkSamples.filter((s) => /\/(pay|payments)$/.test(s))).toEqual([]);
  });
});
