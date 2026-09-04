/**
 * Reading a zod schema expression out of the source, as the sweeps need it.
 *
 * Two censuses ask the same question of a `z.string()` — `emailBounds` asks
 * whether an address is length-bounded, `credentialFieldCensus` whether a
 * credential is — and the answer is "does this expression's own member chain
 * contain a `.max()`". Both used to ask it of the *line*, with `/\.max\(/`.
 *
 * A line is not an expression, and R426 found both ways that matters:
 *
 *  - `cc_emails: z.array(z.string().email()).max(10)` has a `.max(` on the
 *    line, and it bounds the *array* at ten entries. The address inside it was
 *    unbounded, which is the thing the sweep exists to refuse — and the sweep
 *    read its own subject as bounded and said nothing. The one address field on
 *    the service that was not `EmailAddress` was the one the sweep could not
 *    see.
 *  - a `//` line describing the fix (this one) is not a schema at all, and a
 *    line scan reported two of them as unbounded sites.
 *
 * So the scan works on the expression: comments and string literals are blanked
 * first — with newlines kept, so line numbers still point at the source — and
 * the members after the anchor are walked by matching parentheses rather than
 * by a regex, because an argument may itself contain parentheses
 * (`.max(MAX, \`at most ${MAX}\`)`).
 */

/**
 * `source` with every comment and string literal replaced by same-length filler
 * and every newline kept, so offsets and line numbers are unchanged.
 */
export function blankNonCode(source: string): string {
  const out: string[] = [];
  let i = 0;
  const keepNewlines = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out.push(keepNewlines(source.slice(i, stop)));
      i = stop;
    } else if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      out.push(keepNewlines(source.slice(i, stop)));
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(keepNewlines(source.slice(i, j)));
      i = j;
    } else {
      out.push(source[i]!);
      i += 1;
    }
  }
  return out.join('');
}

/**
 * The member names chained onto the expression that ends at `from` — so
 * `chainAfter(code, code.indexOf('.email()') + '.email()'.length)` over
 * `z.string().email().max(320).optional()` is `['max', 'optional']`.
 *
 * Stops at the first thing that is not `.name(`, which is where the expression
 * this schema field is ends.
 */
export function chainAfter(code: string, from: number): string[] {
  const members: string[] = [];
  let i = from;
  for (;;) {
    const member = /^\s*\.([A-Za-z_$][\w$]*)\(/.exec(code.slice(i));
    if (!member) return members;
    let j = i + member[0].length - 1;
    let depth = 0;
    for (; j < code.length; j++) {
      if (code[j] === '(') depth += 1;
      else if (code[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (j >= code.length) return members;
    members.push(member[1]!);
    i = j + 1;
  }
}
