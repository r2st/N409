/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildRobotsTxt, buildSitemapXml } from './src/lib/sitemap';

/**
 * Client-visible config sourced from the build environment (409.ai §23/§24).
 * Analytics container ids and the canonical site origin are configured per
 * environment — never hardcoded. We accept both the bare names (`GTM_ID`) and
 * the Vite-prefixed forms (`VITE_GTM_ID`) and expose them under `VITE_*`.
 */
function clientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const pick = (name: string): string => (env[name] ?? env[`VITE_${name}`] ?? '').trim();
  return {
    'import.meta.env.VITE_GTM_ID': JSON.stringify(pick('GTM_ID')),
    'import.meta.env.VITE_GA4_ID': JSON.stringify(pick('GA4_ID')),
    'import.meta.env.VITE_FB_PIXEL_ID': JSON.stringify(pick('FB_PIXEL_ID')),
    'import.meta.env.VITE_SITE_URL': JSON.stringify(pick('SITE_URL')),
  };
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

const siteUrl = (process.env.SITE_URL ?? process.env.VITE_SITE_URL ?? 'https://www.n409.ai').trim();

export default defineConfig({
  plugins: [react(), tailwindcss(), seoFilesPlugin(siteUrl)],
  define: clientEnv(process.env),
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
