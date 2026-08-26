import { useWorkspace } from './ValuationWorkspace';
import { CalculationPanel } from '../../components/valuation/CalculationPanel';

/**
 * Thin adapter mounting an M1 pipeline panel as a workspace tab.
 *
 * `retired || !isOps(user)` is the read-only condition rather than the role
 * alone. A withdrawn engagement refuses every write these panels make, and
 * until R90 they went on offering the forms — the banner was on the Overview
 * tab and nowhere else, so an analyst could retype a whole set of parameters
 * here with nothing on screen to say the work had been withdrawn. The panels
 * already knew how to be read-only for a client, which is why this costs one
 * term each: what was missing was the second reason to be.
 *
 * One file per tab, not one file for six (R161). These six adapters used to
 * share a module, and `lazy(() => import(…))` splits on modules: six route
 * entries resolving to one file is one chunk, so opening Params downloaded the
 * AI panel, the task list, the document library, the accounting connector, the
 * financial model and the calculation runner with it — 114 kB for a form that
 * needs a third of it. The panels are what carry the weight, and a panel is
 * only in a chunk because a tab in that chunk imports it.
 */
export function CalculationsTab() {
  const { valuation, retired } = useWorkspace();
  // The panel takes the condition rather than being wrapped: the run history
  // under the buttons has its own control — "Inspect steps" — and that is the
  // one thing on a withdrawn engagement somebody is most likely to be here for.
  return (
    <CalculationPanel valuationId={valuation.id} currency={valuation.currency ?? 'USD'} readOnly={retired} />
  );
}
