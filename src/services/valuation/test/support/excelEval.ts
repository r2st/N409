/**
 * A calculator for the formula subset the XLSX export writes.
 *
 * The export ships every derived cell twice: as an Excel formula, for the
 * auditor who changes an input, and as a cached value, for every reader that
 * shows what was computed rather than recalculating. Nothing checked that the
 * two agree. The failure mode is silent and specific — a row inserted into a
 * sheet definition shifts the A1 references by one, and the workbook still
 * opens, still sums, and quietly divides revenue by the wrong line — so it is
 * not enough to pin a handful of references by hand, which is all a person
 * writing assertions will ever do.
 *
 * This evaluates them instead. It is not an Excel implementation and is not
 * trying to be: it covers the operators and the eight functions this codebase
 * emits, and throws on anything else, so a formula shape that outgrows it
 * fails loudly rather than being scored as agreeing.
 */

/** Excel's value domain, as far as this subset needs it. */
export type Cell = number | string | boolean | null;

export class ExcelError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Blank and text are both "not a number" to COUNT, SUM and ISNUMBER. */
const isNum = (v: Cell): v is number => typeof v === 'number' && Number.isFinite(v);

/** A grid of resolved values, addressed A1-style. `resolve` may recurse. */
export interface Grid {
  /** Value at a 1-based (column, row); blank cells are null. */
  at(column: number, row: number): Cell;
}

export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

interface Token {
  kind: 'number' | 'string' | 'ref' | 'name' | 'op';
  text: string;
}

const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '(', ')', ',', ':'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ') {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          text += '"';
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        text += src[j];
        j += 1;
      }
      if (src[j] !== '"') throw new Error(`unterminated string in ${src}`);
      out.push({ kind: 'string', text });
      i = j + 1;
      continue;
    }
    const ref = /^\$?[A-Z]{1,3}\$?\d+/.exec(src.slice(i));
    if (ref) {
      out.push({ kind: 'ref', text: ref[0] });
      i += ref[0].length;
      continue;
    }
    const name = /^[A-Z][A-Z0-9.]*/.exec(src.slice(i));
    if (name) {
      out.push({ kind: 'name', text: name[0] });
      i += name[0].length;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ kind: 'number', text: num[0] });
      i += num[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`unexpected character '${ch}' in ${src}`);
    out.push({ kind: 'op', text: op });
    i += op.length;
  }
  return out;
}

/**
 * A reference, kept unresolved until the caller decides what it wants.
 *
 * COUNT over a range needs every cell; `A1/B1` needs one value. Resolving at
 * parse time would lose the difference, and resolving a range to its first
 * cell — the shortcut that looks harmless — would score `SUM(K3:K9)` as
 * agreeing with a total of one row.
 */
interface RefValue {
  cells: Cell[];
}

const isRef = (v: unknown): v is RefValue =>
  typeof v === 'object' && v !== null && Array.isArray((v as RefValue).cells);

type Value = Cell | RefValue;

/** One value from a reference; a multi-cell range is not a scalar. */
function scalar(v: Value): Cell {
  if (!isRef(v)) return v;
  if (v.cells.length !== 1) throw new Error(`range used where a single value is needed`);
  return v.cells[0]!;
}

/** Every cell a value covers, for the functions that take ranges. */
function spread(v: Value): Cell[] {
  return isRef(v) ? v.cells : [v];
}

