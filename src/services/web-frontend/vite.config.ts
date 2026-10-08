/// <reference types="vitest/config" />
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildRobotsTxt, buildSitemapXml } from './src/lib/sitemap';
import { buildManifest, prerenderPages, withFontPreloads, withRoutePreloads } from './src/lib/prerender';
import { routeModuleFor } from './src/lib/routeChunks';
import { allPageMeta } from './src/lib/pageMetaRoutes';

/**
 * Client-visible config sourced from the build environment (409.ai §23/§24).
 * Analytics container ids and the canonical site origin are configured per
 * environment — never hardcoded. We accept both the bare names (`GTM_ID`) and
 * the Vite-prefixed forms (`VITE_GTM_ID`) and expose them under `VITE_*`.
 */
/**
 * The deploy's `BUILD_SHA`, or '' when there isn't one.
 *
 * Read from the repo root rather than an environment variable because that is
 * where the deploy actually puts it: `deploy.sh` unpacks the archive (BUILD_SHA
 * is a tracked file in it) and then runs `npm run build` on the host with
 * nothing exported. Failing to read it is not a build failure — an unknown
 * release is a slightly weaker crash report, not a broken bundle.
 */
function buildShaFile(): string {
  try {
    return readFileSync(path.resolve(import.meta.dirname, '../../../BUILD_SHA'), 'utf8').trim();
  } catch {
    return '';
  }
}

function clientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const pick = (name: string): string =>
    (env[name] ?? env[`VITE_${name}`] ?? (name === 'BUILD_SHA' ? buildShaFile() : '') ?? '').trim();
  const names = [
    'GTM_ID',
    'GA4_ID',
    'FB_PIXEL_ID',
    'SITE_URL',
    // Marketing surface (src/lib/siteConfig.ts). Unset → the corresponding CTA,
    // embed, or address is omitted rather than rendered as a dead link.
    'CALENDLY_URL',
    'DEMO_VIDEO_URL',
    'TWITTER_URL',
    'LINKEDIN_URL',
    'PARTNERS_EMAIL',
    'PRIVACY_EMAIL',
    'SUPPORT_EMAIL',
    // The commit this bundle was built from, so a crash report can say whether
    // the tab was running the release that is currently deployed. Read from the
    // environment or, on the box, from the BUILD_SHA the deploy unpacked —
    // `npm run build` runs there with no such variable set. Empty is fine and
    // means "unknown", which is what a dev build is.
    'BUILD_SHA',
  ];
  return Object.fromEntries(
    names.map((name) => [`import.meta.env.VITE_${name}`, JSON.stringify(pick(name))]),
  );
}

/** Emit sitemap.xml + robots.txt at build, and serve them from the dev server. */
function seoFilesPlugin(baseUrl: string): Plugin {
  return {
    name: 'n409-seo-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/sitemap.xml') {
          res.setHeader('Content-Type', 'application/xml');
          res.end(buildSitemapXml(baseUrl, undefined, new Date().toISOString().slice(0, 10)));
          return;
        }
        if (req.url === '/robots.txt') {
          res.setHeader('Content-Type', 'text/plain');
          res.end(buildRobotsTxt(baseUrl));
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemapXml(baseUrl, undefined, new Date().toISOString().slice(0, 10)) });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: buildRobotsTxt(baseUrl) });
    },
  };
}

/**
 * Bake each marketing route's `<head>` into its own static document.
 *
 * Runs in `closeBundle`, after Vite has written `index.html` with its hashed
 * asset tags, so every prerendered page carries the same (correct) script and
 * stylesheet references. Emits a manifest the web service reads to map a
 * request path to its document — the service never derives a file path from
 * user input.
 */
function prerenderPlugin(baseUrl: string): Plugin {
  let outDir = 'dist';
  let root = process.cwd();
  let enabled = false;
  /** Source module (absolute path) → the chunk Rollup emitted for it, plus that
   * chunk's own static imports. Collected in `generateBundle`, where the chunk
   * graph exists; `closeBundle` only has the files on disk. */
  let chunkForModule = new Map<string, string[]>();
  return {
    name: 'n409-prerender',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
      // SSR/library passes reuse this config but emit no index.html.
      enabled = !config.build.ssr;
    },
    generateBundle(_options, bundle) {
      chunkForModule = new Map();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.facadeModuleId) continue;
        chunkForModule.set(output.facadeModuleId, [output.fileName, ...output.imports]);
      }
    },
    closeBundle() {
      if (!enabled) return;
      const shellPath = path.join(outDir, 'index.html');
      let shell: string;
      try {
        shell = readFileSync(shellPath, 'utf8');
      } catch {
        this.warn(`prerender skipped — no index.html at ${shellPath}`);
        return;
      }

      // Font filenames are content-hashed, so the preload hrefs can only be
      // resolved once the assets are on disk.
      let assets: string[] = [];
      try {
        assets = readdirSync(path.join(outDir, 'assets')).map((name) => `assets/${name}`);
      } catch {
        this.warn('prerender: no assets directory — skipping font preloads');
      }
      shell = withFontPreloads(shell, assets);

      const pages = prerenderPages(shell, baseUrl, allPageMeta());
      let preloaded = 0;
      for (const page of pages) {
        // A route with no registry entry, or one already in the entry chunk,
        // gets no extra preload — it costs a round trip, not a broken page.
        const moduleId = routeModuleFor(page.route);
        const chunks = moduleId ? (chunkForModule.get(path.resolve(root, moduleId)) ?? []) : [];
        if (chunks.length > 0) preloaded += 1;
        const dest = path.join(outDir, page.fileName);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, withRoutePreloads(page.html, chunks), 'utf8');
      }
      writeFileSync(
        path.join(outDir, 'prerender-manifest.json'),
        `${JSON.stringify(buildManifest(pages), null, 2)}\n`,
        'utf8',
      );
      this.info?.(`prerendered ${pages.length} marketing routes; ${preloaded} carry their own chunk preload`);
    },
  };
}

