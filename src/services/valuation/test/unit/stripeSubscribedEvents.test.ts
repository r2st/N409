import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every Stripe event a handler branches on is an event somebody has to
 * subscribe in the Stripe dashboard.
 *
 * A branch for an event that no endpoint is registered for is not a feature
 * that degrades — it is dead code that reads, from here, exactly like a working
 * one. Nothing in this repository can register the subscription; the only thing
 * that can is an operator following `docs/billing-setup.md`, and the only thing
 * that can tell them a new event exists is that document. So the document is
 * the contract, and this holds the two halves together in the one direction
 * that matters: a handler added without the event being listed is a silent
 * no-op in production.
 *
 * The reverse direction is deliberately not asserted. Listing an event we do
 * not yet branch on costs a 200 and nothing else, and the payments endpoint's
 * list is written for the operator's benefit rather than derived from the code.
 *
 * This is the config-drift class the deployment notes keep hitting: behaviour
 * that lives half in the repository and half on somebody's dashboard.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const DOC = fs.readFileSync(here('../../../../../docs/billing-setup.md'), 'utf8');

/** Every `type === 'x.y'` a route file decides on. */
function branchedEvents(file: string): string[] {
  const source = fs.readFileSync(here(file), 'utf8');
  const found = new Set<string>();
  for (const [, name] of source.matchAll(/type === '([a-z_]+(?:\.[a-z_]+)+)'/g)) found.add(name!);
  return [...found].sort();
}

describe('docs/billing-setup.md lists every Stripe event a handler acts on', () => {
  const billing = branchedEvents('../../src/routes/billing.ts');
  const payments = branchedEvents('../../src/routes/payments.ts');

  it('reads a real branch list off both webhook handlers', () => {
    // Neither scan may go vacuous: a rename of the comparison idiom that
    // matched nothing would otherwise turn this whole file green.
    expect(billing).toContain('customer.subscription.deleted');
    expect(payments).toContain('checkout.session.completed');
  });

  it('names every event the billing webhook branches on', () => {
    expect(billing.filter((type) => !DOC.includes(`\`${type}\``))).toEqual([]);
  });

  it('names every event the payments webhook branches on', () => {
    expect(payments.filter((type) => !DOC.includes(`\`${type}\``))).toEqual([]);
  });
});
