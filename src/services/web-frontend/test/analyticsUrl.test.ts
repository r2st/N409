import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SENSITIVE_QUERY_PARAMS,
  injectAnalytics,
  injectGa4,
  scrubAnalyticsUrl,
  urlCarriesCredential,
  type AnalyticsConfig,
} from '../src/lib/analytics';

/**
 * What a third-party container is allowed to be told about a URL.
 *
 * The API has blanked these parameters out of every request line it writes
 * since the round that found the one-click unsubscribe token and the four OAuth
 * authorization codes sitting in the logs (`scrubUrl` /
 * `SENSITIVE_QUERY_PARAMS`, packages/shared/src/problem.ts). The browser had no
 * counterpart, and the browser is the half that hands the URL to Google and
 * Meta.
 *
 * Three public routes land with a live credential in the query — password
 * reset, email verification, invitation acceptance — and each strips it on
 * mount. That strip is a race with an async script, not a guarantee, so the one
 * field a container lets us set is set explicitly instead.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PROBLEM = path.resolve(HERE, '../../../packages/shared/src/problem.ts');

/** The server's list, read out of its source — there is no import path here. */
function serverParams(): string[] {
  const src = readFileSync(SERVER_PROBLEM, 'utf8');
  const block = src.slice(
    src.indexOf('export const SENSITIVE_QUERY_PARAMS'),
    src.indexOf('SENSITIVE_QUERY_PARAM_SET'),
  );
  return [...block.matchAll(/^\s*'([a-z_]+)',$/gm)].map((m) => m[1]!);
}

describe('the browser copy of the sensitive query parameters', () => {
  it('parses the server list at all — the vacuity guard', () => {
    expect(serverParams().length).toBeGreaterThanOrEqual(15);
  });

  it('says exactly what the server says', () => {
    // web-frontend has no `@n409/shared` dependency, so this vocabulary is
    // duplicated by construction and pinned by test — the same arrangement as
    // every other rule this browser restates about the server's own.
    expect([...SENSITIVE_QUERY_PARAMS].sort()).toEqual(serverParams().sort());
  });
});

describe('scrubAnalyticsUrl', () => {
  it('blanks a live credential without losing the fact that one was there', () => {
    expect(scrubAnalyticsUrl('https://409.doaide.com/reset-password?token=abc123def456')).toBe(
      'https://409.doaide.com/reset-password?token=REDACTED',
    );
    expect(scrubAnalyticsUrl('https://409.doaide.com/auth/google/complete?code=4%2F0Ab&state=xyz')).toBe(
      'https://409.doaide.com/auth/google/complete?code=REDACTED&state=REDACTED',
    );
  });

  it('blanks an address handed over in a query string', () => {
    expect(scrubAnalyticsUrl('https://409.doaide.com/accept-invite?email=ada%40example.com')).toBe(
      'https://409.doaide.com/accept-invite?email=REDACTED',
    );
  });

  it('blanks a credential carried in the fragment, which is where these links carry it', () => {
    // The invitation, verification, reset, board-signature, client-intake and
    // Google hand-off links all put the token *after the hash* — deliberately,
    // because a fragment is not sent to the server and never reaches a request
    // log. It is sent to GA4 all the same, inside `page_location`.
    expect(scrubAnalyticsUrl('https://409.doaide.com/accept-invite#token=abc123def456')).toBe(
      'https://409.doaide.com/accept-invite#token=REDACTED',
    );
    expect(scrubAnalyticsUrl('https://409.doaide.com/auth/google/complete#token=jwt.body.sig')).toBe(
      'https://409.doaide.com/auth/google/complete#token=REDACTED',
    );
    expect(scrubAnalyticsUrl('https://409.doaide.com/verify-email?email=ada%40example.com#token=t')).toBe(
      'https://409.doaide.com/verify-email?email=REDACTED#token=REDACTED',
    );
  });

  it('leaves a fragment that is not a parameter list alone', () => {
    for (const href of ['https://409.doaide.com/pricing#faq', 'https://409.doaide.com/blog/x#how-it-works']) {
      expect(scrubAnalyticsUrl(href), href).toBe(href);
    }
  });

  it('leaves an ordinary marketing URL byte for byte alone', () => {
    // Returned unchanged rather than round-tripped through `URL`, so a campaign
    // URL is not silently re-encoded on its way into the report.
    for (const href of [
      'https://409.doaide.com/pricing',
      'https://409.doaide.com/blog/what-is-a-409a?utm_source=news&utm_medium=email',
      'https://409.doaide.com/compare/carta',
    ]) {
      expect(scrubAnalyticsUrl(href), href).toBe(href);
    }
  });

  it('answers a URL it cannot parse with a path and nothing else', () => {
    expect(scrubAnalyticsUrl('not a url ?token=live')).toBe('/');
  });
});

