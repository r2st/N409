import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'src/services/valuation/src/routes';
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

// Split a file into handler bodies by locating `app.<verb>(` and matching braces.
const VERB = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;

const findings = [];
for (const f of files) {
  const src = readFileSync(path.join(dir, f), 'utf8');
  let m;
  while ((m = VERB.exec(src))) {
    const [, verb, , route] = m;
    // Take from the registration to the next registration (or EOF) as the body.
    VERB.lastIndex = m.index + m[0].length;
    const next = src.slice(VERB.lastIndex).search(/\bapp\.(get|post|put|patch|delete)\(/);
    const body = src.slice(m.index, next === -1 ? src.length : VERB.lastIndex + next);
    const usesBody = /req\.body|request\.body/.test(body);
    const usesQuery = /req\.query|request\.query/.test(body);
    const validated = /safeParse|\.parse\(/.test(body);
    if ((usesBody || usesQuery) && !validated) {
      findings.push({ file: f, verb: verb.toUpperCase(), route, usesBody, usesQuery });
    }
  }
}
console.log(JSON.stringify(findings, null, 1));
console.log('TOTAL UNVALIDATED:', findings.length);
