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
  invoicePaidMessage,
  paymentReceivedMessage,
  subscriptionCanceledMessage,
  trialEndingMessage,
} from '../../src/domain/billing.js';
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

/**
 * The other scope a preview promises and no census covered: `payment`.
 *
 * Four builders in `domain/billing.ts` produce a billing notice, each with its
 * own ops-overridable template key, and every one of them is rendered through
 * `renderTemplate` — so a `payment`-scope name the builder does not answer
 * reaches the subscriber as literal braces, while `previewTemplate` fills it
 * from the catalog sample and shows the operator a finished sentence.
 *
 * `invoice_period` was found that way once and fixed inside `invoicePaidMessage`
 * alone. `plan_name` was the same bug on the same notice: the one billing
 * message that is *about* a plan was the one that could not name it, while the
 * cancellation and trial-ending notices both looked it up.
 *
 * So the matrix below is a declaration rather than a scan. A notice answers a
 * `payment` variable when it *has* that fact — a one-off engagement receipt has
 * no invoice number, a trial notice has taken no payment — and blanket-filling
 * the rest with empty strings would trade literal braces for the silently empty
 * sentence `domain/templateVariables.ts` opens by calling the worse failure. A
 * new variable in this scope has to name which notices carry it.
 */
describe('payment-scope variables a billing notice can answer', () => {
  /** Which notices are expected to supply each `payment`-scope variable. */
  const ANSWERED_BY: Record<string, string[]> = {
    amount_paid: ['engagement_receipt', 'invoice_paid'],
    invoice_number: ['invoice_paid'],
    invoice_period: ['invoice_paid'],
    plan_name: ['invoice_paid', 'subscription_canceled', 'trial_ending'],
    trial_ends_on: ['trial_ending'],
    plan_price: ['trial_ending'],
    subscription_ended_on: ['subscription_canceled'],
  };

  const notices: Record<string, () => { vars: Record<string, string> }> = {
    engagement_receipt: () =>
      paymentReceivedMessage({
        reference: '1766',
        company_name: 'Acme Corp',
        kind: '409a',
        amount_cents: 119_000,
        currency: 'usd',
        express: false,
        receipt_link: 'https://app.n409.test/valuations/01JQ',
      }),
    invoice_paid: () =>
      invoicePaidMessage({
        number: 'INV-202608-0007',
        amount_cents: 9_900,
        currency: 'usd',
        period_start: '2026-08-01T00:00:00.000Z',
        period_end: '2026-09-01T00:00:00.000Z',
        invoice_link: 'https://app.n409.test/billing',
        plan_name: 'Annual retainer',
      }),
    subscription_canceled: () =>
      subscriptionCanceledMessage({
        plan_name: 'Annual retainer',
        ended_at: '2026-08-30T00:00:00.000Z',
        billing_link: 'https://app.n409.test/billing',
      }),
    trial_ending: () =>
      trialEndingMessage({
        plan_name: 'Annual retainer',
        trial_ends_at: '2026-09-02T00:00:00.000Z',
        price_cents: 2_000_000,
        currency: 'usd',
        billing_link: 'https://app.n409.test/billing',
      }),
  };

  it('declares an answer for every payment-scope variable the catalog offers', () => {
    const declared = Object.keys(ANSWERED_BY).sort();
    expect(namesIn('payment').sort()).toEqual(declared);
    // Every name has at least one notice behind it: a variable the palette
    // offers and no send can ever fill is a promise nothing keeps.
    for (const [name, keys] of Object.entries(ANSWERED_BY)) {
      expect(keys.length, `${name} is offered by the palette and answered by no notice`).toBeGreaterThan(0);
    }
  });

  it('supplies each variable on exactly the notices that claim it', () => {
    for (const [key, build] of Object.entries(notices)) {
      const vars = build().vars;
      for (const [name, keys] of Object.entries(ANSWERED_BY)) {
        const supplied = typeof vars[name] === 'string';
        expect(supplied, `${key} ${keys.includes(key) ? 'must' : 'must not'} supply ${name}`).toBe(
          keys.includes(key),
        );
      }
    }
  });

  it('leaves no payment-scope placeholder unrendered on the notice that claims it', () => {
    for (const [key, build] of Object.entries(notices)) {
      const claimed = Object.entries(ANSWERED_BY)
        .filter(([, keys]) => keys.includes(key))
        .map(([name]) => `${name}=[{{${name}}}]`)
        .join(' ');
      const rendered = renderTemplate(claimed, build().vars);
      expect(collectPlaceholders(rendered), `${key} previews these and cannot send them`).toEqual([]);
      // And with a value, not a blank: a notice that claims a fact states it.
      expect(rendered).not.toMatch(/=\[\]/);
    }
  });

  it('renders a plan-named invoice receipt the way the operator previewed it', () => {
    // The failure this section was written for, end to end: the override an
    // operator authors, previewed against the samples and then sent.
    const body = 'Your {{plan_name}} renewed — {{amount_paid}} for {{invoice_period}}.';
    expect(collectPlaceholders(previewTemplate({ subject: '', body }).body)).toEqual([]);
    const sent = renderTemplate(body, notices.invoice_paid!().vars);
    expect(sent).toBe('Your Annual retainer renewed — $99.00 for 2026-08-01 to 2026-09-01.');
  });

  it('blanks the plan on an invoice against no plan this platform carries', () => {
    // A webhook endpoint receives every invoice on the Stripe account. Blank
    // rather than absent, so the override renders a gap and not braces.
    const vars = invoicePaidMessage({
      number: 'INV-202608-0008',
      amount_cents: 9_900,
      currency: 'usd',
      period_start: null,
      period_end: null,
      invoice_link: 'https://app.n409.test/billing',
      plan_name: null,
    }).vars;
    expect(vars.plan_name).toBe('');
    expect(collectPlaceholders(renderTemplate('{{plan_name}}', vars))).toEqual([]);
  });
});
