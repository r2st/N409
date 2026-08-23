import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { httpsUrl, isHttpsUrl } from '../../src/domain/externalUrl.js';
import { BRANDING_PATCH_SCHEMA } from '../../src/domain/branding.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * `z.string().url()` is a parse, not a policy.
 *
 * Five settings hold an address someone else's browser is later sent to or
 * fetches from — a firm's logo, dark logo and favicon, the partner logo the ops
 * console sets on their behalf, and the SAML IdP entry point — and all five
 * accepted every scheme WHATWG will parse. The `http:` case is the one that
 * bites: the application is served over HTTPS, so an `http:` logo is blocked
 * as mixed content and never appears, silently, while the setting reads as
 * saved because it was. The help text beside those boxes has always said
 * "HTTPS URL".
 *
 * Same shape as `likePatternCensus`: the behavioural tests below cover the
 * five that exist, and the source scan covers the sixth.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The `src/` tree: this file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../../..');

const ROOTS = ['services/valuation/src', 'services/web/src', 'services/report/src', 'packages'];

const isBuildOutput = (file: string): boolean => file.split(path.sep).includes('dist');

/** `z.string().url()`, however much is chained on either side of it. */
const BARE_URL = /\.url\(\)/;

/**
 * Comment lines are skipped.
 *
 * Four places *discuss* the spelling — this file's own subject matter is one —
 * and a census that cannot tell a schema from a sentence about a schema either
 * fails for prose or gets muzzled to stop it. The test for whether the skip has
 * gone too far is the vacuity guard below: it requires a real one to be found.
 */
const isProse = (line: string): boolean => /^(\/\/|\/\*|\*)/.test(line.trim());

/**
 * The one file allowed to keep it, and the reason.
 *
 * `config.ts` holds the addresses of our *own* processes — `AI_URL`,
 * `ENGINE_URL`, `REPORT_URL` — which are `http://127.0.0.1:300x` on the box and
 * have to stay that way: they are loopback, no browser ever sees them, and
 * requiring TLS between two processes on the same host would mean issuing
 * certificates for 127.0.0.1. It is a path rather than a basename because a
 * second `config.ts` elsewhere would be a second exemption.
 */
const ALLOWED = 'services/valuation/src/config.ts';

interface Hit {
  file: string;
  line: number;
  text: string;
}

function bareUrlSchemas(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(SRC, root))) {
      if (isBuildOutput(file)) continue;
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isProse(line)) return;
          const m = BARE_URL.exec(line);
          if (m) hits.push({ file: rel, line: i + 1, text: line.trim() });
        });
    }
  }
  return hits;
}

describe('a configured URL a browser will follow', () => {
  const hits = bareUrlSchemas();

  it('scans every tree it claims to', () => {
    for (const root of ROOTS) expect(existsSync(path.join(SRC, root)), root).toBe(true);
  });

  it('can still see the spelling it is looking for', () => {
    // The vacuity guard. Every assertion below passes for a scan that finds
    // nothing, and this one is a rename away from finding nothing.
    expect(hits.map((h) => h.file)).toContain(ALLOWED);
  });

  it('leaves the unconstrained spelling nowhere but the loopback config', () => {
    const strays = hits.filter((h) => h.file !== ALLOWED).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(strays).toEqual([]);
  });
});

describe('httpsUrl', () => {
  const schema = httpsUrl(2000);

  it('accepts an https address', () => {
    expect(schema.safeParse('https://cdn.example.com/logo.svg').success).toBe(true);
  });

  it('rejects the http one that a browser would refuse to load anyway', () => {
    // The whole point: this is the value that saves cleanly and then does
    // nothing, because the page is HTTPS and the image is not.
    expect(schema.safeParse('http://cdn.example.com/logo.svg').success).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'ftp://files.example.com/logo.png'])(
    'rejects %s',
    (value) => {
      expect(schema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects a relative path, which was never accepted and is not now', () => {
    // Nothing on the platform serves an uploaded logo from its own origin, so
    // `/assets/logo.svg` is a mistake rather than a same-origin asset.
    expect(schema.safeParse('/assets/logo.svg').success).toBe(false);
  });

  it('rejects a scheme with nothing after it', () => {
    expect(schema.safeParse('https://').success).toBe(false);
  });

  it('still enforces the length cap the column has', () => {
    const long = `https://cdn.example.com/${'a'.repeat(2000)}`;
    expect(httpsUrl(2000).safeParse(long).success).toBe(false);
  });

  it('says what is wrong rather than that something is', () => {
    const parsed = schema.safeParse('http://cdn.example.com/logo.svg');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('https://');
  });

  it('reads the scheme rather than the prefix', () => {
    // A host that merely starts with the letters is not the scheme, and a
    // scheme in capitals is still the scheme — which is why this parses the
    // URL instead of matching `^https://`.
    expect(isHttpsUrl('http://https.example.com/logo.svg')).toBe(false);
    expect(isHttpsUrl('HTTPS://cdn.example.com/logo.svg')).toBe(true);
  });

  it('composes with nullable, so "unset" is still how you clear one', () => {
    expect(z.object({ logo_url: httpsUrl(2000).nullable() }).safeParse({ logo_url: null }).success).toBe(
      true,
    );
  });
});

describe('the branding patch a firm administrator submits', () => {
  it('takes an https logo', () => {
    const parsed = BRANDING_PATCH_SCHEMA.safeParse({ logo_url: 'https://cdn.example.com/a.svg' });
    expect(parsed.success).toBe(true);
  });

  it.each(['logo_url', 'logo_dark_url', 'favicon_url'] as const)('refuses an http %s', (key) => {
    const parsed = BRANDING_PATCH_SCHEMA.safeParse({ [key]: 'http://cdn.example.com/a.svg' });
    expect(parsed.success).toBe(false);
  });
});