describe('injectGa4', () => {
  const config: AnalyticsConfig = { gtmId: '', ga4Id: 'G-TEST', fbPixelId: '' };

  it('configures the measurement id with the scrubbed location, not the address bar', () => {
    const dataLayer: unknown[] = [];
    const win = {
      dataLayer,
      location: { href: 'https://409.doaide.com/reset-password?token=live-secret' },
    } as unknown as Window;
    const doc = document.implementation.createHTMLDocument('t');
    injectGa4(config, win as never, doc);
    const configCall = dataLayer.find(
      (entry): entry is unknown[] => Array.isArray(entry) && entry[0] === 'config',
    );
    expect(configCall).toBeDefined();
    expect(JSON.stringify(configCall)).not.toContain('live-secret');
    expect((configCall as unknown[])[2]).toEqual({
      page_location: 'https://409.doaide.com/reset-password?token=REDACTED',
    });
  });
});

describe('urlCarriesCredential — the containers the scrub cannot reach', () => {
  /*
   * `scrubAnalyticsUrl` covers exactly one thing: GA4's `page_location`, the
   * only URL field a container lets this code set. GTM and the Meta Pixel read
   * `document.location` themselves — GTM through `{{Page URL}}` and whatever
   * tags its container holds, the Pixel through the `dl` on every event — and
   * neither takes a value from here. Whatever those vendors' scripts currently
   * do with a fragment is not a contract, which is the argument for asking the
   * question before they load rather than hoping about it afterwards.
   *
   * And the address bar really is still holding the token when they load.
   * AcceptInvite, VerifyEmail, ResetPassword and GoogleComplete drop it on
   * mount; ClientIntake, BoardSign and AuditorPortal do not, and cannot — their
   * token is how a reload resumes the page, so it stays in `window.location`
   * for as long as the tab is open. All seven are public routes, which is
   * precisely where `<Analytics>` is allowed to inject.
   */
  it('sees a credential in the query', () => {
    expect(urlCarriesCredential('https://409.doaide.com/reset-password?token=live-secret')).toBe(true);
  });

  it('sees a credential in the fragment, which is where these links carry it', () => {
    expect(urlCarriesCredential('https://409.doaide.com/intake#token=live-secret')).toBe(true);
    expect(urlCarriesCredential('https://409.doaide.com/board/sign#/x?token=live-secret')).toBe(true);
  });

  it('leaves an ordinary marketing URL alone', () => {
    for (const href of [
      'https://409.doaide.com/pricing',
      'https://409.doaide.com/blog/what-is-a-409a?utm_source=news&utm_medium=email',
      'https://409.doaide.com/faq#pricing',
    ]) {
      expect(urlCarriesCredential(href), href).toBe(false);
    }
  });

  it('does not treat an already-blanked parameter as a credential', () => {
    // `?token=` with no value is what a scrub leaves behind. Reading it as a
    // credential would switch analytics off for a URL that has been cleaned.
    expect(urlCarriesCredential('https://409.doaide.com/reset-password?token=')).toBe(false);
  });

  it('assumes the worst about a URL it cannot parse', () => {
    // The scrub answers this with `/` because it has to return a string.
    // Here there is a safe answer and this is it.
    expect(urlCarriesCredential('not a url ?token=live')).toBe(true);
  });
});

describe('injectAnalytics on a credential-bearing page', () => {
  const config: AnalyticsConfig = {
    gtmId: 'GTM-TEST',
    ga4Id: 'G-TEST',
    fbPixelId: '111122223333',
  };

  function fixtures(href: string) {
    const doc = document.implementation.createHTMLDocument('t');
    const win = { location: { href } } as unknown as Window;
    return { win, doc };
  }

  it('loads no container at all while the token is in the address bar', () => {
    const { win, doc } = fixtures('https://409.doaide.com/intake#token=live-secret');
    injectAnalytics(config, win, doc);
    expect(doc.querySelector('#n409-gtm')).toBeNull();
    expect(doc.querySelector('#n409-ga4')).toBeNull();
    expect(doc.querySelector('#n409-fbq')).toBeNull();
  });

  it('is a deferral, not a decision: the next clean URL still gets them', () => {
    // No loaded flag is set by the refusal, so the same window can load later —
    // which is what `<Analytics>` re-running on navigation depends on.
    const { win, doc } = fixtures('https://409.doaide.com/intake#token=live-secret');
    injectAnalytics(config, win, doc);
    (win as unknown as { location: { href: string } }).location.href = 'https://409.doaide.com/pricing';
    injectAnalytics(config, win, doc);
    expect(doc.querySelector('#n409-gtm')).not.toBeNull();
    expect(doc.querySelector('#n409-ga4')).not.toBeNull();
    expect(doc.querySelector('#n409-fbq')).not.toBeNull();
  });
});
