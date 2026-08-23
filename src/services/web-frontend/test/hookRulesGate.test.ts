import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * The rules of hooks are a CI gate, and this is the gate on the gate.
 *
 * `npm run lint` is what enforces them, so nothing here re-implements it. What
 * this asserts is that the two rules are actually *in force for this package* —
 * a plugin block whose `files` glob stops matching, or a rule quietly dropped
 * to `warn`, leaves lint green while enforcing nothing, and the class of bug
 * they cover (a hook whose count or dependencies vary between renders) is one
 * the type checker and the test suite both miss.
 *
 * It resolves the config the way ESLint itself does rather than reading
 * `eslint.config.js` as text, so it follows the globs instead of trusting them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** Severity ESLint resolved for `rule` against a real file in this package. */
async function severityFor(rule: string, file: string): Promise<unknown> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, unknown[]>;
  };
  return config.rules?.[rule]?.[0];
}

describe('the rules of hooks are in force for the frontend', () => {
  // A component and a plain module: the globs must cover both .tsx and .ts,
  // since custom hooks live in lib/*.ts and break the same way.
  const targets = [
    path.resolve(HERE, '../src/pages/SettingsPage.tsx'),
    path.resolve(HERE, '../src/lib/auth.tsx'),
    path.resolve(HERE, '../src/lib/rowVersion.ts'),
  ];

  for (const file of targets) {
    const shown = path.relative(REPO_ROOT, file);

    it(`enforces rules-of-hooks on ${shown}`, async () => {
      expect(await severityFor('react-hooks/rules-of-hooks', file)).toBe(2);
    });

    it(`enforces exhaustive-deps on ${shown}`, async () => {
      // `error`, not `warn`: the package was clean when this was turned on, so
      // there is no backlog for a warning to hide behind.
      expect(await severityFor('react-hooks/exhaustive-deps', file)).toBe(2);
    });
  }
});
