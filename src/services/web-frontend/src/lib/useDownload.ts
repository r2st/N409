import { useCallback, useState } from 'react';
import { apiDownload, describeActionFailure } from './api';

/**
 * A download button that can say it failed.
 *
 * `apiDownload` fetches the file itself — it has to, because the endpoints are
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
  /**
   * Starts a download; never rejects — the failure lands in `error`.
   *
   * `filename` is a fallback: when the response names the file itself, that
   * name wins, because the server knows the version number and the document's
   * original name and the caller is guessing at both.
   */
  start: (path: string, filename: string) => void;
  busy: boolean;
  /** Set when the last attempt failed, cleared when a new one starts. */
  error: string | null;
  /**
   * Set when the server capped the file it just sent, cleared when a new
   * attempt starts.
   *
   * The same discarded-result problem as `error`, one step quieter. `apiDownload`
   * has returned this since the export routes started setting
   * `x-export-truncated`, and this hook threw it away — so a change log that
   * stopped at MAX_TRAIL_EVENTS downloaded exactly like a complete one. A
   * failed download at least leaves the user with no file; a capped one leaves
   * them holding a file they have no reason to doubt.
   */
  truncated: boolean;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const start = useCallback((path: string, filename: string) => {
    setBusy(true);
    setError(null);
    setTruncated(false);
    void apiDownload(path, filename)
      .then((res) => setTruncated(res.truncated))
      .catch((err: unknown) =>
        /*
         * The server's own sentence first, and only then the status prose.
         *
         * The message this replaced was one sentence for every failure —
         * "The download did not start. Try again, and let us know if it keeps
         * failing." — and its comment justified that by the gateway case: a
         * caller cannot act on a 502 differently from a 503, so "try again" is
         * the only advice either licenses. True, and it is the wrong half of
         * the population to reason from. `apiDownload` throws `ApiError` with
         * whatever problem body the endpoint sent, and the two paths behind
         * this hook send written ones: `report.pdf` answers "No report yet" on
         * an engagement whose deliverable has not been produced, and a render
         * that failed upstream arrives through `toProblem` already carrying
         * what to do about it. Both are permanent for as long as they last,
         * and "try again" is advice pointing away from the only thing that
         * would help — which is exactly the shape `bufferUpload` was fixed for
         * on the upload side.
         *
         * `describeActionFailure` keeps the old sentence for the case it was
         * written about: a body with no `detail` still gets the operation
         * followed by `describeDetaillessFailure`, which says the same thing
         * about a 502 in more words.
         */
        setError(describeActionFailure(err, 'The download did not start.')),
      )
      .finally(() => setBusy(false));
  }, []);

  return { start, busy, error, truncated };
}

/**
 * Strips a company name down to something safe to use as a filename stem.
 *
 * `\w` is ASCII — it is `[A-Za-z0-9_]` and nothing else, whatever flags the
 * regex carries — so the previous class deleted every letter outside that range
 * as if it were punctuation. "Ångström Robotics" became `_ngstr_m_Robotics`; a
 * name written in Japanese or Greek or Cyrillic became a row of underscores
 * with a file extension on the end. These names reach a filesystem, not a
 * header, and every filesystem the app runs against has been UTF-8 for twenty
 * years.
 *
 * The class is now the same idea written in Unicode: keep letters, digits and
 * combining marks — the mark class matters, or a decomposed `Å` loses its ring
 * and keeps its `A` — and collapse the rest. Punctuation still goes, so the
 * separators and dot-segments a name could otherwise smuggle in still collapse
 * to `_`.
 */
export function filenameStem(companyName: string): string {
  return companyName.replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '_');
}
