import type { FastifyInstance } from 'fastify';

/**
 * `Permissions-Policy` for the three Fastify services (round 74).
 *
 * Separate from the helmet registration in each service because helmet does not
 * set this header at all — it was the one item on the round's checklist that
 * every service was missing, on both the API surfaces and the HTML origin.
 *
 * The header disables browser features at the document level, and a feature
 * disabled here cannot be re-enabled by an `allow=` attribute further down: a
 * document may only delegate what it was itself granted. That is what makes the
 * header worth setting — an injected script cannot ask for the camera if the
 * document was never allowed one — and it is also the reason the two policies
 * below are not the same list. A blanket deny on the HTML origin would take the
 * marketing page's `<iframe allow="autoplay; encrypted-media; picture-in-picture">`
 * with it, and the failure mode of a policy that breaks a feature is that
 * somebody removes the policy.
 */

/**
 * Features denied on every surface. These are the powerful ones: nothing in a
 * 409A platform reads a sensor, opens a camera, or talks to a USB device, so
 * granting them to the document has no upside and a script that finds a way to
 * ask is exactly what this header exists to refuse.
 *
 * `payment` is on the list deliberately even though the product takes payments:
 * Stripe checkout here is a redirect to a Stripe-hosted page (PaymentSection),
 * not an embedded Payment Request, so the API this denies is one the SPA has
 * never called.
 */
const DENIED_EVERYWHERE = [
  'accelerometer',
  'ambient-light-sensor',
  'camera',
  'display-capture',
  'geolocation',
  'gyroscope',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
] as const;

/**
 * Additionally denied on the JSON APIs. These are the media features the
 * marketing page's demo embed needs (`VITE_DEMO_VIDEO_URL`) and the clipboard
 * write two panels use to hand over an intake link and a minted partner secret
 * — none of which an API response has any business granting, and all of which
 * the HTML origin must keep.
 *
 * `clipboard-write` is the one that would be easy to get wrong: Chrome gates it
 * behind this header with a default allowlist of `self`, so naming it in a deny
 * list on the web service would silently break both copy buttons while leaving
 * every test that does not click one perfectly green.
 */
const DENIED_ON_APIS = [
  'autoplay',
  'clipboard-read',
  'clipboard-write',
  'encrypted-media',
  'fullscreen',
  'picture-in-picture',
] as const;

function deny(features: readonly string[]): string {
  return features.map((f) => `${f}=()`).join(', ');
}

/**
 * Policy for a JSON API (valuation, report). Nothing is granted: these
 * responses are not a document anyone should be running features in.
 */
export const API_PERMISSIONS_POLICY = deny([...DENIED_EVERYWHERE, ...DENIED_ON_APIS].sort());

/**
 * Policy for the HTML origin (web/BFF). The sensor and credential families are
 * denied outright; the media and clipboard families are left at their browser
 * defaults (`self`) rather than named, so the demo embed and the copy buttons
 * keep working and nothing here has to be relaxed later to un-break them.
 */
export const WEB_PERMISSIONS_POLICY = deny([...DENIED_EVERYWHERE].sort());

/**
 * Adds `Permissions-Policy` to every response.
 *
 * An `onSend` hook rather than `onRequest`, so it also lands on the responses
 * that never reach a handler — the 401 from the auth plugin, the 413 from the
 * body limit, the 429 from the throttles — for the same reason the Python
 * services register their equivalent outermost.
 */
export function registerPermissionsPolicy(app: FastifyInstance, policy: string): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    // Never overwrite: a route that has set its own policy meant it.
    if (!reply.hasHeader('permissions-policy')) void reply.header('permissions-policy', policy);
    return payload;
  });
}
