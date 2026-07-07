import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
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
import { AdminPartnersPage } from './pages/AdminPartnersPage';
import { EmailOutboxPage } from './pages/EmailOutboxPage';
import { PartnerPortalPage } from './pages/PartnerPortalPage';
import { SearchPage } from './pages/SearchPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { SensitivityPage } from './pages/SensitivityPage';
import { TasksPage } from './pages/TasksPage';
import { BotPromptsPage } from './pages/BotPromptsPage';
import { SupportInboxPage } from './pages/SupportInboxPage';
import { CompanyTab } from './pages/valuation/CompanyTab';
import { PackageTab } from './pages/valuation/PackageTab';
import { OnboardingPage } from './pages/OnboardingPage';
import { PaymentCancelPage, PaymentSuccessPage } from './pages/PaymentRedirectPages';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
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
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/payment/cancel" element={<PaymentCancelPage />} />
        <Route path="/valuations/:id" element={<ValuationWorkspace />}>
          <Route index element={<ValuationDetailPage />} />
          <Route path="company" element={<CompanyTab />} />
          <Route path="documents" element={<DocumentsTab />} />
          <Route path="params" element={<ParamsTab />} />
          <Route path="ai" element={<AiTab />} />
          <Route path="tasks" element={<TasksTab />} />
          <Route path="calculations" element={<CalculationsTab />} />
          <Route path="workbook" element={<WorkbookTab />} />
          <Route path="overwrites" element={<OverwritesTab />} />
          <Route path="report" element={<ReportTab />} />
          <Route path="package" element={<PackageTab />} />
        </Route>
        <Route path="/valuations/:id/sensitivity" element={<SensitivityPage />} />
        <Route path="/partner" element={<PartnerPortalPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/partners" element={<AdminPartnersPage />} />
        <Route path="/admin/prompts" element={<BotPromptsPage />} />
        <Route path="/admin/support" element={<SupportInboxPage />} />
        <Route path="/admin/outbox" element={<EmailOutboxPage />} />
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
