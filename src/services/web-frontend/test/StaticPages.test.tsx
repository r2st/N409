import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SiteConfig } from '../src/lib/siteConfig';

/**
 * The company and legal pages. Their content is static, but two things about
 * them are not: the mailboxes are environment-configured — an unset address
 * must degrade to the contact form rather than render a link that bounces —
 * and each page has to carry its own canonical path and description, because
 * they are prerendered into separate documents at build (see
 * `prerenderPlugin` in vite.config.ts) and a shared `<head>` would collapse
 * four indexed pages into one.
 */
const configMock = vi.hoisted(() => ({ current: { socialLinks: [] } as SiteConfig }));
vi.mock('../src/lib/siteConfig', () => ({ siteConfig: () => configMock.current }));

const { AboutPage, ContactPage, PrivacyPage, TermsPage } = await import('../src/pages/marketing/StaticPages');

function configure(config: Partial<SiteConfig>) {
  configMock.current = { socialLinks: [], ...config };
}

const show = (page: React.ReactElement) => render(<MemoryRouter>{page}</MemoryRouter>);

afterEach(() => {
  vi.restoreAllMocks();
  configure({});
});

describe('AboutPage', () => {
  it('states what the platform is and the three things behind a report', () => {
    show(<AboutPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'About N409' })).toBeInTheDocument();
    expect(screen.getByText(/AI ingestion layer/)).toBeInTheDocument();
    expect(screen.getByText(/credentialed analysts who review/)).toBeInTheDocument();
  });

  it('sends a reader with questions to the contact page', () => {
    show(<AboutPage />);
    expect(screen.getByRole('link', { name: 'Get in touch' })).toHaveAttribute('href', '/contact');
  });
});

describe('TermsPage', () => {
  /*
   * The clauses a valuation platform is actually judged on. "Not tax or legal
   * advice" and the liability cap are the two a reader looks for, and a
   * silently dropped heading is the kind of edit nothing else would catch.
   */
  it('carries every numbered clause', () => {
    show(<TermsPage />);
    for (const clause of [
      '1. Services',
      '2. Client responsibilities',
      '3. Payment',
      '4. No tax or legal advice',
      '5. Limitation of liability',
    ]) {
      expect(screen.getByRole('heading', { name: clause })).toBeInTheDocument();
    }
  });

  it('says a report is a valuation opinion, not advice, and caps liability at the fee', () => {
    show(<TermsPage />);
    expect(screen.getByText(/not tax, legal, or investment advice/)).toBeInTheDocument();
    expect(screen.getByText(/limited to\s+the fees paid for that Report/)).toBeInTheDocument();
  });

  it('is dated, so a reader can tell which version they agreed to', () => {
    show(<TermsPage />);
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
  });
});

describe('PrivacyPage', () => {
  it('states the cap-table anonymisation and that data is not sold', () => {
    show(<PrivacyPage />);
    expect(screen.getByText(/shareholder names never leave the platform/)).toBeInTheDocument();
    expect(screen.getByText(/We do not sell your data/)).toBeInTheDocument();
  });

  it('routes a data-subject request through the contact form when no address is set', () => {
    show(<PrivacyPage />);
    expect(screen.getByRole('link', { name: 'contact form' })).toHaveAttribute('href', '/contact');
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  /** A configured mailbox is the better route — but only once it exists. */
  it('offers the privacy mailbox directly once one is configured', () => {
    configure({ privacyEmail: 'privacy@n409.ai' });
    show(<PrivacyPage />);

    const link = screen.getByRole('link', { name: 'privacy@n409.ai' });
    expect(link).toHaveAttribute('href', 'mailto:privacy@n409.ai');
    expect(screen.queryByRole('link', { name: 'contact form' })).not.toBeInTheDocument();
  });
});

describe('ContactPage', () => {
  it('points existing clients at the in-app widget rather than the form', () => {
    show(<ContactPage />);
    expect(screen.getByText(/in-app support widget/)).toBeInTheDocument();
  });

  it('prints no partnership mailbox when none is configured', () => {
    show(<ContactPage />);
    expect(screen.queryByText(/For partnerships, reach us at/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('adds the partnership mailbox once one is configured', () => {
    configure({ partnersEmail: 'partners@n409.ai' });
    show(<ContactPage />);

    expect(screen.getByText(/For partnerships, reach us at/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'partners@n409.ai' })).toHaveAttribute(
      'href',
      'mailto:partners@n409.ai',
    );
  });

  it('offers self-serve registration as the alternative to writing in', () => {
    show(<ContactPage />);
    expect(screen.getByRole('link', { name: 'Start your valuation' })).toHaveAttribute('href', '/register');
  });
});

describe('page metadata', () => {
  /**
   * Each page is prerendered into its own document, so each needs its own
   * canonical link — one shared `<head>` would make four indexed pages read as
   * duplicates of whichever rendered last.
   */
  it.each([
    ['/about', <AboutPage key="a" />],
    ['/contact', <ContactPage key="c" />],
    ['/terms-of-service', <TermsPage key="t" />],
    ['/privacy-policy', <PrivacyPage key="p" />],
  ])('declares %s as its canonical path', (path, page) => {
    show(page);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toContain(path);
  });
});
