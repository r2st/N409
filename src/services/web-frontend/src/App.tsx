import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { RequireRole } from './components/RequireRole';
import { AppLayout } from './components/AppLayout';
import { useAuth } from './lib/auth';
import { canManageUsers, isOps, isPartner } from './lib/rbac';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { AuditorPortalPage } from './pages/AuditorPortalPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { GoogleCompletePage } from './pages/GoogleCompletePage';
import { BoardSignPage } from './pages/BoardSignPage';
import { DashboardPage } from './pages/DashboardPage';
import { PortfolioPage } from './pages/PortfolioPage';
import { FundPortfolioPage } from './pages/FundPortfolioPage';
import { DebtInstrumentsPage } from './pages/DebtInstrumentsPage';
import { ValuationsPage } from './pages/ValuationsPage';
import { NewValuationPage } from './pages/NewValuationPage';
import { ValuationDetailPage } from './pages/ValuationDetailPage';
import { ValuationWorkspace } from './pages/valuation/ValuationWorkspace';
import {
  AiTab,
  CalculationsTab,
  DocumentsTab,
  FinancialModelTab,
  ParamsTab,
  TasksTab,
} from './pages/valuation/PipelineTabs';
import { WorkbookTab } from './pages/valuation/WorkbookTab';
import { ScenariosTab } from './pages/valuation/ScenariosTab';
import { BridgeTab } from './pages/valuation/BridgeTab';
import { AnalyticsTab } from './pages/valuation/AnalyticsTab';
import { GrantsTab } from './pages/valuation/GrantsTab';
import { Asc718Tab } from './pages/valuation/Asc718Tab';
import { IntakeTab } from './pages/valuation/IntakeTab';
import { EngagementTab } from './pages/valuation/EngagementTab';
import { EngagementsPage } from './pages/EngagementsPage';
import { CapTableTab } from './pages/valuation/CapTableTab';
import { MonitoringTab } from './pages/valuation/MonitoringTab';
import { MonitorsPage } from './pages/MonitorsPage';
import { OverwritesTab } from './pages/valuation/OverwritesTab';
import { ReportTab } from './pages/valuation/ReportTab';
import { ProgressTab } from './pages/valuation/ProgressTab';
import { QaTab } from './pages/valuation/QaTab';
import { HealthTab } from './pages/valuation/HealthTab';
import { DecisionsTab } from './pages/valuation/DecisionsTab';
import { OverwritesSchemaPage } from './pages/OverwritesSchemaPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminSettingsPage } from './pages/AdminSettingsPage';
import { AdminSsoPage } from './pages/AdminSsoPage';
import { AdminRetentionPage } from './pages/AdminRetentionPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AdminPartnersPage } from './pages/AdminPartnersPage';
import { PartnerDetailPage } from './pages/PartnerDetailPage';
import { EmailOutboxPage } from './pages/EmailOutboxPage';
import { PartnerPortalPage } from './pages/PartnerPortalPage';
import { ApiDocsPage } from './pages/ApiDocsPage';
import { PartnerLoginPage } from './pages/PartnerLoginPage';
import { SearchPage } from './pages/SearchPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { SensitivityPage } from './pages/SensitivityPage';
import { TasksPage } from './pages/TasksPage';
import { BotPromptsPage } from './pages/BotPromptsPage';
import { ActivityLogPage } from './pages/ActivityLogPage';
import { HelpPage } from './pages/HelpPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { AdminHelpPage } from './pages/AdminHelpPage';
import { BillingPage } from './pages/BillingPage';
import { SupportInboxPage } from './pages/SupportInboxPage';
import { CommunicationsPage } from './pages/CommunicationsPage';
import { CompanyTab } from './pages/valuation/CompanyTab';
import { PackageTab } from './pages/valuation/PackageTab';
import { OnboardingPage } from './pages/OnboardingPage';
import { PaymentCancelPage, PaymentSuccessPage } from './pages/PaymentRedirectPages';
import { MarketingFooter, MarketingHeader, MarketingLayout } from './components/MarketingLayout';
import { LandingPage } from './pages/marketing/LandingPage';
import { PricingPage } from './pages/marketing/PricingPage';
import { ProductPage } from './pages/marketing/ProductPage';
import { WhichValuationPage } from './pages/marketing/WhichValuationPage';
import { ComparePage } from './pages/marketing/ComparePage';
import { CompareHubPage } from './pages/marketing/CompareHubPage';
import { AboutPage, ContactPage, PrivacyPage, TermsPage } from './pages/marketing/StaticPages';
import { NotFoundPage } from './pages/NotFoundPage';

/** Role-aware landing: partners live in their portal, everyone else on /dashboard. */
function RoleLanding() {
  const { user } = useAuth();
  return <Navigate to={isPartner(user) ? '/partner' : '/dashboard'} replace />;
}

/**
 * / serves the public marketing landing to anonymous visitors (409.ai §22)
 * and routes signed-in users straight to their workspace.
 */
