import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { GoogleCompletePage } from './pages/GoogleCompletePage';
import { DashboardPage } from './pages/DashboardPage';
import { ValuationsPage } from './pages/ValuationsPage';
import { NewValuationPage } from './pages/NewValuationPage';
import { ValuationDetailPage } from './pages/ValuationDetailPage';
import { ValuationWorkspace } from './pages/valuation/ValuationWorkspace';
import {
  AiTab,
  CalculationsTab,
  DocumentsTab,
  ParamsTab,
  TasksTab,
} from './pages/valuation/PipelineTabs';
import { WorkbookTab } from './pages/valuation/WorkbookTab';
import { OverwritesTab } from './pages/valuation/OverwritesTab';
import { ReportTab } from './pages/valuation/ReportTab';
import { OverwritesSchemaPage } from './pages/OverwritesSchemaPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { PartnerPortalPage } from './pages/PartnerPortalPage';
import { SearchPage } from './pages/SearchPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { SensitivityPage } from './pages/SensitivityPage';
import { TasksPage } from './pages/TasksPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/google/complete" element={<GoogleCompletePage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/valuations" element={<ValuationsPage />} />
        <Route path="/valuations/new" element={<NewValuationPage />} />
        <Route path="/valuations/:id" element={<ValuationWorkspace />}>
          <Route index element={<ValuationDetailPage />} />
          <Route path="documents" element={<DocumentsTab />} />
          <Route path="params" element={<ParamsTab />} />
          <Route path="ai" element={<AiTab />} />
          <Route path="tasks" element={<TasksTab />} />
          <Route path="calculations" element={<CalculationsTab />} />
          <Route path="workbook" element={<WorkbookTab />} />
          <Route path="overwrites" element={<OverwritesTab />} />
          <Route path="report" element={<ReportTab />} />
        </Route>
        <Route path="/valuations/:id/sensitivity" element={<SensitivityPage />} />
        <Route path="/partner" element={<PartnerPortalPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/schema/overwrites" element={<OverwritesSchemaPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
