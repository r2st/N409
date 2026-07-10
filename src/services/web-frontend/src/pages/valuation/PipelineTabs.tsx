import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { DocumentsPanel } from '../../components/valuation/DocumentsPanel';
import { AccountingConnect } from '../../components/valuation/AccountingConnect';
import { ParamsPanel } from '../../components/valuation/ParamsPanel';
import { AiPanel } from '../../components/valuation/AiPanel';
import { TasksPanel } from '../../components/valuation/TasksPanel';
import { CalculationPanel } from '../../components/valuation/CalculationPanel';

/** Thin adapters mounting the M1 pipeline panels as workspace tabs. */

export function DocumentsTab() {
  const { valuation } = useWorkspace();
  return (
    <div>
      <DocumentsPanel valuationId={valuation.id} />
      {/* §23 — accounting software connect + import */}
      <AccountingConnect valuationId={valuation.id} />
    </div>
  );
}

export function ParamsTab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  return <ParamsPanel valuationId={valuation.id} readOnly={!isOps(user)} />;
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
