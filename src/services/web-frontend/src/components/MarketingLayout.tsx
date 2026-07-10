import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Wordmark } from './Logo';
import { COMPARISONS, PRODUCTS, SOCIAL_LINKS } from '../lib/marketing';

/** Brand glyph for a social link (gap #29). */
function SocialIcon({ label }: { label: string }) {
  if (label.startsWith('LinkedIn')) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.8 0 0 .78 0 1.73v20.53C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.74V1.73C24 .78 23.2 0 22.22 0z" />
      </svg>
    );
  }
  // X / Twitter
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.22-6.82-5.97 6.82H1.66l7.73-8.84L1.24 2.25h6.83l4.71 6.23 5.46-6.23zm-1.16 17.52h1.83L7.01 4.13H5.05l12.03 15.64z" />
    </svg>
  );
}

/**
 * Public marketing shell (409.ai §22): sticky header with the products
 * dropdown and sign-in/start CTAs, shared footer with product / compare /
 * company / legal link columns.
 */

function ProductsMenu({ onNavigate }: { onNavigate?: () => void }) {
  const half = Math.ceil(PRODUCTS.length / 2);
  return (
    <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
      {[PRODUCTS.slice(0, half), PRODUCTS.slice(half)].map((column, i) => (
        <div key={i}>
          {column.map((p) => (
            <Link
              key={p.slug}
              to={`/products/${p.slug}`}
              onClick={onNavigate}
              className="block rounded px-2 py-1.5 text-sm text-ink-700 hover:bg-paper-100 hover:text-ink-900"
            >
              {p.name}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

export function MarketingHeader() {
  const [productsOpen, setProductsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-paper-300 bg-paper-50/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link to="/" aria-label="N409 home">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Marketing">
          <div
            className="relative"
            onMouseEnter={() => setProductsOpen(true)}
            onMouseLeave={() => setProductsOpen(false)}
          >
            <button
              className="cursor-pointer rounded-md px-3 py-2 text-sm font-semibold text-ink-700 hover:text-ink-900"
              aria-expanded={productsOpen}
              onClick={() => setProductsOpen((v) => !v)}
            >
              Products ▾
            </button>
            {productsOpen && (
              <div className="absolute left-1/2 mt-0 w-[34rem] -translate-x-1/2 rounded-lg border border-paper-300 bg-white p-4 shadow-lift">
                <ProductsMenu onNavigate={() => setProductsOpen(false)} />
              </div>
            )}
          </div>
          <Link to="/pricing" className="rounded-md px-3 py-2 text-sm font-semibold text-ink-700 hover:text-ink-900">
            Pricing
          </Link>
          <Link
            to="/which-valuation"
            className="rounded-md px-3 py-2 text-sm font-semibold text-ink-700 hover:text-ink-900"
          >
            Which valuation?
          </Link>
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link to="/login" className="text-sm font-semibold text-ink-700 hover:text-ink-900">
            Log in
          </Link>
          <Link
            to="/register"
            className="rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-white shadow-card transition-colors hover:bg-bond-700"
          >
            Start valuation
          </Link>
        </div>

        <button
          className="cursor-pointer rounded-md p-2 text-ink-700 md:hidden"
          aria-label="Toggle menu"
          onClick={() => setMobileOpen((v) => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div className="border-t border-paper-300 bg-white px-5 py-4 md:hidden">
          <ProductsMenu onNavigate={() => setMobileOpen(false)} />
          <div className="mt-3 flex flex-col gap-2 border-t border-paper-200 pt-3">
            <Link to="/pricing" onClick={() => setMobileOpen(false)} className="text-sm font-semibold text-ink-700">
              Pricing
            </Link>
            <Link
              to="/which-valuation"
              onClick={() => setMobileOpen(false)}
              className="text-sm font-semibold text-ink-700"
            >
              Which valuation?
            </Link>
            <Link to="/login" onClick={() => setMobileOpen(false)} className="text-sm font-semibold text-ink-700">
              Log in
            </Link>
            <Link
              to="/register"
              onClick={() => setMobileOpen(false)}
              className="rounded-md bg-bond-600 px-4 py-2 text-center text-sm font-semibold text-white"
            >
              Start valuation
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

export function MarketingFooter() {
  const half = Math.ceil(PRODUCTS.length / 2);
  return (
    <footer className="border-t border-ink-800 bg-ink-900 text-ink-300">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="overline mb-4 text-brass-400">Products</div>
          <div className="grid grid-cols-1 gap-1.5 text-sm">
            {PRODUCTS.slice(0, half).map((p) => (
              <Link key={p.slug} to={`/products/${p.slug}`} className="hover:text-paper-50">
                {p.name}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <div className="overline mb-4 text-brass-400">More products</div>
          <div className="grid grid-cols-1 gap-1.5 text-sm">
            {PRODUCTS.slice(half).map((p) => (
              <Link key={p.slug} to={`/products/${p.slug}`} className="hover:text-paper-50">
                {p.name}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <div className="overline mb-4 text-brass-400">Compare</div>
          <div className="grid grid-cols-1 gap-1.5 text-sm">
            {COMPARISONS.map((c) => (
              <Link key={c.slug} to={`/compare/${c.slug}`} className="hover:text-paper-50">
                N409 vs {c.competitor}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <div className="overline mb-4 text-brass-400">Company</div>
          <div className="grid grid-cols-1 gap-1.5 text-sm">
            <Link to="/" className="hover:text-paper-50">
              Home
            </Link>
            <Link to="/about" className="hover:text-paper-50">
              About
            </Link>
            <Link to="/which-valuation" className="hover:text-paper-50">
              Which valuation?
            </Link>
            <Link to="/pricing" className="hover:text-paper-50">
              Pricing
            </Link>
            <Link to="/contact" className="hover:text-paper-50">
              Contact us
            </Link>
          </div>
          <div className="overline mt-8 mb-4 text-brass-400">Legal</div>
          <div className="grid grid-cols-1 gap-1.5 text-sm">
            <Link to="/terms-of-service" className="hover:text-paper-50">
              Terms of service
            </Link>
            <Link to="/privacy-policy" className="hover:text-paper-50">
              Privacy policy
            </Link>
          </div>
        </div>
      </div>
      <div className="border-t border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-5 py-5 text-xs text-ink-400 sm:flex-row sm:justify-between">
          <span>© 2026 N409 Valuations. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <nav className="flex items-center gap-3" aria-label="Social media">
              {SOCIAL_LINKS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="text-ink-400 transition-colors hover:text-paper-50"
                >
                  <SocialIcon label={s.label} />
                </a>
              ))}
            </nav>
            <span className="font-mono">Independent · Defensible · Audit-ready</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function MarketingLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-paper-50">
      <MarketingHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <MarketingFooter />
    </div>
  );
}
