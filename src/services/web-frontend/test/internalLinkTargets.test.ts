import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every internal link in the app points at a route the app declares.
 *
 * The dashboard's "Recent activity" band offered ops a "View all →" to
 * `/activity`. The activity log is at `/admin/activity`, and has been since it
 * was built — the sidebar says so. `/activity` matches nothing, so it fell
 * through to `<Route path="*">` and rendered the 404 page: a link on the first
 * screen after sign-in, visible only to operators, that could not work.
 *
 * Nothing was going to catch it. A broken `<Link>` is not a type error, React
 * Router does not warn, and a page test renders the page rather than following
 * what it points at — the target is another route entirely, usually in another
 * lazily-loaded chunk. The only place the two facts meet is here: the set of
 * link targets in the source, and the set of paths `App.tsx` declares.
 *
 * Templated targets are checked too — `/valuations/${id}` has to land on a
 * route with a parameter in that position, not on a literal one. That is what
 * makes this more than a spellcheck: `/partners/:segment` and
 * `/partner/:slug/login` are one character apart and go to different places.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');
const REPO = path.resolve(here, '..');
const APP = path.join(SRC, 'App.tsx');

/**
 * Stands in for an interpolated segment, which can be anything at runtime.
 * Chosen to be something no real path segment can be, so it cannot collide
 * with a literal the matcher is comparing against.
 */
const DYNAMIC = '<interpolated>';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The absolute paths `App.tsx` routes.
 *
 * Nesting has to be composed, not ignored. The workspace declares
 * `<Route path="/valuations/:id">` with thirty relative children — `documents`,
 * `report`, `audit-trail` — and dropping the ones that do not start with `/`
 * would leave every link to a workspace tab looking broken. Those thirty are
 * the ones most worth checking.
 *
 * The tag is scanned rather than matched with one regex: `element={<Tab />}`
 * contains a `>` of its own, so the first `>` after `<Route` is usually not the
 * end of the tag, and the difference between `>` and `/>` is exactly what says
 * whether the next route is a child or a sibling.
 */
function routePatterns(): string[] {
  const src = readFileSync(APP, 'utf8');
  const out: string[] = [];
  const stack: string[] = [];
  const token = /<Route\b|<\/Route>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(src)) !== null) {
    if (m[0] === '</Route>') {
      stack.pop();
      continue;
    }
    let i = m.index + '<Route'.length;
    let depth = 0;
    let quote = '';
    for (; i < src.length; i += 1) {
      const c = src[i]!;
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    const parent = stack[stack.length - 1] ?? '';
    const declared = /\spath="([^"]*)"/.exec(tag)?.[1] ?? '';
    const full = declared.startsWith('/') ? declared : `${parent}/${declared}`.replace(/\/+/g, '/');
    if (declared) out.push(full);
    if (!tag.trimEnd().endsWith('/>')) stack.push(declared ? full : parent);
  }
  /*
   * The 404 catch-all is not a destination.
   *
   * `<Route path="*">` normalises to `/*` here, and a splat with nothing in
   * front of it matches every path there is — so every link "routed", and this
   * census passed while pointing straight at the broken link it was written to
   * find. That is worse than not existing: the green tick is what stops anyone
   * looking. Falling through to `NotFoundPage` *is* the failure, so the route
   * that renders it cannot be in the set a link is allowed to land on.
   *
   * A splat with a real prefix (`/partner/:slug/*`) is a genuine destination
   * and stays — there are none today, and the day one appears it should work
   * without anybody remembering this.
   */
  return out.filter((p) => p !== '/*');
}

interface LinkRef {
  file: string;
  line: number;
  /** Normalised: query and hash dropped, interpolations collapsed. */
  target: string;
  /** As written, for the failure message. */
  raw: string;
}

/**
 * `to`/`href` targets that are paths within this app.
 *
 * Skipped: absolute URLs, `mailto:`/`tel:`, bare fragments, and `/api/…` —
 * those are the service's own endpoints, reached by a form post or a full
 * navigation, and they are deliberately not routes.
 */
function internalLinks(): LinkRef[] {
  const glued = new RegExp(`[^/]*${DYNAMIC}[^/]*`, 'g');
  const out: LinkRef[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(REPO, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const quoted = [...line.matchAll(/\b(?:to|href)="(\/[^"]*)"/g)].map((m) => m[1]!);
        const templated = [...line.matchAll(/\b(?:to|href)=\{`(\/[^`]*)`\}/g)].map((m) => m[1]!);
        for (const raw of [...quoted, ...templated]) {
          if (raw.startsWith('/api/')) continue;
          const target = raw
            .split(/[?#]/)[0]!
            .replace(/\$\{[^}]*\}/g, DYNAMIC)
            // An interpolation glued to literal text is still one dynamic
            // segment as far as matching goes.
            .replace(glued, DYNAMIC);
          out.push({ file: rel, line: i + 1, target, raw });
        }
      });
  }
  return out;
}

function segments(p: string): string[] {
  return p.split('/').filter(Boolean);
}

export function routeMatches(target: string, pattern: string): boolean {
  const t = segments(target);
  const p = segments(pattern);
  if (pattern.endsWith('/*')) return p.slice(0, -1).every((seg, i) => seg === t[i]);
  if (t.length !== p.length) return false;
  // A route parameter accepts anything, literal or interpolated. A literal
  // accepts only itself: an interpolated value is not known to equal it.
  return p.every((seg, i) => seg.startsWith(':') || seg === t[i]);
}

describe('internal links land on declared routes', () => {
  const routes = routePatterns();
  const links = internalLinks();

  it('finds both halves at all', () => {
    // The vacuity guard: a refactor that moves the route table, or that builds
    // link targets through a helper, silently turns this into a test of two
    // empty lists. It has to fail then, not pass.
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(links.length).toBeGreaterThanOrEqual(60);
    expect(routes).toContain('/valuations');
  });

  it('does not route a target that goes nowhere', () => {
    /*
     * The vacuity guard that was missing, and that this census needed most.
     *
     * `routeMatches` was sound and the route table was read correctly; what
     * made the assertion below unfailable was a single entry *in* that table —
     * the 404 catch-all, `/*`, which matches everything. Neither the count
     * guard above nor the `routeMatches` unit checks below could see it,
     * because both look at the two halves separately and the fault was in the
     * join. So ask the real question of the real route table: a path the app
     * does not serve must not route.
     */
    expect(routes.some((r) => routeMatches('/definitely-not-a-route', r))).toBe(false);
    expect(routes.some((r) => routeMatches('/valuations', r))).toBe(true);
  });

  it('routes every target', () => {
    const broken = links
      .filter((l) => !routes.some((r) => routeMatches(l.target, r)))
      .map((l) => `${l.file}:${l.line}  ${l.raw}`);
    expect(broken).toEqual([]);
  });

  it('recognises a wrong target when it is given one', () => {
    // The guard on the guard: a `routeMatches` that returned true for
    // everything would make the assertion above vacuous, and nothing else here
    // would say so.
    expect(routeMatches('/activity', '/admin/activity')).toBe(false);
    expect(routeMatches('/admin/activity', '/admin/activity')).toBe(true);
    expect(routeMatches(`/valuations/${DYNAMIC}`, '/valuations/:id')).toBe(true);
    expect(routeMatches(`/valuations/${DYNAMIC}`, '/valuations')).toBe(false);
    expect(routeMatches(`/${DYNAMIC}`, '/valuations')).toBe(false);
    expect(routeMatches('/partners/x', '/partner/:slug/login')).toBe(false);
  });
});
