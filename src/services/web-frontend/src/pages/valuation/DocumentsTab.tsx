import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { DocumentsPanel } from '../../components/valuation/DocumentsPanel';
import { AccountingConnect } from '../../components/valuation/AccountingConnect';
import { WriteGate } from '../../components/ui';

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
export function DocumentsTab() {
  const { valuation, reload, retired } = useWorkspace();
  const { user } = useAuth();
  return (
    <div>
      {/* Clearing a file changes the header's pending-files chip, so the
          workspace aggregate is reloaded with it — a chip that disagrees with
          the list under it is worse than no chip. */}
      <DocumentsPanel
        valuationId={valuation.id}
        canReview={isOps(user)}
        onReviewed={reload}
        // The upload route answers 409 for a retired engagement, and it does so
        // *after* the file has gone up the wire. Of everything closed on a
        // withdrawn file this is the one worth closing in the browser rather
        // than at the server: the wasted work is a client's transfer, not a
        // click.
        canUpload={!retired}
      />
      {/* §23 — accounting software connect + import. Connecting a ledger,
          importing from it and disconnecting are all writes; there is nothing
          on this panel a reader consults. */}
      <WriteGate closed={retired}>
        <AccountingConnect valuationId={valuation.id} />
      </WriteGate>
    </div>
  );
}
