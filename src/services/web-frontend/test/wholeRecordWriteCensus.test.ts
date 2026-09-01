import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A form that saved fewer fields than the save writes.
 *
 * `PUT` in this API means "here is the record" — the handler validates a body
 * whose schema supplies a default for anything the caller left out, and hands
 * the whole thing to an upsert. That contract is fine as long as the only
 * caller sends the whole record. When it does not, the fields it omits are not
 * left alone: they are written back as the schema's defaults, by a request the
 * user thinks is about something else entirely.
 *
 * `PUT /funds/:id/lp-terms` is the one this census was written for. The
 * waterfall card carried five of the eight LP-terms columns, so every "Save LP
 * terms" click reset the management fee to 2% and zeroed both the management
 * fees paid and the GP distributions to date. Nothing else in the product
 * writes those three, so a fund could not hold a real value for them at all —
 * while the waterfall subtracted them from the GP's share and the NAV exhibit
 * printed them in the fund report. A reset that nothing reports, on figures
 * that change what the report says the GP is owed.
 *
 * So the rule is stated once, here: for every `app.put` in the valuation
 * service whose body schema is a whole record — at least one field that is not
 * `.optional()`, so an omitted field takes a value rather than being skipped —
 * the client call that drives it must send every field the schema names, or
 * spread the stored record to carry the rest (what `Asc718Tab` does). An
 * endpoint with no client caller, or one whose client legitimately sends less,
 * is listed in {@link EXEMPT} with the reason.
 *
 * The census reads both sides from source rather than exercising a route,
 * because the failure is a *missing* key: no request this client makes is
 * malformed, and no response says anything is wrong.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(here, '../src');
const ROUTES = path.resolve(here, '../../valuation/src/routes');

/**
 * Endpoints this rule does not reach, and why.
 *
 * A census whose exceptions are implicit is one nobody can audit, so each
 * entry says what makes the endpoint's short body correct — not merely that
 * nobody got to it.
 */
const EXEMPT: Record<string, string> = {
  '/api/v1/valuations/:id/cap-table':
    'A tagged union rather than a record: `format` picks one arm, and the fields of the other arms are exactly the ones a well-formed body must not carry. Sending "every key" here would be the malformed request.',
  '/api/v1/valuations/:id/overwrites/:field_key':
    '`reason` and `original_value` are optional; `value` is the record, and OverwritesTab sends it. The optional pair is captured on first write and deliberately not re-sent.',
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
};

/** The contents of the brace-delimited block starting at or after `from`. */
function block(src: string, from: number): string | null {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/**
 * The top-level `key: value` pairs of an object literal.
 *
 * Depth-tracked and anchored to the start of a line, so a `message:` inside a
 * nested `.refine()` and a `?:` inside a ternary are both invisible to it. The
 * whole census turns on this being right: a parser that under-reads the schema
 * passes vacuously.
 */
function entries(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let key: string | null = null;
  let value = '';
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
      if (m) {
        if (key) out.set(key, value);
        key = m[1]!;
        value = '';
      }
    }
    if (key) value += line + '\n';
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
  }
  if (key) out.set(key, value);
  return out;
}

/** `/funds/${id}/lp-terms` and `/api/v1/funds/:id/lp-terms` compare equal. */
const shape = (p: string): string =>
  p
    .replace(/^\/api\/v1/, '')
    .replace(/\$\{[^}]+\}/g, '*')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '*')
    .replace(/\/$/, '');

interface ServerWrite {
  route: string;
  file: string;
  keys: string[];
}

/** Every `app.put` whose body schema takes a whole record. */
function serverWrites(): ServerWrite[] {
  const found: ServerWrite[] = [];
  for (const file of walk(ROUTES)) {
    const src = readFileSync(file, 'utf8');

    const schemas = new Map<string, Map<string, string>>();
    const patchLike = new Set<string>();
    for (const m of src.matchAll(/const (\w+)\s*=\s*(?:z\s*\.\s*object\(|[A-Z_]+\s*\n?\s*\.\s*partial\(\))/g)) {
      if (m[0].includes('.partial()')) {
        patchLike.add(m[1]!);
        continue;
      }
      const b = block(src, m.index + m[0].length - 1);
      if (b) schemas.set(m[1]!, entries(b));
    }

    for (const m of src.matchAll(/app\.put\(\s*'([^']+)'/g)) {
      const handler = src.slice(m.index, m.index + 6000);
      const use = /(\w+)\.safeParse\(req\.body\)/.exec(handler);
      if (!use) continue;
      const name = use[1]!;
      if (patchLike.has(name)) continue;
      const schema = schemas.get(name);
      expect(schema, `${path.basename(file)}: no schema found for ${name} on ${m[1]}`).toBeDefined();
      const fields = [...schema!];
      // A schema where every field is `.optional()` is a PATCH wearing PUT's
      // spelling: an omitted field is skipped, not defaulted, so a partial
      // body is the intended way to call it.
      if (fields.every(([, v]) => v.includes('.optional()'))) continue;
      found.push({ route: m[1]!, file: path.basename(file), keys: fields.map(([k]) => k) });
    }
  }
  return found;
}

interface ClientWrite {
  file: string;
  line: number;
  path: string;
  keys: string[];
  spreads: boolean;
}

/** Every `api(path, { method: 'PUT', body: { … } })` in the client. */
function clientWrites(): ClientWrite[] {
  const found: ClientWrite[] = [];
  for (const file of walk(CLIENT_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bapi[A-Za-z]*\s*(?:<[^(]*>)?\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*\{/g)) {
      const opts = block(src, m.index + m[0].length - 1);
      if (!opts || !/method:\s*'PUT'/.test(opts)) continue;
      const at = opts.search(/^\s*body:\s*\{/m);
      if (at < 0) continue;
      const body = block(opts, at);
      if (body === null) continue;
      found.push({
        file: path.relative(CLIENT_SRC, file),
        line: src.slice(0, m.index).split('\n').length,
        path: m[1]!,
        keys: [...entries(body).keys()],
        spreads: /^\s*\.\.\./m.test(body),
      });
    }
  }
  return found;
}

describe('whole-record writes carry the whole record', () => {
  const server = serverWrites();
  const client = clientWrites();

  it('finds both halves — a census reading nothing passes for the wrong reason', () => {
    expect(server.length).toBeGreaterThanOrEqual(6);
    expect(client.length).toBeGreaterThanOrEqual(6);
    // The endpoint this file was written for has to be one of them.
    expect(server.map((s) => s.route)).toContain('/api/v1/funds/:id/lp-terms');
  });

  it('every exemption names a route that still exists', () => {
    const routes = new Set(server.map((s) => s.route));
    for (const route of Object.keys(EXEMPT)) expect(routes, route).toContain(route);
  });

  it.each(server.filter((s) => !(s.route in EXEMPT)).map((s) => [s.route, s] as const))(
    '%s',
    (route, write) => {
      const callers = client.filter((c) => shape(c.path) === shape(route));
      expect(
        callers.length,
        `${route} (${write.file}) has no client caller and no entry in EXEMPT — say why the rule does not reach it`,
      ).toBeGreaterThan(0);

      for (const caller of callers) {
        if (caller.spreads) continue; // carries the stored record forward
        const missing = write.keys.filter((k) => !caller.keys.includes(k));
        expect(
          missing,
          `${caller.file}:${caller.line} PUTs ${route} without ${missing.join(', ')} — the handler will write ${missing.length === 1 ? 'that field' : 'those fields'} back as the body schema's default`,
        ).toEqual([]);
      }
    },
  );
});
