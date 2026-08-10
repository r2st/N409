import { describe, expect, it } from 'vitest';
import * as barrel from '../src/index.js';

/**
 * `src/index.ts` is the only entry point in this package's `exports` map, so a
 * module that exists but is not re-exported here is unreachable from every
 * service — it compiles, its own tests pass, and the import fails at the call
 * site. Checking it by hand does not survive the tenth module; this enumerates
 * the directory instead, so a new file is covered the moment it is added rather
 * than the moment somebody remembers.
 *
 * `import.meta.glob` rather than readdir + dynamic import: the specifier has to
 * be statically analysable for the bundler to resolve it, and a template string
 * is not.
 *
 * Value exports only. Type-only exports are erased before this runs, so the
 * barrel's `type` re-exports are the compiler's problem and not assertable here.
 */

const modules = import.meta.glob<Record<string, unknown>>('../src/*.ts');

const moduleNames = Object.keys(modules)
  .map((path) => path.replace('../src/', '').replace(/\.ts$/, ''))
  .filter((name) => name !== 'index')
  .sort();

const load = (name: string) => modules[`../src/${name}.ts`]!();

describe('public surface (src/index.ts)', () => {
  it('finds the modules to check, so an empty glob cannot pass this file', () => {
    expect(moduleNames.length).toBeGreaterThan(15);
  });

  for (const name of moduleNames) {
    it(`re-exports every value from ${name}.ts`, async () => {
      const mod = await load(name);
      const values = Object.keys(mod).filter((k) => k !== 'default');
      expect(values.length, `${name}.ts exports nothing`).toBeGreaterThan(0);

      const missing = values.filter((k) => !(k in barrel));
      expect(missing, `${name}.ts exports not reachable from the barrel`).toEqual([]);
    });
  }

  it('re-exports the identity, not a copy', async () => {
    // `export { x } from` and `export const x = mod.x` are indistinguishable by
    // name and very distinguishable by behaviour — module state (build.ts's
    // cache, requestContext.ts's ALS) only works if callers get the same object.
    expect(barrel.resetBuildInfoCache).toBe((await load('build')).resetBuildInfoCache);
    expect(barrel.runWithRequestId).toBe((await load('requestContext')).runWithRequestId);
  });

  it('exports nothing the modules do not define', async () => {
    const owned = new Set<string>();
    for (const name of moduleNames) {
      for (const key of Object.keys(await load(name))) owned.add(key);
    }
    // A name here that no module defines means the barrel grew a definition of
    // its own, which is a place for logic to hide from every other test.
    expect(Object.keys(barrel).filter((k) => !owned.has(k))).toEqual([]);
  });
});
