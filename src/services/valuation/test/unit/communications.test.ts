import { describe, expect, it } from 'vitest';
import {
  applyPromotionalFooter,
  applyTemplateOverrides,
  isCampaignDue,
  isSuppressed,
  MARKETING_PREFERENCE_KEY,
  renderTemplate,
  unsubscribeFooter,
  valuationTemplateVars,
} from '../../src/domain/communications.js';
import { NOTIFICATION_EVENT_TYPES, type EmailSpec } from '../../src/domain/emailWorkflows.js';

describe('renderTemplate (§15.5)', () => {
  it('substitutes {{vars}} and stringifies numbers', () => {
    expect(
      renderTemplate('Hi {{company_name}}, valuation #{{valuation_number}}', {
        company_name: 'Acme',
        valuation_number: 1766,
      }),
    ).toBe('Hi Acme, valuation #1766');
  });

  it('leaves unknown and null placeholders verbatim', () => {
    expect(renderTemplate('{{missing}} / {{gone}}', { gone: null })).toBe('{{missing}} / {{gone}}');
  });

  /**
   * `\w+` matches every name on `Object.prototype`, and a plain `vars[key]`
   * lookup finds them — none of which is `undefined` or `null`, so none of them
   * took the "unknown placeholder" path. `{{constructor}}` rendered as
   * `function Object() { [native code] }` in an email subject.
   *
   * The same three lines live in `domain/report.ts` and
   * `domain/emailWorkflows.ts`; both are covered below.
   */
  const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];

  it.each(INHERITED)('leaves the inherited name {{%s}} verbatim', (key) => {
    expect(renderTemplate(`{{${key}}}`, { company_name: 'Acme' })).toBe(`{{${key}}}`);
  });

  it('still substitutes an own property that shadows an inherited name', () => {
    // Not a name any caller uses, but "own wins" is the rule being applied and
    // it should be the rule, not a side effect of the name being unusual.
    expect(renderTemplate('{{toString}}', { toString: 'shadowed' })).toBe('shadowed');
  });

  it('leaves a placeholder verbatim when its own value is undefined', () => {
    expect(renderTemplate('{{company_name}}', { company_name: undefined })).toBe('{{company_name}}');
  });
});

describe('valuationTemplateVars', () => {
  it('derives kind_label and carries the number', () => {
    const vars = valuationTemplateVars({ company_name: 'Acme', kind: '409a', number: '1766' });
    expect(vars).toMatchObject({
      company_name: 'Acme',
      kind: '409a',
      kind_label: '409A',
      valuation_number: '1766',
    });
  });
});

describe('applyTemplateOverrides (§15.5)', () => {
  const specs: EmailSpec[] = [
    { recipient: 'owner', templateKey: 'draft_ready', subject: 'default subject', body: 'default body' },
    { recipient: 'owner', templateKey: 'valuation_started', subject: 's', body: 'b' },
  ];
  const vars = { company_name: 'Acme', kind_label: '409A' };

  it('replaces subject and body from an enabled override, rendered with vars', () => {
    const out = applyTemplateOverrides(
      specs,
      new Map([
        [
          'draft_ready',
          { subject: '{{company_name}} draft', body: 'Your {{kind_label}} draft.', enabled: true },
        ],
      ]),
      vars,
    );
    expect(out[0]).toMatchObject({ subject: 'Acme draft', body: 'Your 409A draft.' });
    expect(out[1]).toMatchObject({ subject: 's', body: 'b' }); // untouched
  });

  it('ignores disabled or incomplete overrides (never suppresses the send)', () => {
    const out = applyTemplateOverrides(
      specs,
      new Map([
        ['draft_ready', { subject: 'x', body: 'y', enabled: false }],
        ['valuation_started', { subject: '', body: 'y', enabled: true }],
      ]),
      vars,
    );
    expect(out).toEqual(specs);
  });
});

describe('isCampaignDue (§15.6)', () => {
  const now = new Date('2026-07-09T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const oneShot = { delay_hours: 48, repeat_hours: null, max_sends: 1 };

  it('waits out the delay window from state entry', () => {
    expect(isCampaignDue(oneShot, hoursAgo(47), [], now)).toBe(false);
    expect(isCampaignDue(oneShot, hoursAgo(48), [], now)).toBe(true);
  });

  it('one-shot campaigns never fire twice', () => {
    expect(isCampaignDue(oneShot, hoursAgo(500), [hoursAgo(400)], now)).toBe(false);
  });

  it('repeating campaigns respect repeat_hours and max_sends', () => {
    const drip = { delay_hours: 24, repeat_hours: 96, max_sends: 3 };
    expect(isCampaignDue(drip, hoursAgo(200), [hoursAgo(50)], now)).toBe(false); // too soon
    expect(isCampaignDue(drip, hoursAgo(200), [hoursAgo(96)], now)).toBe(true);
    expect(isCampaignDue(drip, hoursAgo(900), [hoursAgo(100), hoursAgo(300), hoursAgo(500)], now)).toBe(
      false,
    ); // max sends reached
  });

  it('measures repeat from the most recent send', () => {
    const drip = { delay_hours: 0, repeat_hours: 96, max_sends: 5 };
    expect(isCampaignDue(drip, hoursAgo(900), [hoursAgo(300), hoursAgo(10)], now)).toBe(false);
  });
});

// ── Promotional vs transactional (migration 0118) ────────────────────────────

describe('promotional suppression', () => {
  const promo = { promotional: true };
  const transactional = { promotional: false };

  it('suppresses a marketing campaign for a recipient who opted out', () => {
    expect(isSuppressed(promo, { marketingEmail: false })).toBe(true);
  });

  it('sends a marketing campaign to a recipient who has not opted out', () => {
    // Sparse and default-on, like the rest of the preference matrix.
    expect(isSuppressed(promo, { marketingEmail: true })).toBe(false);
  });

  /**
   * The asymmetry is the control. Marketing consent must not be able to
   * silence "your draft is ready" — that is a service failure wearing
   * compliance clothing, and it is the failure mode that exists today if the
   * campaigns are read as one undifferentiated set.
   */
  it('never suppresses a transactional campaign, opted out or not', () => {
    expect(isSuppressed(transactional, { marketingEmail: false })).toBe(false);
    expect(isSuppressed(transactional, { marketingEmail: true })).toBe(false);
  });

  it('appends an unsubscribe footer to promotional bodies only', () => {
    const body = 'Time to renew your 409A.';
    const withFooter = applyPromotionalFooter(body, promo, 'https://app.example.com');
    expect(withFooter).toContain(body);
    expect(withFooter).toContain('https://app.example.com');
    expect(applyPromotionalFooter(body, transactional, 'https://app.example.com')).toBe(body);
  });

  it('goes without a footer rather than with a broken link', () => {
    expect(applyPromotionalFooter('x', promo, null)).toBe('x');
  });

  it('says plainly that status notifications are unaffected', () => {
    // The line that stops an opt-out being an accidental service opt-out.
    expect(unsubscribeFooter('https://app.example.com')).toMatch(/valuations are not affected/i);
  });

  it('marketing is a preference a client can actually reach', () => {
    // The key has to be in the served matrix or the settings screen has no
    // switch for it, which would leave the opt-out theoretical.
    expect(NOTIFICATION_EVENT_TYPES as readonly string[]).toContain(MARKETING_PREFERENCE_KEY);
  });
});
