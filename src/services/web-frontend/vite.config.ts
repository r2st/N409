/// <reference types="vitest/config" />
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildRobotsTxt, buildSitemapXml } from './src/lib/sitemap';
import { buildManifest, prerenderPages, withFontPreloads } from './src/lib/prerender';
import { allPageMeta } from './src/lib/pageMeta';

/**
 * Client-visible config sourced from the build environment (409.ai §23/§24).
 * Analytics container ids and the canonical site origin are configured per
 * environment — never hardcoded. We accept both the bare names (`GTM_ID`) and
 * the Vite-prefixed forms (`VITE_GTM_ID`) and expose them under `VITE_*`.
 */
function clientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const pick = (name: string): string => (env[name] ?? env[`VITE_${name}`] ?? '').trim();
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
          res.end(buildSitemapXml(baseUrl));
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
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemapXml(baseUrl) });
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
  let enabled = false;
  return {
    name: 'n409-prerender',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      // SSR/library passes reuse this config but emit no index.html.
      enabled = !config.build.ssr;
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
      for (const page of pages) {
        const dest = path.join(outDir, page.fileName);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, page.html, 'utf8');
      }
      writeFileSync(
        path.join(outDir, 'prerender-manifest.json'),
        `${JSON.stringify(buildManifest(pages), null, 2)}\n`,
        'utf8',
      );
      this.info?.(`prerendered ${pages.length} marketing routes`);
    },
  };
}

const siteUrl = (process.env.SITE_URL ?? process.env.VITE_SITE_URL ?? 'https://www.n409.ai').trim();

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
    coverage: {
      // Enforced coverage floor (audit P2-2). Set at the current measured level
      // (a point or two below) so CI can't silently regress — the TS analogue of
      // the Python services' `--cov-fail-under=80`. Ratchet upward over time.
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 52,
        branches: 77,
      },
    },
  },
});