function HomeGate() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper-100">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-bond-600" />
      </div>
    );
  }
  if (status === 'anonymous') {
    return (
      <div className="flex min-h-screen flex-col bg-paper-50">
        <MarketingHeader />
        <main className="flex-1">
          <LandingPage />
        </main>
        <MarketingFooter />
      </div>
    );
  }
  return <RoleLanding />;
}

export default function App() {
  return (
    <Routes>
      {/* Public marketing site (409.ai §22) */}
      <Route path="/" element={<HomeGate />} />
      <Route element={<MarketingLayout />}>
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/which-valuation" element={<WhichValuationPage />} />
        <Route path="/products/:slug" element={<ProductPage />} />
        {/* Hub route must precede the :slug catch-all (gap #30) */}
        <Route path="/compare/409a-valuation-providers" element={<CompareHubPage />} />
        <Route path="/compare/:slug" element={<ComparePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/terms-of-service" element={<TermsPage />} />
        <Route path="/privacy-policy" element={<PrivacyPage />} />
      </Route>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/auth/google/complete" element={<GoogleCompletePage />} />
      {/* Public board-member resolution signing (feature 5) */}
      <Route path="/board-sign" element={<BoardSignPage />} />
      {/* Public external auditor portal (feature 8), token from link fragment */}
      <Route path="/auditor" element={<AuditorPortalPage />} />
      {/* White-label partner login (improvement 8) — public, branded per slug */}
      <Route path="/partner/:slug/login" element={<PartnerLoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/valuations" element={<ValuationsPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/valuations/new" element={<NewValuationPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/payment/cancel" element={<PaymentCancelPage />} />
        <Route path="/valuations/:id" element={<ValuationWorkspace />}>
          <Route index element={<ValuationDetailPage />} />
          <Route path="intake" element={<IntakeTab />} />
          <Route path="company" element={<CompanyTab />} />
          <Route path="documents" element={<DocumentsTab />} />
          <Route path="cap-table" element={<CapTableTab />} />
          <Route path="model" element={<FinancialModelTab />} />
          <Route path="params" element={<ParamsTab />} />
          <Route path="ai" element={<AiTab />} />
          <Route path="tasks" element={<TasksTab />} />
          <Route path="calculations" element={<CalculationsTab />} />
          <Route path="progress" element={<ProgressTab />} />
          <Route path="qa" element={<QaTab />} />
          <Route path="health" element={<HealthTab />} />
          <Route path="decisions" element={<DecisionsTab />} />
          <Route path="scenarios" element={<ScenariosTab />} />
          <Route path="bridge" element={<BridgeTab />} />
          <Route path="analytics" element={<AnalyticsTab />} />
          <Route path="workbook" element={<WorkbookTab />} />
          <Route path="overwrites" element={<OverwritesTab />} />
          <Route path="report" element={<ReportTab />} />
          <Route path="grants" element={<GrantsTab />} />
          <Route path="asc718" element={<Asc718Tab />} />
          <Route path="monitoring" element={<MonitoringTab />} />
          <Route path="engagement" element={<EngagementTab />} />
          <Route path="package" element={<PackageTab />} />
        </Route>
        {/* Operations-only surfaces (P1 #5 — route-level role guarding) */}
        <Route element={<RequireRole allow={isOps} />}>
          <Route path="/funds" element={<FundPortfolioPage />} />
          <Route path="/debt" element={<DebtInstrumentsPage />} />
          <Route path="/valuations/:id/sensitivity" element={<SensitivityPage />} />
          <Route path="/engagements" element={<EngagementsPage />} />
          <Route path="/monitors" element={<MonitorsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/schema/overwrites" element={<OverwritesSchemaPage />} />
          <Route path="/admin/prompts" element={<BotPromptsPage />} />
          <Route path="/admin/support" element={<SupportInboxPage />} />
          <Route path="/admin/outbox" element={<EmailOutboxPage />} />
          <Route path="/admin/communications" element={<CommunicationsPage />} />
          <Route path="/admin/activity" element={<ActivityLogPage />} />
          <Route path="/admin/help" element={<AdminHelpPage />} />
          {/* Ops read the settings; the API rejects writes from non-admins. */}
          <Route path="/admin/settings" element={<AdminSettingsPage />} />
        </Route>
        {/* User-admin surfaces */}
        <Route element={<RequireRole allow={canManageUsers} />}>
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/admin/sso" element={<AdminSsoPage />} />
          <Route path="/admin/retention" element={<AdminRetentionPage />} />
          <Route path="/admin/partners" element={<AdminPartnersPage />} />
          <Route path="/admin/partners/:id" element={<PartnerDetailPage />} />
        </Route>
        {/* Partner portal */}
        <Route element={<RequireRole allow={isPartner} />}>
          <Route path="/partner" element={<PartnerPortalPage />} />
        </Route>
        <Route path="/partner/api-docs" element={<ApiDocsPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/help/:slug" element={<HelpPage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      {/* Real 404 for unknown URLs instead of a silent redirect home (F-1 P2). */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
