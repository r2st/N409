import { describe, expect, it } from 'vitest';
import {
  hasAnyAnalytics,
  injectAnalytics,
  injectFbPixel,
  injectGa4,
  injectGtm,
  readAnalyticsConfig,
  type AnalyticsConfig,
} from '../src/lib/analytics';

const FULL: AnalyticsConfig = {
  gtmId: 'GTM-TEST123',
  ga4Id: 'G-TEST456',
  fbPixelId: '111122223333',
};

/** Fresh, isolated document + window so injection never touches the test globals.
 *
 * The stub carries a `location`, because `injectAnalytics` now asks what the
 * address bar holds before it loads anything and answers "cannot tell" with
 * "load nothing" (see `urlCarriesCredential`). A window without one is not a
 * browser this code ever runs in, and a fixture that pretends otherwise would
 * be exercising the refusal path while claiming to test the loading one.
 */
function fixtures(href = 'https://n409.ai/pricing'): {
  win: Window & Record<string, unknown>;
  doc: Document;
} {
  const doc = document.implementation.createHTMLDocument('t');
  const win = { location: { href } } as unknown as Window & Record<string, unknown>;
  return { win, doc };
}

describe('readAnalyticsConfig (§23)', () => {
  it('trims values and defaults missing ids to empty', () => {
    expect(readAnalyticsConfig({ VITE_GTM_ID: '  GTM-X  ' })).toEqual({
      gtmId: 'GTM-X',
      ga4Id: '',
      fbPixelId: '',
    });
    expect(readAnalyticsConfig({})).toEqual({ gtmId: '', ga4Id: '', fbPixelId: '' });
  });
});

describe('hasAnyAnalytics', () => {
  it('is false only when every id is blank', () => {
    expect(hasAnyAnalytics({ gtmId: '', ga4Id: '', fbPixelId: '' })).toBe(false);
    expect(hasAnyAnalytics({ gtmId: 'GTM-X', ga4Id: '', fbPixelId: '' })).toBe(true);
  });
});

describe('injectGtm', () => {
  it('adds the loader once and seeds dataLayer', () => {
    const { win, doc } = fixtures();
    injectGtm(FULL, win, doc);
    injectGtm(FULL, win, doc); // idempotent
    const scripts = doc.querySelectorAll('#n409-gtm');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.getAttribute('src')).toContain('gtm.js?id=GTM-TEST123');
    const layer = win.dataLayer as unknown[];
    expect(layer.filter((e) => (e as { event?: string }).event === 'gtm.js')).toHaveLength(1);
  });

  it('does nothing without a gtm id', () => {
    const { win, doc } = fixtures();
    injectGtm({ ...FULL, gtmId: '' }, win, doc);
    expect(doc.querySelector('#n409-gtm')).toBeNull();
  });
});

describe('injectGa4', () => {
  it('loads gtag and configures the measurement id once', () => {
    const { win, doc } = fixtures();
    injectGa4(FULL, win, doc);
    injectGa4(FULL, win, doc);
    expect(doc.querySelectorAll('#n409-ga4')).toHaveLength(1);
    expect(doc.querySelector('#n409-ga4')!.getAttribute('src')).toContain('gtag/js?id=G-TEST456');
    const layer = win.dataLayer as unknown[][];
    expect(layer.some((args) => args[0] === 'config' && args[1] === 'G-TEST456')).toBe(true);
  });
});

describe('injectFbPixel', () => {
  it('installs fbq and tracks a PageView once', () => {
    const { win, doc } = fixtures();
    injectFbPixel(FULL, win, doc);
    injectFbPixel(FULL, win, doc);
    expect(doc.querySelectorAll('#n409-fbq')).toHaveLength(1);
    expect(typeof (win as { fbq?: unknown }).fbq).toBe('function');
  });
});

describe('injectAnalytics', () => {
  it('loads all configured providers', () => {
    const { win, doc } = fixtures();
    injectAnalytics(FULL, win, doc);
    expect(doc.querySelector('#n409-gtm')).not.toBeNull();
    expect(doc.querySelector('#n409-ga4')).not.toBeNull();
    expect(doc.querySelector('#n409-fbq')).not.toBeNull();
  });

  it('injects nothing when config is empty', () => {
    const { win, doc } = fixtures();
    injectAnalytics({ gtmId: '', ga4Id: '', fbPixelId: '' }, win, doc);
    expect(doc.querySelectorAll('script')).toHaveLength(0);
  });
});
