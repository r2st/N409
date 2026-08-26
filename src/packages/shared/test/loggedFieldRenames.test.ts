import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SENSITIVE_FIELDS } from '../src/logger.js';

/**
 * The redact list protects a *key*, and a log site can rename the key.
 *
 * `SENSITIVE_FIELDS` is enumerated with unusual care — fourteen role-shaped
 * address columns, every compound OAuth credential — and `logger.test.ts`
 * scans the services so a new integration's credential field fails the suite
 * rather than reaching stdout. All of that guards the *schema's* vocabulary.
 * None of it guards the sentence somebody writes at the log call, and pino
 * matches a redact path segment by segment against the key it is given:
 *
 *     log.info({ to: email.to_email, … }, 'email delivered (smtp)')
 *
 * `to_email` is on the list. `to` is not. So the one line written every time
 * this platform delivers a message put the recipient's address in the clear,
 * through a field the redact list had specifically been extended to cover —
 * and the extension looked like it was working, because the column it names is
 * spelled correctly everywhere except at the log site.
 *
 * That is a different failure from the one `logger.test.ts` guards. There, a
 * field the list has not been told about; here, a field it has, wearing a
 * different name for one line. The first is drift in the list, the second is
 * drift in the *call*, and only the second can be found by looking at what is
 * passed rather than at what exists.
 *
 * So this reads the log calls themselves: every `log.info({ … })` in the
 * service and package trees, every `key: expression.property` inside the
 * object it logs, and a failure whenever the property is on the redact list
 * and the key it is being logged under is not.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.venv', 'test', 'tests', 'mutants'].includes(entry.name)) {
        continue;
      }
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Receivers that are a logger. Narrow rather than "anything with `.info(`",
 * because `console`-shaped method names are common — a `metrics.error(…)`
 * counter is not a log line and its arguments are not written anywhere.
 */
const LOG_CALL =
  /\b(?:log|logger|_log|req\.log|request\.log|app\.log|fastify\.log|server\.log|deps\.log|this\.log|opts\.log)\??\.(?:trace|debug|info|warn|error|fatal)\(/g;

/**
 * The first argument of a call, when it is an object literal — the mergeable
 * object pino redacts. Balanced-brace scan rather than a regex, because these
 * objects nest and the interesting ones are the nested ones.
 *
 * String and template literals are skipped while counting so a brace inside
 * `` `${x}` `` or `'}'` cannot close the object early.
 */
export function firstObjectArgument(text: string, openParen: number): string | null {
  let i = openParen + 1;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface LoggedProperty {
  /** The key the value is logged under — what pino's redact paths see. */
  key: string;
  /** The trailing property of the expression being logged. */
  source: string;
}

/**
 * `key: some.expression.property` pairs inside one logged object, at any depth.
 *
 * Only property accesses are read. A bare identifier (`{ recipient: email }`)
 * is deliberately not flagged: on this platform `email` names the *outbox row*
 * at least as often as it names an address, and a check that cannot tell those
 * apart would report `{ emailId: email.id }` forever.
 */
export function loggedProperties(objectText: string): LoggedProperty[] {
  const flat = objectText.replace(/\s+/g, ' ');
  const out: LoggedProperty[] = [];
  for (const m of flat.matchAll(
    /([A-Za-z_$][\w$]*)\s*:\s*(?:await\s+)?[A-Za-z_$][\w$]*(?:[.?!]*\.[A-Za-z_$][\w$]*)*[.?!]*\.([a-z][a-z0-9_]*)\b/g,
  )) {
    out.push({ key: m[1]!, source: m[2]! });
  }
  return out;
}

interface Finding extends LoggedProperty {
  file: string;
}

function scan(): { findings: Finding[]; calls: number } {
  const sensitive = new Set(SENSITIVE_FIELDS);
  const findings: Finding[] = [];
  let calls = 0;
  for (const file of [
    ...sourceFiles(path.join(repoRoot, 'src/services')),
    ...sourceFiles(path.join(repoRoot, 'src/packages')),
  ]) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    for (const m of text.matchAll(LOG_CALL)) {
      calls++;
      const obj = firstObjectArgument(text, m.index! + m[0].length - 1);
      if (!obj) continue;
      for (const prop of loggedProperties(obj)) {
        if (sensitive.has(prop.source) && !sensitive.has(prop.key)) {
          findings.push({ file: rel, ...prop });
        }
      }
    }
  }
  return { findings, calls };
}

describe('a log site cannot rename a redacted field out of its redaction', () => {
  const { findings, calls } = scan();

  it('is reading the log calls the services actually make', () => {
    // Vacuity guard, and the only thing standing between this file and the
    // shape it exists to catch: every assertion below passes against a scan
    // that matched nothing, and the scan is a regex over a receiver name.
    // A refactor that logs through a differently-named handle would make this
    // census go quiet while still reporting success — the failure mode
    // [[n409-vacuous-checks]] is a register of.
    expect(calls).toBeGreaterThan(100);
  });

  it('parses a nested object argument without stopping at a brace in a string', () => {
    const text = "log.info({ a: { b: '}' }, c: `${x}` }, 'done')";
    expect(firstObjectArgument(text, text.indexOf('('))).toBe("{ a: { b: '}' }, c: `${x}` }");
  });

  it('reads the key a value is logged under, not the value it came from', () => {
    expect(loggedProperties('{ to: email.to_email, subject: email.subject }')).toEqual([
      { key: 'to', source: 'to_email' },
      { key: 'subject', source: 'subject' },
    ]);
    // Optional chaining and a longer path still resolve to the trailing
    // property, which is the one whose name says what the value is.
    expect(loggedProperties('{ addr: row?.user.actor_email }')).toEqual([
      { key: 'addr', source: 'actor_email' },
    ]);
  });

  it('would catch the smtp line this census was written for', () => {
    const sensitive = new Set(SENSITIVE_FIELDS);
    const caught = loggedProperties('{ to: email.to_email, subject: email.subject }').filter(
      (p) => sensitive.has(p.source) && !sensitive.has(p.key),
    );
    expect(caught).toEqual([{ key: 'to', source: 'to_email' }]);
  });

  it('does not flag a key that is itself on the redact list', () => {
    const sensitive = new Set(SENSITIVE_FIELDS);
    // Logging `to_email: row.to_email` is fine — pino censors it. The check is
    // about the key, not about the value's provenance.
    expect(
      loggedProperties('{ to_email: row.to_email }').filter(
        (p) => sensitive.has(p.source) && !sensitive.has(p.key),
      ),
    ).toEqual([]);
  });

  it('logs no redacted field under an unredacted key', () => {
    expect(
      findings.map((f) => `${f.file}: { ${f.key}: …${f.source} }`).sort(),
      'a field on SENSITIVE_FIELDS logged under a key pino will not censor',
    ).toEqual([]);
  });
});
