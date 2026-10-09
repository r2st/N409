import { useState } from 'react';
import { siteOrigin } from '../lib/seo';

interface ShareResultBarProps {
  title: string;
  text: string;
  emailSubject?: string;
  emailLabel?: string;
  /** Custom WhatsApp message. Falls back to `text` + page URL. */
  whatsappText?: string;
  className?: string;
}

export function ShareResultBar({
  title,
  text,
  emailSubject,
  emailLabel = 'Email result',
  whatsappText,
  className = '',
}: ShareResultBarProps) {
  const [copied, setCopied] = useState(false);
  const origin = siteOrigin();
  const pageUrl = `${origin}${window.location.pathname}`;
  const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
  const mailSubject = emailSubject ?? title;
  const mailBody = `${text}\n\nCalculated at: ${pageUrl}`;
  const mailHref = `mailto:?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;
  const waMessage = whatsappText ?? `${text}\n\n${pageUrl}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(waMessage)}`;

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
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-700 transition-colors hover:bg-green-100"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.28-.1-.48-.15-.68.15s-.78.97-.95 1.17-.35.22-.65.07c-.3-.15-1.27-.47-2.42-1.49-.9-.8-1.5-1.78-1.67-2.08-.18-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.38-.03-.52-.07-.15-.68-1.63-.93-2.23-.24-.59-.49-.51-.68-.52h-.58c-.2 0-.52.07-.8.38-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.27.49 1.7.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.18-1.41-.08-.13-.28-.2-.58-.35M12.05 21.8c-1.8 0-3.55-.48-5.1-1.4l-.36-.22-3.78 1 1.01-3.7-.24-.38A9.82 9.82 0 0 1 2.2 12.04c0-5.43 4.42-9.84 9.86-9.84a9.78 9.78 0 0 1 6.97 2.89 9.78 9.78 0 0 1 2.89 6.96c0 5.43-4.43 9.85-9.86 9.85M20.52 3.48A11.77 11.77 0 0 0 12.05 0C5.47 0 .1 5.37.1 11.95c0 2.11.55 4.17 1.6 5.98L0 24l6.24-1.64a11.96 11.96 0 0 0 5.72 1.46h.01c6.57 0 11.94-5.37 11.94-11.95a11.87 11.87 0 0 0-3.5-8.39" />
        </svg>
        WhatsApp
      </a>
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
        LinkedIn
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
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}
