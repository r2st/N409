import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { RequireRole } from './components/RequireRole';
import { useAuth } from './lib/auth';
import { canManageUsers, canUseFirmConsole, isFirmAdmin, isOps, isPartner } from './lib/rbac';
import { MarketingFooter, MarketingHeader, MarketingLayout } from './components/MarketingLayout';
import { SkipLink, mainContentTargetProps } from './components/SkipLink';
import { RouteTitleProvider } from './components/RouteTitle';
import { LandingPage } from './pages/marketing/LandingPage';

/**
 * Route-level code splitting.
 *
 * Every page used to be imported eagerly, producing a single ~1 MB chunk: a
 * founder arriving on the marketing site downloaded the whole authenticated
 * application — valuation workspace, admin consoles, charts, the rich-text
 * editor — before the landing page painted. Everything below the marketing
 * entry is now lazy, so the first visit pulls the shell plus the landing page
 * and nothing else.
 *
 * The marketing shell and landing page stay eager on purpose: they are the LCP
 * path for anonymous traffic, and putting them behind a second round trip would
 * trade the bundle win straight back for latency.
 *
 * `lazy` needs a default export, so each import maps the named export across.
 */
const named = <T extends string>(
  loader: () => Promise<Record<string, unknown>>,
  name: T,
): React.LazyExoticComponent<React.ComponentType<Record<string, never>>> =>
  lazy(async () => ({
    default: (await loader())[name] as React.ComponentType<Record<string, never>>,
  }));

// ── Marketing (secondary pages) ───────────────────────────────────────────────
const PricingPage = named(() => import('./pages/marketing/PricingPage'), 'PricingPage');
const ProductPage = named(() => import('./pages/marketing/ProductPage'), 'ProductPage');
const StagePage = named(() => import('./pages/marketing/StagePage'), 'StagePage');
const WhichValuationPage = named(() => import('./pages/marketing/WhichValuationPage'), 'WhichValuationPage');
const ValuationGuidePage = named(() => import('./pages/marketing/GuidePages'), 'ValuationGuidePage');
const WhenDoYouNeedPage = named(() => import('./pages/marketing/GuidePages'), 'WhenDoYouNeedPage');
const ValuationCostPage = named(() => import('./pages/marketing/GuidePages'), 'ValuationCostPage');
const CalculatorPage = named(() => import('./pages/marketing/CalculatorPage'), 'CalculatorPage');
const SampleReportPage = named(() => import('./pages/marketing/SampleReportPage'), 'SampleReportPage');
const ComparePage = named(() => import('./pages/marketing/ComparePage'), 'ComparePage');
const CompareHubPage = named(() => import('./pages/marketing/CompareHubPage'), 'CompareHubPage');
const PartnersPage = named(() => import('./pages/marketing/PartnerPages'), 'PartnersPage');
const PartnerSegmentPage = named(() => import('./pages/marketing/PartnerPages'), 'PartnerSegmentPage');
const DevelopersPage = named(() => import('./pages/marketing/DevelopersPage'), 'DevelopersPage');
const BlogIndexPage = named(() => import('./pages/marketing/BlogPages'), 'BlogIndexPage');
const BlogPostPage = named(() => import('./pages/marketing/BlogPages'), 'BlogPostPage');
const AboutPage = named(() => import('./pages/marketing/StaticPages'), 'AboutPage');
const ContactPage = named(() => import('./pages/marketing/StaticPages'), 'ContactPage');
const PrivacyPage = named(() => import('./pages/marketing/StaticPages'), 'PrivacyPage');
const TermsPage = named(() => import('./pages/marketing/StaticPages'), 'TermsPage');
const NotFoundPage = named(() => import('./pages/NotFoundPage'), 'NotFoundPage');

// ── Authentication ────────────────────────────────────────────────────────────
const LoginPage = named(() => import('./pages/LoginPage'), 'LoginPage');
const RegisterPage = named(() => import('./pages/RegisterPage'), 'RegisterPage');
const ForgotPasswordPage = named(() => import('./pages/ForgotPasswordPage'), 'ForgotPasswordPage');
const ResetPasswordPage = named(() => import('./pages/ResetPasswordPage'), 'ResetPasswordPage');
const VerifyEmailPage = named(() => import('./pages/VerifyEmailPage'), 'VerifyEmailPage');
const AcceptInvitePage = named(() => import('./pages/AcceptInvitePage'), 'AcceptInvitePage');
const GoogleCompletePage = named(() => import('./pages/GoogleCompletePage'), 'GoogleCompletePage');
const AuditorPortalPage = named(() => import('./pages/AuditorPortalPage'), 'AuditorPortalPage');
const ClientIntakePage = named(() => import('./pages/ClientIntakePage'), 'ClientIntakePage');
const BoardSignPage = named(() => import('./pages/BoardSignPage'), 'BoardSignPage');
const PartnerLoginPage = named(() => import('./pages/PartnerLoginPage'), 'PartnerLoginPage');