const siteUrl = (process.env.SITE_URL ?? process.env.VITE_SITE_URL ?? 'https://409.doaide.com').trim();

export default defineConfig({
  plugins: [react(), tailwindcss(), seoFilesPlugin(siteUrl), prerenderPlugin(siteUrl)],
  define: clientEnv(process.env),
  build: {
    // The single 1 MB bundle meant a founder landing on the marketing page
    // downloaded the entire authenticated application — the valuation
    // workspace, admin screens, charts and rich-text editor included — before
    // anything rendered. Routes are lazy-loaded (see src/App.tsx) and the
    // long-lived dependencies are pinned to their own chunks so a release
    // doesn't invalidate them in every visitor's cache.
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-dom/client'],
          'vendor-router': ['react-router-dom'],
          'vendor-helmet': ['react-helmet-async'],
        },
      },
    },
    // With splitting in place no legitimate chunk should approach this; if one
    // does, the build should complain rather than quietly regress.
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    // The valuation service's own PORT is configurable, and a developer running
    // two checkouts (or an agent alongside a local stack) needs the dev proxy to
    // follow it. Same variable name the web service uses for the same target.
    proxy: { '/api': (process.env.VALUATION_URL ?? 'http://localhost:3001').trim() },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // Vitest's 5s default is enough for a plain run and not enough under v8
    // instrumentation: the two `ContactForm` cases drive `userEvent`, which
    // types a character at a time through a jsdom tree, and coverage roughly
    // triples the per-keystroke cost. They passed bare and timed out under
    // `--coverage` — so the one command that measures whether this package is
    // tested was the one command that could not complete. A timeout that only
    // fires when the harness is instrumented is measuring the harness.
    testTimeout: 30000,
    coverage: {
      // Enforced coverage floor (audit P2-2). Set at the current measured level
      // (a point or two below) so CI can't silently regress — the TS analogue of
      // the Python services' `--cov-fail-under=80`. Ratchet upward over time.
      // Ratcheted with the round-14 push, which tested the five components
      // that had no test of their own: measured 90.52 lines/statements,
      // 85.49 branches, 72.95 functions.
      // Ratcheted again with the partner portal (which had no test at all) and
      // the ASC 718 workspace (the package's lowest file, tested for its
      // tooltips only): measured 93.29 lines/statements, 86.63 branches,
      // 76.50 functions.
      // Ratcheted with the round-16 push through the five lowest-covered files
      // — the fund portfolio, the comparables tab, the auditor portal, the
      // billing section and the org-assignment card, four of which were
      // hiding a swallowed load error: measured 95.17 lines/statements,
      // 87.45 branches, 79.73 functions.
      // Ratcheted again with the round-24 push through the four lowest-covered
      // files — the cap-table workbook upload, the live-sync panel, the
      // worklist's filter/sort/export/pager, and the methodology panel's
      // engagement basics, approach weights, allocation methods and PWERM
      // grid: measured 97.45 lines/statements, 89.18 branches, 86.41
      // functions.
      // Ratcheted on the round that went after the *handlers* rather than the
      // files — the financial model's row edits, the marketing header's two
      // menus under a pointer and a finger, and `InfoTooltip` across all
      // three input devices: measured 97.78 lines/statements, 89.73
      // branches, 88.46 functions. Functions was the weak metric and moved
      // 1.5 points; it is the one worth raising.
      // Ratcheted again on the round that went after the untested *mutations*
      // — the auditor link revoke, the onboarding upload, the signature
      // remove, the portfolio create, the report editor's toolbar: measured
      // 98.04 statements/lines, 90.10 branches, 92.85 functions.
      //
      // The gap between measured and gate is chosen per metric, in items
      // rather than percent, because the metrics are wildly different sizes:
      // one point of `functions` is 19 functions but one point of
      // `statements` is 422. A gate set just under the measured percentage
      // leaves ~17 statements of headroom, which is one modest untested
      // helper away from failing a run that regressed nothing. These leave
      // roughly 60–230 items of slack each — enough that the gate fires on a
      // real regression and not on noise.
      thresholds: {
        lines: 97.5,
        statements: 97.5,
        functions: 92,
        branches: 89.5,
      },
    },
  },
});
