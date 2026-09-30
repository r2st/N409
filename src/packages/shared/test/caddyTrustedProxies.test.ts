// The edge and the app have to trust the same hops.
//
// Resolving a client IP behind Cloudflare takes two cooperating decisions, in
// two different config languages, and either one alone does nothing:
//
//   - Caddy must be told which peers may supply an X-Forwarded-For. Without it
//     (2.7+ default) it OVERWRITES the header with the immediate peer, so the
//     client's address is discarded at the edge and no amount of trust further
//     in can recover it.
//   - The app must be told the same, or proxy-addr stops walking at the
//     Cloudflare address that Caddy appended.
//
// Both were wrong in production until R88, and fixing only one of them changed
// nothing measurable — which is exactly why the two lists drifting apart later
// would be so hard to notice. A range present in one and not the other silently
// reinstates the original bug for the POPs in it, for as long as nobody
// compares two files nobody reads together.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_RANGES } from '../src/clientIp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CADDY = path.resolve(here, '../../../../infra/caddy/409.doaide.com.caddy');

/** The `trusted_proxies static …` arguments, as Caddy would read them. */
function caddyTrustedProxies(): string[] {
  const text = readFileSync(CADDY, 'utf8');
  // Only a real directive line: the same words appear in this file's prose,
  // and matching those would let the test pass on a config that says the right
  // thing in a comment and does nothing.
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('trusted_proxies static '));
  if (line === undefined) throw new Error(`no "trusted_proxies static" directive in ${CADDY}`);
  return line.slice('trusted_proxies static '.length).split(/\s+/).filter(Boolean);
}

describe('the Caddy trusted-proxy list and the app trusted-proxy list', () => {
  it('name exactly the same ranges', () => {
    expect(caddyTrustedProxies()).toEqual(CLOUDFLARE_RANGES);
  });

  // Order does not matter to either reader, but "same set" is the property
  // worth stating separately: a diff on the array above is easy to misread as
  // a reordering when it is an addition or a removal.
  it('name the same set, whatever the order', () => {
    expect(new Set(caddyTrustedProxies())).toEqual(new Set(CLOUDFLARE_RANGES));
  });

  // The directive must be in the global options block. Caddy only reads
  // `servers { … }` there, and a `trusted_proxies` placed inside a site block
  // is a parse error rather than a silent no-op — but the global block must
  // also be *first* in the file it is pasted into, which is the part a reader
  // has to be told.
  it('sits inside a servers block', () => {
    const text = readFileSync(CADDY, 'utf8');
    const directive = text.indexOf('trusted_proxies static ');
    const servers = text.lastIndexOf('servers {', directive);
    expect(servers).toBeGreaterThan(-1);
    expect(text.slice(servers, directive)).not.toContain('}');
  });

  // The routing this file exists to describe, pinned because getting it wrong
  // fails somewhere nobody looks: SCIM lives on the valuation service and is
  // outside the web service's /api proxy, so a lost route here is a 404 in an
  // IdP's provisioning job.
  it('routes /scim/v2 to the valuation service and everything else to web', () => {
    const text = readFileSync(CADDY, 'utf8');
    const scim = text.indexOf('handle /scim/v2/*');
    const catchAll = text.search(/^\thandle \{$/m);
    expect(scim).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    // `handle` blocks are first-match-wins, so the specific one must come
    // first. Reversed, SCIM goes to a service that has no such routes.
    expect(scim).toBeLessThan(catchAll);
    expect(text.slice(scim, catchAll)).toContain('reverse_proxy localhost:3001');
    expect(text.slice(catchAll)).toContain('reverse_proxy localhost:3000');
  });

  // What the previous version of this file said, and what made it dangerous:
  // there is no Docker on the host at all, so anything dialling the Docker
  // bridge describes a deployment that cannot reach its own backend.
  it('does not name a Docker upstream', () => {
    // Directive lines only. The header comment discusses `host.docker.internal`
    // at length precisely because that is what this file used to say, and a
    // test that read the prose would fail on the explanation rather than on
    // the config — the same distinction the trusted_proxies parse above makes.
    const directives = readFileSync(CADDY, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'));
    expect(directives.join('\n')).not.toContain('host.docker.internal');
  });
});
