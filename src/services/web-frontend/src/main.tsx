import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import App from './App';
import { AuthProvider } from './lib/auth';
import { BrandingProvider } from './lib/branding';
import { ConsentProvider } from './lib/consent';
import { Analytics } from './components/Analytics';
import { CookieConsent } from './components/CookieConsent';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalCrashHandlers, reportCrash } from './lib/crashReport';
import './index.css';

// A React boundary sees render, lifecycle and effect errors. It does not see a
// throw from an event handler, a timer, or a promise nobody awaited — which is
// most of them in an app whose work is asynchronous. Installed before the first
// render so a crash during mount is reported too.
installGlobalCrashHandlers();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Top-level boundary (audit F-1 P1): a render throw shows a recoverable
        fallback instead of a white screen. */}
    <ErrorBoundary onError={(error, info) => reportCrash('render', error, info.componentStack ?? undefined)}>
      <HelmetProvider>
        <BrowserRouter>
          <ConsentProvider>
            <AuthProvider>
              {/* Inside AuthProvider: the tenant's brand is resolved from the
                  session, and reverts to platform branding on sign-out. */}
              <BrandingProvider>
                <App />
                <Analytics />
                <CookieConsent />
              </BrandingProvider>
            </AuthProvider>
          </ConsentProvider>
        </BrowserRouter>
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>,
);
