import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { DocumentsPanel } from '../../components/valuation/DocumentsPanel';
import { AccountingConnect } from '../../components/valuation/AccountingConnect';
import { ParamsPanel } from '../../components/valuation/ParamsPanel';
import { WaccPanel } from '../../components/valuation/WaccPanel';
import { FinancialModelPanel } from '../../components/valuation/FinancialModelPanel';
import { ProjectionPanel } from '../../components/valuation/ProjectionPanel';
import { AiPanel } from '../../components/valuation/AiPanel';
import { TasksPanel } from '../../components/valuation/TasksPanel';
import { CalculationPanel } from '../../components/valuation/CalculationPanel';
import { WriteGate } from '../../components/ui';

/**
 * Thin adapters mounting the M1 pipeline panels as workspace tabs.
 *
 * `retired || !isOps(user)` is the read-only condition rather than the role
 * alone. A withdrawn engagement refuses every write these panels make, and
 * until R90 they went on offering the forms — the banner was on the Overview
 * tab and nowhere else, so an analyst could retype a whole set of parameters
 * here with nothing on screen to say the work had been withdrawn. The panels
 * already knew how to be read-only for a client, which is why this costs one
 * term each: what was missing was the second reason to be.
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

export function FinancialModelTab() {
  const { valuation, retired } = useWorkspace();
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <FinancialModelPanel valuationId={valuation.id} readOnly={!isOps(user) || retired} />
      {/* Below the model rather than beside it: the panel builds the free-cash-
          flow column the form above types by hand, and adopting a forecast
          rewrites that column — so it reads in the order the two are used. */}
      <ProjectionPanel
        valuationId={valuation.id}
        currency={valuation.currency ?? 'USD'}
        readOnly={!isOps(user) || retired}
      />
    </div>
  );
}

export function AiTab() {
  const { valuation, retired } = useWorkspace();
  return (
    <WriteGate closed={retired}>
      <AiPanel valuationId={valuation.id} />
    </WriteGate>
  );
}

export function TasksTab() {
  const { valuation, retired } = useWorkspace();
  return (
    <WriteGate closed={retired}>
      <TasksPanel valuationId={valuation.id} />
    </WriteGate>
  );
}

export function CalculationsTab() {
  const { valuation, retired } = useWorkspace();
  // The panel takes the condition rather than being wrapped: the run history
  // under the buttons has its own control — "Inspect steps" — and that is the
  // one thing on a withdrawn engagement somebody is most likely to be here for.
  return (
    <CalculationPanel valuationId={valuation.id} currency={valuation.currency ?? 'USD'} readOnly={retired} />
  );
}