// ── Application shell + pages ─────────────────────────────────────────────────
const AppLayout = named(() => import('./components/AppLayout'), 'AppLayout');
const DashboardPage = named(() => import('./pages/DashboardPage'), 'DashboardPage');
const PortfolioPage = named(() => import('./pages/PortfolioPage'), 'PortfolioPage');
const FundPortfolioPage = named(() => import('./pages/FundPortfolioPage'), 'FundPortfolioPage');
const DebtInstrumentsPage = named(() => import('./pages/DebtInstrumentsPage'), 'DebtInstrumentsPage');
const ValuationsPage = named(() => import('./pages/ValuationsPage'), 'ValuationsPage');
const NewValuationPage = named(() => import('./pages/NewValuationPage'), 'NewValuationPage');
const ValuationComparePage = named(() => import('./pages/ValuationComparePage'), 'ValuationComparePage');
const ValuationDetailPage = named(() => import('./pages/ValuationDetailPage'), 'ValuationDetailPage');
const ValuationWorkspace = named(() => import('./pages/valuation/ValuationWorkspace'), 'ValuationWorkspace');
const AiTab = named(() => import('./pages/valuation/PipelineTabs'), 'AiTab');
const CalculationsTab = named(() => import('./pages/valuation/PipelineTabs'), 'CalculationsTab');
const DocumentsTab = named(() => import('./pages/valuation/PipelineTabs'), 'DocumentsTab');
const FinancialModelTab = named(() => import('./pages/valuation/PipelineTabs'), 'FinancialModelTab');
const ParamsTab = named(() => import('./pages/valuation/PipelineTabs'), 'ParamsTab');
const TasksTab = named(() => import('./pages/valuation/PipelineTabs'), 'TasksTab');
const WorkbookTab = named(() => import('./pages/valuation/WorkbookTab'), 'WorkbookTab');
const ScenariosTab = named(() => import('./pages/valuation/ScenariosTab'), 'ScenariosTab');
const BridgeTab = named(() => import('./pages/valuation/BridgeTab'), 'BridgeTab');
const AnalyticsTab = named(() => import('./pages/valuation/AnalyticsTab'), 'AnalyticsTab');
const GrantsTab = named(() => import('./pages/valuation/GrantsTab'), 'GrantsTab');
const Asc718Tab = named(() => import('./pages/valuation/Asc718Tab'), 'Asc718Tab');
const IntakeTab = named(() => import('./pages/valuation/IntakeTab'), 'IntakeTab');
const EngagementTab = named(() => import('./pages/valuation/EngagementTab'), 'EngagementTab');
const EngagementsPage = named(() => import('./pages/EngagementsPage'), 'EngagementsPage');
const CapTableTab = named(() => import('./pages/valuation/CapTableTab'), 'CapTableTab');
const MonitoringTab = named(() => import('./pages/valuation/MonitoringTab'), 'MonitoringTab');
const MonitorsPage = named(() => import('./pages/MonitorsPage'), 'MonitorsPage');
const OverwritesTab = named(() => import('./pages/valuation/OverwritesTab'), 'OverwritesTab');
const ReportTab = named(() => import('./pages/valuation/ReportTab'), 'ReportTab');
const ProgressTab = named(() => import('./pages/valuation/ProgressTab'), 'ProgressTab');
const AuditTrailTab = named(() => import('./pages/valuation/AuditTrailTab'), 'AuditTrailTab');
const NetworkTab = named(() => import('./pages/valuation/NetworkTab'), 'NetworkTab');
const QaTab = named(() => import('./pages/valuation/QaTab'), 'QaTab');
const HealthTab = named(() => import('./pages/valuation/HealthTab'), 'HealthTab');
const CompletenessTab = named(() => import('./pages/valuation/CompletenessTab'), 'CompletenessTab');
const DecisionsTab = named(() => import('./pages/valuation/DecisionsTab'), 'DecisionsTab');
const CompanyTab = named(() => import('./pages/valuation/CompanyTab'), 'CompanyTab');
const PackageTab = named(() => import('./pages/valuation/PackageTab'), 'PackageTab');
const SpecialtyTab = named(() => import('./pages/valuation/SpecialtyTab'), 'SpecialtyTab');
const ResearchTab = named(() => import('./pages/valuation/ResearchTab'), 'ResearchTab');
const ComparablesTab = named(() => import('./pages/valuation/ComparablesTab'), 'ComparablesTab');
const OverwritesSchemaPage = named(() => import('./pages/OverwritesSchemaPage'), 'OverwritesSchemaPage');
const SettingsPage = named(() => import('./pages/SettingsPage'), 'SettingsPage');
const AdminSettingsPage = named(() => import('./pages/AdminSettingsPage'), 'AdminSettingsPage');
const BrandingPage = named(() => import('./pages/BrandingPage'), 'BrandingPage');
const FirmDashboardPage = named(() => import('./pages/FirmDashboardPage'), 'FirmDashboardPage');
const AdminSsoPage = named(() => import('./pages/AdminSsoPage'), 'AdminSsoPage');
const AdminRetentionPage = named(() => import('./pages/AdminRetentionPage'), 'AdminRetentionPage');
const AdminUsersPage = named(() => import('./pages/AdminUsersPage'), 'AdminUsersPage');
const AdminPartnersPage = named(() => import('./pages/AdminPartnersPage'), 'AdminPartnersPage');
const AdminApiTokensPage = named(() => import('./pages/AdminApiTokensPage'), 'AdminApiTokensPage');
const PartnerDetailPage = named(() => import('./pages/PartnerDetailPage'), 'PartnerDetailPage');
const EmailOutboxPage = named(() => import('./pages/EmailOutboxPage'), 'EmailOutboxPage');
const AdminJobsPage = named(() => import('./pages/AdminJobsPage'), 'AdminJobsPage');
const InboxPage = named(() => import('./pages/InboxPage'), 'InboxPage');
const PartnerPortalPage = named(() => import('./pages/PartnerPortalPage'), 'PartnerPortalPage');
const ApiDocsPage = named(() => import('./pages/ApiDocsPage'), 'ApiDocsPage');
const SearchPage = named(() => import('./pages/SearchPage'), 'SearchPage');
const NotificationsPage = named(() => import('./pages/NotificationsPage'), 'NotificationsPage');
const TemplatesPage = named(() => import('./pages/TemplatesPage'), 'TemplatesPage');
const SensitivityPage = named(() => import('./pages/SensitivityPage'), 'SensitivityPage');
const TasksPage = named(() => import('./pages/TasksPage'), 'TasksPage');
const BotPromptsPage = named(() => import('./pages/BotPromptsPage'), 'BotPromptsPage');
const AdminNarrativePromptsPage = named(
  () => import('./pages/AdminNarrativePromptsPage'),
  'AdminNarrativePromptsPage',
);
const AdminDocumentsPage = named(() => import('./pages/AdminDocumentsPage'), 'AdminDocumentsPage');
const AdminDataRemediationPage = named(
  () => import('./pages/AdminDataRemediationPage'),
  'AdminDataRemediationPage',
);
const ActivityLogPage = named(() => import('./pages/ActivityLogPage'), 'ActivityLogPage');
const HelpPage = named(() => import('./pages/HelpPage'), 'HelpPage');
const FeaturesPage = named(() => import('./pages/FeaturesPage'), 'FeaturesPage');
const AdminHelpPage = named(() => import('./pages/AdminHelpPage'), 'AdminHelpPage');
const AdminBlogPage = named(() => import('./pages/AdminBlogPage'), 'AdminBlogPage');
const BillingPage = named(() => import('./pages/BillingPage'), 'BillingPage');
const SupportInboxPage = named(() => import('./pages/SupportInboxPage'), 'SupportInboxPage');
const CommunicationsPage = named(() => import('./pages/CommunicationsPage'), 'CommunicationsPage');
const OnboardingPage = named(() => import('./pages/OnboardingPage'), 'OnboardingPage');
const PaymentSuccessPage = named(() => import('./pages/PaymentRedirectPages'), 'PaymentSuccessPage');
const PaymentCancelPage = named(() => import('./pages/PaymentRedirectPages'), 'PaymentCancelPage');