/** Excel coerces blank to 0 in arithmetic; text in arithmetic is #VALUE!. */
function arith(v: Value): number {
  const c = scalar(v);
  if (c === null) return 0;
  if (typeof c === 'boolean') return c ? 1 : 0;
  if (typeof c === 'number') return c;
  throw new ExcelError('#VALUE!');
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly grid: Grid,
    private readonly src: string,
  ) {}

  parse(): Value {
    const v = this.comparison();
    if (this.pos !== this.tokens.length) throw new Error(`trailing tokens in ${this.src}`);
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat(text: string): void {
    const t = this.peek();
    if (!t || t.text !== text) throw new Error(`expected '${text}' in ${this.src}`);
    this.pos += 1;
  }

  private comparison(): Value {
    let left = this.additive();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || !['=', '<', '>', '<=', '>=', '<>'].includes(t.text)) return left;
      this.pos += 1;
      const right = this.additive();
      const a = scalar(left);
      const b = scalar(right);
      // Only the comparisons this subset emits: a number against a number, or
      // against a blank cell (which compares as 0, Excel's own rule).
      const an = a === null ? 0 : a;
      const bn = b === null ? 0 : b;
      const cmp =
        t.text === '='
          ? an === bn
          : t.text === '<>'
            ? an !== bn
            : t.text === '<'
              ? an < bn
              : t.text === '>'
                ? an > bn
                : t.text === '<='
                  ? an <= bn
                  : an >= bn;
      left = cmp;
    }
  }

  private additive(): Value {
    let left: Value = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || (t.text !== '+' && t.text !== '-')) return left;
      this.pos += 1;
      const right = this.multiplicative();
      left = t.text === '+' ? arith(left) + arith(right) : arith(left) - arith(right);
    }
  }

  private multiplicative(): Value {
    let left: Value = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || (t.text !== '*' && t.text !== '/')) return left;
      this.pos += 1;
      const right = this.unary();
      if (t.text === '*') {
        left = arith(left) * arith(right);
      } else {
        const d = arith(right);
        if (d === 0) throw new ExcelError('#DIV/0!');
        left = arith(left) / d;
      }
    }
  }

  private unary(): Value {
    const t = this.peek();
    if (t && t.kind === 'op' && t.text === '-') {
      this.pos += 1;
      return -arith(this.unary());
    }
    return this.primary();
  }

  private primary(): Value {
    const t = this.peek();
    if (!t) throw new Error(`unexpected end of ${this.src}`);
    if (t.kind === 'number') {
      this.pos += 1;
      return Number(t.text);
    }
    if (t.kind === 'string') {
      this.pos += 1;
      return t.text;
    }
    if (t.kind === 'op' && t.text === '(') {
      this.pos += 1;
      const v = this.comparison();
      this.eat(')');
      return v;
    }
    if (t.kind === 'ref') return this.reference();
    if (t.kind === 'name') return this.call();
    throw new Error(`unexpected '${t.text}' in ${this.src}`);
  }

  private reference(): RefValue {
    const first = this.tokens[this.pos]!.text;
    this.pos += 1;
    const next = this.peek();
    if (next && next.kind === 'op' && next.text === ':') {
      this.pos += 1;
      const end = this.peek();
      if (!end || end.kind !== 'ref') throw new Error(`malformed range in ${this.src}`);
      this.pos += 1;
      return { cells: this.range(first, end.text) };
    }
    const [col, row] = parseRef(first);
    return { cells: [this.grid.at(col, row)] };
  }

  private range(from: string, to: string): Cell[] {
    const [c1, r1] = parseRef(from);
    const [c2, r2] = parseRef(to);
    const cells: Cell[] = [];
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c += 1) {
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r += 1) cells.push(this.grid.at(c, r));
    }
    return cells;
  }

  private call(): Value {
    const name = this.tokens[this.pos]!.text;
    this.pos += 1;
    this.eat('(');
    // Arguments are thunks so IF and IFERROR can decline to evaluate a branch —
    // the whole point of `IFERROR(K3/D3,"")` is that the division is allowed to
    // fail, and an eager evaluator would propagate the error it exists to hide.
    const args: Array<() => Value> = [];
    if (this.peek()?.text !== ')') {
      for (;;) {
        const start = this.pos;
        this.skipArgument();
        const end = this.pos;
        const slice = this.tokens.slice(start, end);
        args.push(() => new Parser(slice, this.grid, this.src).parse());
        if (this.peek()?.text === ',') {
          this.pos += 1;
          continue;
        }
        break;
      }
    }
    this.eat(')');
    return apply(name, args, this.src);
  }

  /** Advances past one argument, tracking nesting so a nested comma is not a separator. */
  private skipArgument(): void {
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (!t) return;
      if (t.text === '(') depth += 1;
      if (t.text === ')') {
        if (depth === 0) return;
        depth -= 1;
      }
      if (t.text === ',' && depth === 0) return;
      this.pos += 1;
    }
  }
}

function parseRef(text: string): [column: number, row: number] {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(text);
  if (!m) throw new Error(`unparsable reference '${text}'`);
  return [columnNumber(m[1]!), Number(m[2]!)];
}

function apply(name: string, args: Array<() => Value>, src: string): Value {
  switch (name) {
    case 'IF': {
      const cond = scalar(args[0]!());
      const truthy = cond === true || (typeof cond === 'number' && cond !== 0);
      const branch = truthy ? args[1] : args[2];
      return branch ? branch() : truthy;
    }
    case 'IFERROR':
      try {
        return args[0]!();
      } catch (err) {
        if (err instanceof ExcelError) return args[1]!();
        throw err;
      }
    case 'OR':
      return args.some((a) => scalar(a()) === true);
    case 'AND':
      return args.every((a) => scalar(a()) === true);
    case 'NOT':
      return scalar(args[0]!()) !== true;
    case 'COUNT':
      return args.flatMap((a) => spread(a())).filter(isNum).length;
    case 'SUM':
      return args
        .flatMap((a) => spread(a()))
        .filter(isNum)
        .reduce((s, n) => s + n, 0);
    /*
     * `SUMIF(range, criterion, [sum_range])`, with the criterion restricted to
     * the one form this estate writes: a literal the cell must equal.
     *
     * Excel's own criterion grammar is a small language — `">5"`, `"a*"`,
     * `"<>"` — and implementing it here would be implementing a spec this
     * harness has no test for. A criterion it cannot honour is refused rather
     * than approximated, because the whole value of this evaluator is that a
     * cached figure and its formula are checked against each other: an
     * approximate SUMIF would score them as agreeing on a number neither Excel
     * nor the writer meant.
     */
    case 'SUMIF': {
      const range = spread(args[0]!());
      const criterion = scalar(args[1]!());
      if (typeof criterion === 'string' && /^\s*[<>=*?~]/.test(criterion)) {
        throw new Error(`unsupported SUMIF criterion '${criterion}' in ${src}`);
      }
      const target = args[2] ? spread(args[2]()) : range;
      if (args[2] && target.length !== range.length) {
        throw new Error(`SUMIF ranges differ in size in ${src}`);
      }
      return range.reduce((total, cell, i) => {
        if (cell !== criterion) return total;
        const summed = target[i];
        return isNum(summed) ? total + summed : total;
      }, 0);
    }
    case 'ISNUMBER':
      try {
        return isNum(scalar(args[0]!()));
      } catch (err) {
        if (err instanceof ExcelError) return false;
        throw err;
      }
    default:
      throw new Error(`unsupported function ${name}() in ${src}`);
  }
}

/**
 * Evaluates one formula against a grid.
 *
 * Returns the value Excel would show: a number, a string (`""` for the blank
 * these formulas produce deliberately), or a boolean. Errors that no IFERROR
 * caught propagate as `ExcelError`, because a workbook that reaches an auditor
 * showing #DIV/0! is a finding and not something a test should absorb.
 */
export function evaluateFormula(formula: string, grid: Grid): Cell {
  const parser = new Parser(tokenize(formula), grid, formula);
  return scalar(parser.parse());
}
