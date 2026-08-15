import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every `.ts` file under `dir`, recursively.
 *
 * Shared by the schema sweeps — the tests that hold a whole class of gap closed
 * by grepping the source rather than by exercising one route. `finiteNumberSweep`
 * (no `z.number()` that admits Infinity) and `emailBounds` (no `.email()` without
 * a `.max()`) both need it, and a sweep that walks a different file set from the
 * one it claims to walk is a sweep that passes vacuously.
 */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
