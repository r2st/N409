import { useCallback, useState } from 'react';
import { downloadPdf } from './m2';
import { getToken } from './api';

/**
 * A download button that can say it failed.
 *
 * `downloadPdf` fetches the file itself — it has to, because the endpoints are
 * bearer-authenticated and a plain `<a href>` carries no token — so unlike a
 * real link there is no browser-provided failure UI behind it. It throws on
 * anything but a 2xx, and two of the three call sites caught that with
 * `.catch(() => {})`.
 *
 * A discarded rejection here is worse than a discarded load. A load that fails
 * leaves a page that is visibly missing something; a *click* that fails leaves
 * a page identical to the one before the click, which is also exactly what a
 * dead button looks like. The report download on the client-facing progress tab
 * is the sharp case: the client is there to collect their 409A, the file is
 * being generated on demand and can genuinely 5xx, and the honest failure was
 * rendered as nothing at all. They click again, and again, and then email
 * somebody — having been told, at no point, that anything went wrong.
 *
 * `busy` is part of the same problem rather than a nicety: report PDFs take
 * long enough to render that silence during the wait is its own reason to
 * click twice.
 */
export function useDownload(): {
  /** Starts a download; never rejects — the failure lands in `error`. */
  start: (path: string, filename: string) => void;
  busy: boolean;
  /** Set when the last attempt failed, cleared when a new one starts. */
  error: string | null;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback((path: string, filename: string) => {
    setBusy(true);
    setError(null);
    void downloadPdf(path, filename, getToken())
      .catch(() =>
        // The message deliberately does not repeat the status code: the caller
        // cannot act on a 502 differently from a 503, and "try again" is the
        // true and only advice for both.
        setError('The download did not start. Try again, and let us know if it keeps failing.'),
      )
      .finally(() => setBusy(false));
  }, []);

  return { start, busy, error };
}

/** Strips a company name down to something safe to use as a filename stem. */
export function filenameStem(companyName: string): string {
  return companyName.replace(/[^\w.-]+/g, '_');
}
