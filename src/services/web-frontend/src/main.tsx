import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ConsentProvider } from './lib/consent';
import { Analytics } from './components/Analytics';
import { CookieConsent } from './components/CookieConsent';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <ConsentProvider>
          <AuthProvider>
            <App />
            <Analytics />
            <CookieConsent />
          </AuthProvider>
        </ConsentProvider>
      </BrowserRouter>
    </HelmetProvider>
  </StrictMode>,
);