/** Shared full-page loader — used while auth resolves and while a chunk loads. */
function PageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-100">
      <div
        role="status"
        aria-label="Loading"
        className="h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-bond-600"
      />
    </div>
  );
}

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
  if (status === 'loading') return <PageLoader />;
  if (status === 'anonymous') {
    return (
      <div className="flex min-h-screen flex-col bg-paper-50">
        <SkipLink />
        <MarketingHeader />
        <main {...mainContentTargetProps} className={`flex-1 ${mainContentTargetProps.className}`}>
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
    <Suspense fallback={<PageLoader />}>
      {/* Every route's `<title>`, from one registry — see lib/pageTitles.ts. */}
      <RouteTitleProvider>
        <Routes>
          {/* Public marketing site (409.ai §22) */}
          <Route path="/" element={<HomeGate />} />
          <Route element={<MarketingLayout />}>
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/which-valuation" element={<WhichValuationPage />} />
            <Route path="/409a-valuation-guide" element={<ValuationGuidePage />} />
            <Route path="/when-do-you-need-a-409a" element={<WhenDoYouNeedPage />} />
            <Route path="/how-much-does-a-409a-cost" element={<ValuationCostPage />} />
            <Route path="/tools/409a-valuation-calculator" element={<CalculatorPage />} />
            <Route path="/sample-report" element={<SampleReportPage />} />
            <Route path="/products/:slug" element={<ProductPage />} />
            <Route path="/409a-valuation/:stage" element={<StagePage />} />
            {/* Hub route must precede the :slug catch-all (gap #30) */}
            <Route path="/compare/409a-valuation-providers" element={<CompareHubPage />} />
            <Route path="/compare/:slug" element={<ComparePage />} />
            <Route path="/partners" element={<PartnersPage />} />
            <Route path="/partners/:segment" element={<PartnerSegmentPage />} />
            <Route path="/developers" element={<DevelopersPage />} />
            <Route path="/blog" element={<BlogIndexPage />} />
            <Route path="/blog/:slug" element={<BlogPostPage />} />
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
          {/* Firm-branded client intake — public, token from the link fragment */}
          <Route path="/intake" element={<ClientIntakePage />} />
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
            <Route path="/valuations/compare" element={<ValuationComparePage />} />
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
              <Route path="audit-trail" element={<AuditTrailTab />} />
              <Route path="network" element={<NetworkTab />} />
              <Route path="qa" element={<QaTab />} />
              <Route path="health" element={<HealthTab />} />
              <Route path="completeness" element={<CompletenessTab />} />
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
              <Route path="specialty" element={<SpecialtyTab />} />
              <Route path="research" element={<ResearchTab />} />
              <Route path="comparables" element={<ComparablesTab />} />
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
              <Route path="/admin/narrative-prompts" element={<AdminNarrativePromptsPage />} />
              <Route path="/admin/data-remediation" element={<AdminDataRemediationPage />} />
              <Route path="/admin/documents" element={<AdminDocumentsPage />} />
              <Route path="/admin/support" element={<SupportInboxPage />} />
              <Route path="/admin/outbox" element={<EmailOutboxPage />} />
              <Route path="/admin/jobs" element={<AdminJobsPage />} />
              <Route path="/admin/communications" element={<CommunicationsPage />} />
              <Route path="/admin/activity" element={<ActivityLogPage />} />
              <Route path="/admin/help" element={<AdminHelpPage />} />
              <Route path="/admin/blog" element={<AdminBlogPage />} />
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
              <Route path="/admin/api-tokens" element={<AdminApiTokensPage />} />
            </Route>
            {/* Partner portal */}
            <Route element={<RequireRole allow={isPartner} />}>
              <Route path="/partner" element={<PartnerPortalPage />} />
            </Route>
            {/* A firm white-labelling itself; the API re-checks the tenant. */}
            <Route element={<RequireRole allow={isFirmAdmin} />}>
              <Route path="/settings/branding" element={<BrandingPage />} />
            </Route>
            {/* The firm console — everyone inside a firm, ops included. */}
            <Route element={<RequireRole allow={canUseFirmConsole} />}>
              <Route path="/firm" element={<FirmDashboardPage />} />
            </Route>
            <Route path="/partner/api-docs" element={<ApiDocsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            {/* Not inside the ops guard: a partner firm's staff have an inbox too,
              scoped to their own engagements by the API. */}
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/help/:slug" element={<HelpPage />} />
            <Route path="/features" element={<FeaturesPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          {/* Real 404 for unknown URLs instead of a silent redirect home (F-1 P2). */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </RouteTitleProvider>
    </Suspense>
  );
}
