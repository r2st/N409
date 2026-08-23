import { z } from 'zod';

/**
 * The scheme rule for URLs a firm configures and a browser later loads.
 *
 * Five settings hold an address that someone else's browser is sent to or
 * fetches from: a firm's three brand images, the partner logo the ops console
 * sets on their behalf, and the SAML IdP the sign-in page redirects to. All
 * five were `z.string().url()`, which is a parse rather than a policy — it
 * accepts every scheme WHATWG will parse, `http:` and `ftp:` and `javascript:`
 * among them.
 *
 * Two of those are real problems rather than theoretical ones:
 *
 *   - The application is served over HTTPS, so an `http:` image is blocked as
 *     mixed content and the firm's logo simply does not appear. Nothing
 *     reports this — the browser drops the request, the page renders with the
 *     fallback mark, and the setting looks saved because it was. The help text
 *     beside those boxes has always said "HTTPS URL"; this makes that true.
 *   - An `http:` IdP entry point carries the SAML AuthnRequest, and with it the
 *     relay state and the fact of who is signing in, in clear text.
 *
 * `javascript:` is the one that sounds worst and is worth the least: it reaches
 * an `<img src>`, a `<link href>` and a `Location:` header, none of which
 * execute it. It is excluded because there is no reason to store it, not
 * because it was live.
 *
 * Relative paths were already rejected by `.url()` and stay rejected: nothing
 * on the platform serves an uploaded logo from its own origin, so a value that
 * is not absolute is a mistake rather than a same-origin asset.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `z.string().url()` narrowed to https, with the length cap the column has. */
export function httpsUrl(max: number): z.ZodEffects<z.ZodString, string, string> {
  return z.string().max(max).refine(isHttpsUrl, 'expected an https:// URL');
}
