import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { problemCalls } from './errorBodyDisclosure.test.js';

/**
 * The sibling rule to `errorBodyDisclosure`, over the other untrusted source
 * (round 287, methodology M19).
 *
 * That census asks whether a route publishes wording it did not author, and
 * answers it for *caught errors*. The second way a route publishes something
 * it did not write is by naming what it refused:
 *
 *     const { field_key } = req.params as { field_key: string };
 *     const def = OVERWRITE_FIELDS_BY_KEY.get(field_key);
 *     if (!def) throw problems.notFound(`Unknown overwrite field '${field_key}'`);
 *
 * Naming it is right — "unknown field" without the field is a worse answer.
 * But the value on that line is, by construction, the one that did *not* match
 * anything the server knows: it is whatever the caller put in the URL. A path
 * segment has no schema and no length bound of its own. It reaches the `detail`
 * of an RFC 9457 body, which the SPA draws, a terminal prints and a partner
 * writes into their own log — carrying up to a header's worth of text, control
 * characters, the bidi reordering marks that made an attachment's extension
 * read backwards in round 227, and the quote that closes the quoting the
 * message put around it.
 *
 * `quoteForMessage` is the answer already in the tree: the uploaded-file
 * readers put every ZIP entry name and cell reference through it for these
 * exact reasons. It had no caller among the routes.
 *
 * Scanned rather than listed, in the shape `schemaBoundaryCensus` uses: the
 * next route that names a path segment in a refusal fails here. Exceptions are
 * enumerated with their reason, because a scan at file scope cannot see that a
 * name has been narrowed since it was destructured.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

/**
 * The names a file binds out of `req.params`.
 *
 * `const { id, field_key } = req.params as { … }` is the one spelling the
 * routes use; the renaming form (`{ id: valuationId }`) binds the right-hand
 * name, which is what an interpolation would write.
 */
export function pathParamNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/const \{([^}]*)\}\s*=\s*req\.params/g)) {
    for (const part of m[1]!.split(',')) {
      const bound = part.includes(':') ? part.slice(part.indexOf(':') + 1) : part;
      const name = bound.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** The bare identifiers a template literal interpolates. */
export function interpolated(message: string): string[] {
  return [...message.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((m) => m[1]!);
}

/**
 * Sites where the identifier is a path parameter *name* but no longer the raw
 * path segment, so quoting it would be noise.
 *
 * Each of these is a value the route has already proved is one of its own —
 * the census works at file scope and cannot see the narrowing.
 */
const EXCUSED = new Map<string, string>([
  [
    'routes/ai.ts:pipeline',
    // `runPipeline` takes `pipeline: AiPipeline` — an enum member, not the URL
    // segment. The route that *does* read the segment quotes it.
    'a typed AiPipeline parameter of the pipeline runner, not the URL segment',
  ],
  [
    'routes/overwrites.ts:field_key',
    // Both remaining sites sit after `OVERWRITE_FIELDS_BY_KEY` has resolved the
    // key, so the string being named is a registry key the server authored.
    'named only after the overwrite registry has matched it',
  ],
]);

interface Finding {
  file: string;
  name: string;
  message: string;
}

function scan(): { findings: Finding[]; calls: number; withParams: number } {
  const findings: Finding[] = [];
  let calls = 0;
  let withParams = 0;
  for (const file of sourceFiles(ROUTES)) {
    const text = readFileSync(file, 'utf8');
    const rel = `routes/${path.relative(ROUTES, file).split(path.sep).join('/')}`;
    const names = pathParamNames(text);
    if (!names.size) continue;
    withParams++;
    for (const { message } of problemCalls(text)) {
      calls++;
      for (const name of interpolated(message)) {
        if (!names.has(name)) continue;
        if (message.includes(`quoteForMessage(${name})`)) continue;
        if (EXCUSED.has(`${rel}:${name}`)) continue;
        findings.push({ file: rel, name, message: message.slice(0, 120) });
      }
    }
  }
  return { findings, calls, withParams };
}

describe('a refusal that names a path segment quotes it first', () => {
  const { findings, calls, withParams } = scan();

  it('names no raw path parameter in a problem body', () => {
    expect(
      findings,
      `put these through quoteForMessage() from domain/displayText.js:\n${findings
        .map((f) => `${f.file}  \${${f.name}}  ${f.message}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('is reading routes that actually take path parameters', () => {
    // Vacuity guard, in the shape the sibling census uses: every assertion
    // above passes against a scan that matched nothing, and both halves of
    // this one are regexes over spellings a refactor could rename.
    expect(withParams).toBeGreaterThan(40);
    expect(calls).toBeGreaterThan(150);
  });

  it('binds the renamed form, which is the name an interpolation would write', () => {
    expect([...pathParamNames('const { id: valuationId, slug } = req.params as X;')]).toEqual([
      'valuationId',
      'slug',
    ]);
  });

  it('would catch the line it was written for', () => {
    const [call] = problemCalls("throw problems.notFound(`Unknown overwrite field '${field_key}'`);");
    expect(interpolated(call!.message)).toEqual(['field_key']);
  });

  it('accepts the quoted form', () => {
    const [call] = problemCalls('throw problems.notFound(`Unknown field "${quoteForMessage(field_key)}"`);');
    // The identifier is still interpolated — what excuses it is the wrapper,
    // so the check has to be the wrapper and not the absence of the name.
    expect(interpolated(call!.message)).toEqual([]);
    expect(call!.message).toContain('quoteForMessage(field_key)');
  });

  it('finds every excused site, so a stale exception fails rather than hides', () => {
    for (const key of EXCUSED.keys()) {
      const [rel, name] = key.split(':');
      const text = readFileSync(path.join(ROUTES, path.relative('routes', rel!)), 'utf8');
      expect(pathParamNames(text).has(name!), `${key} no longer binds that path parameter`).toBe(true);
      const hits = problemCalls(text).filter((c) => interpolated(c.message).includes(name!));
      expect(hits.length, `${key} no longer names it in a problem body`).toBeGreaterThan(0);
    }
  });
});
