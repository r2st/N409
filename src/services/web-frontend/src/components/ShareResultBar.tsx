import { useState } from 'react';
import { siteOrigin } from '../lib/seo';

interface ShareResultBarProps {
  title: string;
  text: string;
  emailSubject?: string;
  emailLabel?: string;
  className?: string;
}

export function ShareResultBar({
  title,
  text,
  emailSubject,
  emailLabel = 'Email result',
  className = '',
}: ShareResultBarProps) {
  const [copied, setCopied] = useState(false);
  const origin = siteOrigin();
  const pageUrl = `${origin}${window.location.pathname}`;
  const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
  const mailSubject = emailSubject ?? title;
  const mailBody = `${text}\n\nCalculated at: ${pageUrl}`;
  const mailHref = `mailto:?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`${text}\n\n${pageUrl}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <a
        href={mailHref}
        className="inline-flex items-center gap-1.5 rounded-md border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-paper-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M22 7l-10 7L2 7" />
        </svg>
        {emailLabel}
      </a>
      <a
        href={linkedInUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-paper-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.8 0 0 .78 0 1.73v20.53C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.74V1.73C24 .78 23.2 0 22.22 0z" />
        </svg>
        Share on LinkedIn
      </a>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-paper-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        {copied ? 'Copied!' : 'Copy result'}
      </button>
    </div>
  );
}
