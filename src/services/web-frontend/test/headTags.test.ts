import { describe, expect, it } from 'vitest';
import {
  buildHeadTags,
  escapeHtml,
  renderHeadTags,
  serializeJsonLd,
} from '../src/lib/headTags';

const ORIGIN = 'https://x.io';

function tagValue(
  tags: ReturnType<typeof buildHeadTags>['tags'],
  key: 'name' | 'property' | 'rel',
  keyValue: string,
): string | undefined {
  return tags.find((t) => t.key === key && t.keyValue === keyValue)?.value;
}

describe('buildHeadTags (§24)', () => {
  const base = { title: 'Pricing', description: 'Flat per-report pricing.', path: '/pricing' };

  it('composes title, description and canonical from the origin', () => {
    const head = buildHeadTags(base, ORIGIN);
    expect(head.title).toBe('Pricing · N409');
    expect(tagValue(head.tags, 'name', 'description')).toBe('Flat per-report pricing.');
    expect(tagValue(head.tags, 'rel', 'canonical')).toBe('https://x.io/pricing');
  });

  it('points og:image at a raster image, not the SVG', () => {
    // Facebook, LinkedIn, X and Slack all refuse image/svg+xml for og:image —
    // an SVG here means every shared link previews with no image at all.
    const image = tagValue(buildHeadTags(base, ORIGIN).tags, 'property', 'og:image');
    expect(image).toBe('https://x.io/og-image.png');
    expect(image).not.toMatch(/\.svg$/);
  });

  it('declares og:image dimensions so unfurlers reserve a large card', () => {
    const head = buildHeadTags(base, ORIGIN);
    expect(tagValue(head.tags, 'property', 'og:image:width')).toBe('1200');
    expect(tagValue(head.tags, 'property', 'og:image:height')).toBe('630');
    expect(tagValue(head.tags, 'name', 'twitter:card')).toBe('summary_large_image');
  });

  it('opts into large image previews for indexable pages', () => {
    expect(tagValue(buildHeadTags(base, ORIGIN).tags, 'name', 'robots')).toBe(
      'index,follow,max-image-preview:large,max-snippet:-1',
    );
  });

  it('emits noindex when asked, and nothing else claiming indexability', () => {
    const head = buildHeadTags({ ...base, noindex: true }, ORIGIN);
    const robots = head.tags.filter((t) => t.keyValue === 'robots');
    expect(robots).toHaveLength(1);
    expect(robots[0]!.value).toBe('noindex,nofollow');
  });

  it('normalises a single JSON-LD node into a list', () => {
    expect(buildHeadTags({ ...base, jsonLd: { '@type': 'Thing' } }, ORIGIN).jsonLd).toHaveLength(1);
    expect(
      buildHeadTags({ ...base, jsonLd: [{ '@type': 'A' }, { '@type': 'B' }] }, ORIGIN).jsonLd,
    ).toHaveLength(2);
  });

  it('defaults og:type to website and honours an override', () => {
    expect(tagValue(buildHeadTags(base, ORIGIN).tags, 'property', 'og:type')).toBe('website');
    expect(
      tagValue(buildHeadTags({ ...base, type: 'product' }, ORIGIN).tags, 'property', 'og:type'),
    ).toBe('product');
  });
});

describe('escaping', () => {
  it('escapes HTML metacharacters in attribute values', () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &#39; f',
    );
  });

  it('prevents JSON-LD content from closing the script element', () => {
    // Without escaping `<`, a description containing </script> terminates the
    // block early and the remainder becomes executable markup.
    const payload = serializeJsonLd({ description: '</script><img onerror=x>' });
    expect(payload).not.toContain('</script>');
    expect(payload).toContain('\\u003c');
  });

  it('escapes head tag values when rendering to HTML', () => {
    const html = renderHeadTags(
      buildHeadTags({ title: 'A & B', description: '"quoted" <tag>', path: '/x' }, ORIGIN),
    );
    expect(html).toContain('<title>A &amp; B · N409</title>');
    expect(html).toContain('&quot;quoted&quot; &lt;tag&gt;');
    expect(html).not.toContain('<tag>');
  });

  it('renders link tags with href and meta tags with content', () => {
    const html = renderHeadTags(
      buildHeadTags({ title: 'T', description: 'D', path: '/pricing' }, ORIGIN),
    );
    expect(html).toContain('<link rel="canonical" href="https://x.io/pricing" />');
    expect(html).toContain('<meta name="description" content="D" />');
    expect(html).toContain('<meta property="og:url" content="https://x.io/pricing" />');
  });
});
