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
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Top-level boundary (audit F-1 P1): a render throw shows a recoverable
        fallback instead of a white screen. */}
    <ErrorBoundary>
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
