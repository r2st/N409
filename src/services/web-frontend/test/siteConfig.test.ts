import { describe, expect, it } from 'vitest';
import { siteConfig } from '../src/lib/siteConfig';

describe('siteConfig — environment-driven marketing links', () => {
  it('reports everything as unconfigured when the env is empty', () => {
    const config = siteConfig({});
    expect(config.calendlyUrl).toBeUndefined();
    expect(config.demoVideoUrl).toBeUndefined();
    expect(config.partnersEmail).toBeUndefined();
    expect(config.privacyEmail).toBeUndefined();
    expect(config.socialLinks).toEqual([]);
  });

  it('treats blank and whitespace-only values as unset', () => {
    const config = siteConfig({
      VITE_CALENDLY_URL: '',
      VITE_PARTNERS_EMAIL: '   ',
      VITE_TWITTER_URL: '\t\n',
    });
    expect(config.calendlyUrl).toBeUndefined();
    expect(config.partnersEmail).toBeUndefined();
    expect(config.socialLinks).toEqual([]);
  });

  it('passes through valid http(s) URLs and trims them', () => {
    const config = siteConfig({
      VITE_CALENDLY_URL: '  https://calendly.com/n409/30min  ',
      VITE_DEMO_VIDEO_URL: 'https://www.youtube-nocookie.com/embed/abc123',
    });
    expect(config.calendlyUrl).toBe('https://calendly.com/n409/30min');
    expect(config.demoVideoUrl).toBe('https://www.youtube-nocookie.com/embed/abc123');
  });

  it('rejects malformed and non-http URLs rather than rendering them', () => {
    // A typo in deployment config must degrade to "no link", never to a broken
    // or dangerous one.
    for (const bad of ['calendly.com/n409', 'javascript:alert(1)', 'not a url', 'ftp://x.io/a']) {
      expect(siteConfig({ VITE_CALENDLY_URL: bad }).calendlyUrl).toBeUndefined();
    }
  });

  it('accepts well-formed addresses and rejects malformed ones', () => {
    expect(siteConfig({ VITE_PARTNERS_EMAIL: 'partners@doaide.com' }).partnersEmail).toBe('partners@doaide.com');
    for (const bad of ['partners', 'partners@', '@doaide.com', 'partners@localhost', 'a b@c.io']) {
      expect(siteConfig({ VITE_PARTNERS_EMAIL: bad }).partnersEmail).toBeUndefined();
    }
  });

  it('includes only the social profiles that are configured', () => {
    expect(siteConfig({ VITE_LINKEDIN_URL: 'https://linkedin.com/company/n409' }).socialLinks).toEqual([
      { label: 'LinkedIn', href: 'https://linkedin.com/company/n409' },
    ]);

    const both = siteConfig({
      VITE_TWITTER_URL: 'https://x.com/n409',
      VITE_LINKEDIN_URL: 'https://linkedin.com/company/n409',
    });
    expect(both.socialLinks.map((s) => s.label)).toEqual(['X (Twitter)', 'LinkedIn']);
  });
});
