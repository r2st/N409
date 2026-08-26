/**
 * What a first-time visitor downloads before anything paints.
 *
 * Route-level splitting (see `src/App.tsx`) is what keeps the entry chunk from
 * being the whole application, and it is undone by a single ordinary-looking
 * static import: a shared component reaching for a page, a `lib/` helper
 * pulling in a data module, a barrel re-exporting something heavy. Nothing
 * about that import looks wrong in review, the type checker is content, and
 * the tests pass — the only symptom is the entry chunk quietly growing again.
 *
 * The `lazy(() => import(…))` boundaries in `App.tsx` are the one thing a
 * bundle can be split on, and they are invisible to every other test in this
 * package. So this census computes the static import closure from `main.tsx` —
 * following `import … from` and `export … from`, and deliberately *not*
 * following `import(…)`, which is the boundary — and pins its membership.
 *
 * Two directions, both of which matter:
 *   - a module joining the closure fails until it is registered, so growing
 *     the first paint is a deliberate act rather than a side effect;
 *   - a module leaving it fails too, so a register entry cannot outlive the
 *     import that justified it and quietly license a future one.
 *
 * The heavy payloads are named separately below: those are the modules whose
 * whole reason for being split out is that they must not be here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ENTRY = path.join(SRC, 'main.tsx');

/** Static specifiers only — `import(…)` is the split point, not an edge. */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g;
/** Bare side-effect imports (`import './index.css'`). */
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // bare package — not our source
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function specifiersIn(text: string): string[] {
  const out: string[] = [];
  for (const re of [STATIC_IMPORT, SIDE_EFFECT_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1]!);
  }
  return out;
}

/** Every source module reachable from `main.tsx` without crossing an `import()`. */
function eagerClosure(): string[] {
  const seen = new Set<string>();
  const stack = [ENTRY];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const spec of specifiersIn(text)) {
      const resolved = resolveModule(file, spec);
      if (resolved) stack.push(resolved);
    }
  }
  return [...seen].map((f) => path.relative(SRC, f).split(path.sep).join('/')).sort();
}

/**
 * The register: every module on the first-paint path, and why it is there.
 *
 * The marketing shell and landing page are eager on purpose — they are the LCP
 * path for anonymous traffic, and a second round trip for them would trade the
 * splitting win straight back for latency. Everything else here is either the
 * React entry, a provider the whole tree sits inside, or something one of
 * those two reaches.
 */
const EAGER_REGISTER: Record<string, string> = {
  'main.tsx': 'the entry itself',
  'App.tsx': 'the route table — every page below it is behind `lazy`',

  // Providers wrapping the whole tree (see main.tsx).
  'components/ErrorBoundary.tsx': 'top-level render-throw boundary',
  'lib/auth.tsx': 'session provider',
  'lib/branding.tsx': 'tenant branding provider',
  'lib/consent.tsx': 'cookie-consent provider',
  'components/Analytics.tsx': 'consent-gated tag loader, mounted at the root',
  'components/CookieConsent.tsx': 'consent banner, mounted at the root',

  // Route chrome that must exist before the first route resolves.
  'components/RequireAuth.tsx': 'route guard — referenced by the route table',
  'components/RequireRole.tsx': 'route guard — referenced by the route table',
  'components/RouteAnnouncer.tsx': 'per-navigation live region',
  'components/RouteTitle.tsx': 'document-title provider',
  'components/SkipLink.tsx': 'first focusable element on every page',
  'components/StandaloneLayout.tsx': 'per-route boundary for the pages with no shell',

  // The anonymous landing path.
  'pages/marketing/LandingPage.tsx': 'the LCP page for anonymous traffic',
  'pages/marketing/MarketingSections.tsx': 'sections of the landing page',
  'components/MarketingLayout.tsx': 'marketing header and footer',
  'components/Logo.tsx': 'in the marketing header',
  'components/ThemeToggle.tsx': 'in the marketing header',
  'components/Seo.tsx': 'per-page head tags',
  'lib/marketing.ts': 'marketing copy — the landing page and nav read it',
  'lib/siteConfig.ts': 'build-time URLs for the marketing CTAs',
  'lib/seo.ts': 'canonical/OG tag helpers',
  'lib/headTags.ts': 'head-tag construction shared with the prerenderer',
  'lib/pageMeta.ts': 'per-route titles and descriptions',
  'lib/pageTitles.ts': 'document titles for the announcer',

  // Shared leaves.
  'components/ui.tsx': 'the design-system primitives',
  'lib/api.ts': 'the fetch wrapper the providers use',
  'lib/analytics.ts': 'event helper used by the consent banner',
  'lib/format.ts': 'number/date formatting',
  'lib/rbac.ts': 'role predicates the route guards evaluate',
  'lib/rovingFocus.ts': 'keyboard behaviour used by ui.tsx',
  'lib/theme.ts': 'light/dark resolution, read before first paint',
  'lib/types.ts': 'types only — erased at build',
};

/**
 * Modules split out *because* of their weight. Each names the importers
 * entitled to pull it in statically; anyone else has to use `import()`.
 *
 * `helpBodies` is the case that prompted this: the Markdown corpus is ~48 kB,
 * and `HelpIcon` — the "?" beside a section header — used to put all of it in
 * the graph of every page that renders one. That was 51 of 121 built chunks.
 */
const HEAVY_PAYLOADS: Array<{ module: string; importers: string[]; why: string }> = [
  {
    module: 'data/helpBodies',
    importers: ['pages/HelpPage.tsx'],
    why: 'the Help Center is the article corpus; everyone else calls loadHelpBodies()',
  },
  {
    module: 'lib/productContent',
    importers: ['pages/marketing/ProductPage.tsx'],
    why: '~40 kB of copy for one lazy route; `marketing.ts` next door is eager',
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const ALL_FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

describe('the first-paint module graph', () => {
  const closure = eagerClosure();

  it('contains nothing that is not registered', () => {
    const unregistered = closure.filter((m) => !(m in EAGER_REGISTER));
    expect(
      unregistered,
      `these modules are now downloaded before anything renders. If that is ` +
        `intended, add them to EAGER_REGISTER with the reason; otherwise move ` +
        `the import behind \`lazy(() => import(…))\` or a dynamic import.`,
    ).toEqual([]);
  });

  it('still contains everything that is registered', () => {
    const gone = Object.keys(EAGER_REGISTER).filter((m) => !closure.includes(m));
    expect(
      gone,
      'these register entries no longer describe a real eager import — delete them ' +
        'rather than leaving them to license a future one',
    ).toEqual([]);
  });

  it('stays small enough to be read in one sitting', () => {
    // Not a byte budget — a count. The point is that somebody can look at the
    // register above and hold the whole first paint in their head; a graph
    // that has drifted into the hundreds cannot be reasoned about at all.
    expect(closure.length).toBeLessThanOrEqual(40);
  });
});

describe('heavy payloads stay behind their split', () => {
  for (const { module, importers, why } of HEAVY_PAYLOADS) {
    it(`only ${importers.join(', ')} imports ${module} statically — ${why}`, () => {
      const spec = new RegExp(
        `(?:^|\\n)\\s*(?:import|export)\\s+(?:type\\s+)?[^;]*?from\\s*['"][^'"]*${module}['"]`,
      );
      const found = ALL_FILES.filter((f) => spec.test(f.text)).map((f) => f.file);
      expect(found.sort()).toEqual([...importers].sort());
    });

    it(`${module} is not on the first-paint path`, () => {
      expect(eagerClosure().some((m) => m.startsWith(module))).toBe(false);
    });
  }
});
