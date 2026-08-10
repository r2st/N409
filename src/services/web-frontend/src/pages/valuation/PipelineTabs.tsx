import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { DocumentsPanel } from '../../components/valuation/DocumentsPanel';
import { AccountingConnect } from '../../components/valuation/AccountingConnect';
import { ParamsPanel } from '../../components/valuation/ParamsPanel';
import { WaccPanel } from '../../components/valuation/WaccPanel';
import { FinancialModelPanel } from '../../components/valuation/FinancialModelPanel';
import { AiPanel } from '../../components/valuation/AiPanel';
import { TasksPanel } from '../../components/valuation/TasksPanel';
import { CalculationPanel } from '../../components/valuation/CalculationPanel';

/** Thin adapters mounting the M1 pipeline panels as workspace tabs. */

export function DocumentsTab() {
  const { valuation, reload } = useWorkspace();
  const { user } = useAuth();
  return (
    <div>
      {/* Clearing a file changes the header's pending-files chip, so the
          workspace aggregate is reloaded with it — a chip that disagrees with
          the list under it is worse than no chip. */}
      <DocumentsPanel valuationId={valuation.id} canReview={isOps(user)} onReviewed={reload} />
      {/* §23 — accounting software connect + import */}
      <AccountingConnect valuationId={valuation.id} />
    </div>
  );
}

export function ParamsTab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <ParamsPanel valuationId={valuation.id} readOnly={!isOps(user)} />
      {/* Its own panel rather than another section of the methodology form: the
          beta set is a table, and it saves and previews on its own without
          carrying the whole form's validation with it. */}
      <WaccPanel valuationId={valuation.id} readOnly={!isOps(user)} />
    </div>
  );
}

export function FinancialModelTab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  return <FinancialModelPanel valuationId={valuation.id} readOnly={!isOps(user)} />;
}

export function AiTab() {
  const { valuation } = useWorkspace();
  return <AiPanel valuationId={valuation.id} />;
}

export function TasksTab() {
  const { valuation } = useWorkspace();
  return <TasksPanel valuationId={valuation.id} />;
}

export function CalculationsTab() {
  const { valuation } = useWorkspace();
  return <CalculationPanel valuationId={valuation.id} currency={valuation.currency ?? 'USD'} />;
}
