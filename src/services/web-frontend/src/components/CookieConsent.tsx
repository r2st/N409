import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useConsent } from '../lib/consent';
import { useFocusTrap } from './ui';

/**
 * GDPR cookie-consent banner (409.ai §25). Shows on first visit only; the
 * choice is persisted and read by <Analytics> so tracking scripts load solely
 * after "Accept". Declining leaves analytics off.
 */
export function CookieConsent(): React.JSX.Element | null {
  const { needsChoice, accept, decline } = useConsent();
  // Focus trap + Esc-to-decline so the consent gate is keyboard-operable and
  // dialog semantics are complete (audit F-3 P2).
  const bannerRef = useFocusTrap<HTMLDivElement>(needsChoice, decline);
  const descId = useId();
  if (!needsChoice) return null;

  return (
    <div
      ref={bannerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Cookie consent"
      aria-describedby={descId}
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 z-50 border-t border-paper-300 bg-surface/95 backdrop-blur focus:outline-none"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p id={descId} className="max-w-2xl text-sm leading-relaxed text-ink-700">
          We use cookies to understand how the site is used and to improve it. Analytics cookies load only if
          you accept. See our{' '}
          <Link to="/privacy-policy" className="font-semibold text-bond-600 hover:text-bond-700">
            privacy policy
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={decline}
            className="cursor-pointer rounded-md border border-paper-300 px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:bg-paper-100"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className="cursor-pointer rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
