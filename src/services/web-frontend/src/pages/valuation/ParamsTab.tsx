import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { ParamsPanel } from '../../components/valuation/ParamsPanel';
import { WaccPanel } from '../../components/valuation/WaccPanel';

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
export function ParamsTab() {
  const { valuation, retired } = useWorkspace();
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <ParamsPanel valuationId={valuation.id} readOnly={!isOps(user) || retired} />
      {/* Its own panel rather than another section of the methodology form: the
          beta set is a table, and it saves and previews on its own without
          carrying the whole form's validation with it. */}
      <WaccPanel valuationId={valuation.id} readOnly={!isOps(user) || retired} />
    </div>
  );
}
