import { Helmet } from 'react-helmet-async';
import { buildHeadTags, serializeJsonLd, type HeadInput } from '../lib/headTags';

export type SeoProps = HeadInput;

/**
 * Per-page head management (409.ai §24): title, meta description, canonical,
 * Open Graph, Twitter Card, robots, and optional JSON-LD.
 *
 * The tag set comes from `buildHeadTags` — the same builder the build-time
 * prerenderer uses — so what a crawler reads from the static HTML and what a
 * browser ends up with after hydration are the same tags. This component only
 * applies them client-side; for link previews the prerendered copy is what
 * matters (social crawlers don't run JS).
 */
export function Seo(props: SeoProps): React.JSX.Element {
  const { title, tags, jsonLd } = buildHeadTags(props);

  return (
    <Helmet>
      <title>{title}</title>
      {tags.map((t) =>
        t.tag === 'meta' ? (
          <meta key={`${t.keyValue}`} {...{ [t.key]: t.keyValue, content: t.value }} />
        ) : (
          <link key={`${t.keyValue}`} {...{ [t.key]: t.keyValue, href: t.value }} />
        ),
      )}
      {jsonLd.map((node, i) => (
        <script key={i} type="application/ld+json">
          {serializeJsonLd(node)}
        </script>
      ))}
    </Helmet>
  );
}
