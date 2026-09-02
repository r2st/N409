import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { MARKETING_PREFERENCE_KEY } from '../domain/communications.js';
import { verifyUnsubscribeToken } from '../domain/unsubscribeToken.js';
import { upsertPreference } from '../repos/notificationPreferences.js';
import { logFailure, logUnretried } from '@n409/shared';

/**
 * One-click unsubscribe (RFC 8058), the endpoint behind `List-Unsubscribe`.
 *
 * Unauthenticated by design and by necessity: the POST is made by the mailbox
 * provider, not the recipient — Gmail and Yahoo issue it from their own
 * infrastructure with no cookie and no redirect followed — and the whole point
 * of the header is that unsubscribing takes no login. Authority comes from the
 * signed token instead; see `domain/unsubscribeToken` for why that is safe.
 *
 * Both verbs are served:
 *   * `POST` is the machine path. It answers 200 with an empty body, because a
 *     provider that gets anything else may decide the sender does not honour
 *     one-click and stop showing the button.
 *   * `GET` is what a human clicking the footer link gets, and answers HTML —
 *     a recipient who lands on raw JSON has no idea whether it worked, and a
 *     recipient who is not sure it worked reports the mail as spam.
 *
 * An invalid or expired token still answers 200. The alternative is telling a
 * caller which tokens are real, and — worse — showing a recipient an error page
 * for a link out of a two-year-old email, which converts a resolved complaint
 * into a spam report. What we do not do is act on it.
 *
 * Only marketing consent is touched. Notifications about a client's own
 * valuation are not a mailing list and are never silenced from here.
 */

const Query = z.object({ token: z.string().min(1).max(4096) });

/** No-store: the response reflects an account state that just changed. */
function html(reply: FastifyReply, status: number, title: string, message: string): FastifyReply {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escape(title)}</title></head>` +
        `<body style="margin:0;padding:48px 16px;background:#f4f5f7;color:#0f172a;` +
        `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
        `<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;` +
        `border-radius:8px;padding:32px">` +
        `<h1 style="margin:0 0 12px;font-size:20px">${escape(title)}</h1>` +
        `<p style="margin:0;line-height:1.55;color:#475569">${escape(message)}</p>` +
        `</div></body></html>`,
    );
}

export function registerUnsubscribeRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; secret: string },
): void {
  /** Returns whether the token was good; never throws on a bad one. */
  const apply = async (raw: unknown): Promise<boolean> => {
    const parsed = Query.safeParse(raw);
    if (!parsed.success) return false;
    const claims = verifyUnsubscribeToken(parsed.data.token, deps.secret);
    if (!claims) return false;
    // In-app stays on: the marketing switch in settings is the same row, and
    // turning off the banner a client never complained about would be a change
    // they did not ask for. The email channel is what the header promises.
    await upsertPreference(deps.pool, claims.userId, MARKETING_PREFERENCE_KEY, {
      in_app: true,
      email: false,
    });
    return true;
  };

  /**
   * Scoped urlencoded parser. RFC 8058 says the provider POSTs
   * `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded`, and
   * Fastify ships parsers for JSON and text only — so without this the request
   * is refused with a 415 before the handler runs, and the provider records
   * every one-click attempt as a failure. The body itself is not read; the
   * token travels in the query string, where the header put it. Scoped rather
   * than global so no other route silently gains a form parser.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, _body, done) => done(null, {}),
    );

    scope.post('/api/v1/unsubscribe', async (req, reply) => {
      const ok = await apply(req.query).catch((err: unknown) => {
        /*
         * `logUnretried`, not `warn` (R352, methodology M5).
         *
         * The 200 below is deliberate and stays — but it is also the end of
         * this request's life. Gmail and Yahoo issue the one-click POST once
         * and read the 2xx as the unsubscribe having been honoured; there is
         * no redelivery, the recipient is not told, and nothing here queues a
         * second attempt. So a pool that was busy for one second leaves a
         * person who asked to stop hearing from us still on the list, with a
         * `warn` — the level that in this estate means "a retry is coming" —
         * as the only trace, and the next thing that happens is a spam report
         * against the sending domain.
         *
         * `alert: true` and a classified `failure_reason`, which is what the
         * rest of the post-commit population gets for exactly this shape.
         */
        logUnretried(app.log, err, {}, 'a one-click unsubscribe was not applied and will not be retried');
        return false;
      });
      // 200 either way. A provider that gets a non-2xx may conclude the sender
      // does not honour one-click and stop offering the button at all.
      return reply.status(200).header('cache-control', 'no-store').send({ unsubscribed: ok });
    });
  });

  app.get('/api/v1/unsubscribe', async (req, reply) => {
    let ok = false;
    try {
      ok = await apply(req.query);
    } catch (err) {
      // `logFailure`, not a bare `warn`: unlike the POST above this one *is*
      // retriable — the page below asks the reader to try again — so the level
      // is the error's own answer to "is a retry coming", and a permanent
      // cause still alerts rather than sitting at `warn` beside the transient
      // ones. The reader is a person who is being told nothing worked.
      logFailure(req.log, err, {}, 'unsubscribe failed');
      return html(
        reply,
        500,
        'Something went wrong',
        'We could not update your preferences just now. Please try again, or change them in your account settings.',
      );
    }
    return ok
      ? html(
          reply,
          200,
          'You have been unsubscribed',
          'You will no longer receive marketing email from us. Notifications about your own valuations are unaffected — you can change those any time in your account settings.',
        )
      : html(
          reply,
          200,
          'This link has expired',
          'Unsubscribe links stop working after a year. You can turn marketing email off directly in your account settings.',
        );
  });
}
