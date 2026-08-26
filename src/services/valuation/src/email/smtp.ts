import net from 'node:net';
import tls from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import type { EmailOutboxRow } from '../repos/emailOutbox.js';
import { buildMimeMessage, renderHtmlEmail, type ListUnsubscribe } from './mime.js';
import { createUnsubscribeToken, unsubscribeUrl } from '../domain/unsubscribeToken.js';
import type { SmtpStage } from '../domain/emailDelivery.js';

/**
 * Minimal SMTP transport (remaining-gaps §6 P0 #1 — real email delivery).
 *
 * Deliberately dependency-free: EHLO → STARTTLS (or implicit TLS on 465) →
 * AUTH LOGIN → MAIL FROM/RCPT TO/DATA. The outbox keeps delivery state, so a
 * thrown error here just leaves the row 'failed' for a later retry.
 *
 * Message *construction* lives in `./mime` — this file is the conversation with
 * the server, and that one is what the server is handed.
 */

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  /** Dial timeout + per-command timeout, ms. */
  timeoutMs?: number;
}

export { buildMimeMessage } from './mime.js';

/** Bare address out of "Display Name <user@host>". */
export function bareAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  // Strip CR/LF to prevent SMTP command injection via crafted addresses.
  return (match ? match[1]! : from).trim().replace(/[\r\n]/g, '');
}

/**
 * A failed SMTP conversation, carrying enough to classify it.
 *
 * The reply code and the stage it came back to were previously flattened into
 * the message string and thrown away. They are the difference between "this
 * mailbox does not exist" and "our relay credentials are wrong" — see
 * `domain/emailDelivery.classifySmtpReply`, which refuses to blame the
 * recipient for anything that did not come back to RCPT TO.
 */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly stage: SmtpStage = 'connect',
    readonly replyCode: number | null = null,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

/** First token of an SMTP reply as a number, or null if it is not one. */
function replyCodeOf(reply: string): number | null {
  const code = Number.parseInt(reply.slice(0, 3), 10);
  return Number.isFinite(code) && code >= 100 && code < 600 ? code : null;
}

interface Dialogue {
  send(line: string | null): Promise<string>;
  upgradeTls(host: string): Promise<void>;
  end(): void;
}

function openSocket(opts: SmtpOptions): Promise<Dialogue> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const implicitTls = opts.port === 465;

  return new Promise((resolve, reject) => {
    let socket: net.Socket | tls.TLSSocket = implicitTls
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.connect({ host: opts.host, port: opts.port });

    let buffer = '';
    let pending: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // A reply is complete when its last line is "NNN " (space, not dash).
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3}(?: |$)/.test(last)) {
        buffer = '';
        pending?.resolve(lines.join('\n'));
        pending = null;
      }
    };
    /**
     * Give up on the connection, and take the socket with us.
     *
     * The `socket.destroy()` is the load-bearing part. Every path through here
     * that runs *before* the greeting has been read rejects `openSocket`, so
     * `sendSmtp` throws at its `await openSocket(opts)` — above the `try`, which
     * means the `finally { dialogue.end() }` that normally closes the socket
     * never runs. Nothing else held a reference to it either, so the connection
     * stayed open for as long as the peer kept it: an established socket and its
     * file descriptor, leaked per attempt.
     *
     * The two ways to get there are the two an unhealthy mail server produces.
     * A greylisting or blocklisting server accepts the TCP connection and then
     * sits on it, which is the `setTimeout` below firing. A tarpit or an
     * overloaded relay accepts and then never speaks at all. Both are retried by
     * the outbox sweep every EMAIL_RETRY_SCAN_MINUTES, against every failed row,
     * which is exactly the shape that turns one leaked descriptor into all of
     * them.
     */
    const onError = (err: Error) => {
      socket.destroy();
      pending?.reject(err);
      pending = null;
      reject(err);
    };

    /**
     * The server hung up, and this is the only thing that notices.
     *
     * A clean FIN is not an `error`, so nothing rejected the reply we were
     * waiting for — and the inactivity timeout was not the backstop it looks
     * like, because Node clears a socket's timers when the socket closes. The
     * timer that was supposed to bound this had already been cancelled by the
     * very event that made it necessary. `sendSmtp` therefore did not fail
     * slowly on a mid-dialogue hang-up; it never settled at all.
     *
     * Which matters because of who awaits it. `retryFailedEmails` runs under
     * `nonOverlapping` (hooks/emailRetry.ts), so a tick that never returns is
     * not one slow sweep — it is every subsequent sweep declining to start, for
     * the life of the process. One relay dropping one connection stopped email
     * retries on that instance until somebody restarted it.
     *
     * The common case is not a failure at all: plenty of servers close
     * immediately after `QUIT` rather than answering `221`. That one is on the
     * happy path, after the message is already accepted.
     */
    const onClose = () => {
      if (pending) onError(new SmtpError('SMTP connection closed by the server'));
    };

    const attach = () => {
      socket.setTimeout(timeoutMs, () => onError(new SmtpError('SMTP timeout')));
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    };
    attach();

    const dialogue: Dialogue = {
      send(line) {
        return new Promise((res, rej) => {
          pending = { resolve: res, reject: rej };
          if (line !== null) socket.write(`${line}\r\n`);
        });
      },
      upgradeTls(host) {
        return new Promise((res, rej) => {
          socket.removeAllListeners('data');
          socket.removeAllListeners('error');
          // The plaintext socket becomes the TLS socket's transport rather than
          // closing, but it is the same object as far as `close` is concerned:
          // left attached, the handler above would fire against a `pending` that
          // now belongs to the encrypted dialogue.
          socket.removeAllListeners('close');
          const upgraded = tls.connect({ socket, servername: host }, () => res());
          upgraded.on('error', rej);
          socket = upgraded;
          attach();
        });
      },
      end() {
        socket.end();
        socket.destroy();
      },
    };

    // Greeting arrives unprompted; resolve once the socket is ready for it.
    void dialogue.send(null).then(
      (greeting) => {
        if (greeting.startsWith('220')) {
          resolve(dialogue);
          return;
        }
        // A server refusing the connection outright — `554 no service here` from
        // a blocklist, `421 too many connections` from a relay under load. The
        // dialogue is never handed back, so this is the only place that can
        // close the socket it opened; see `onError`.
        dialogue.end();
        reject(new SmtpError(`unexpected greeting: ${greeting}`, 'greeting', replyCodeOf(greeting)));
      },
      // Already destroyed by `onError`, which is the only thing that rejects a
      // pending reply.
      (err) => reject(err),
    );
  });
}

/**
 * The label a stage gets in a failure message — the command it corresponds to,
 * which is what an operator reading `email_outbox.error` is looking for.
 *
 * Derived from the stage rather than from the line being sent. It used to be
 * `line?.split(' ')[0]`, and two of the lines this is called with are the
 * base64 of the SMTP username and the SMTP password: a relay answering
 * anything but 235 to the password produced `SMTP <base64 of the password>
 * failed: 535 …`, which is written to the outbox row and logged. The messages
 * are otherwise unchanged — the same six strings the refusal tests pin.
 */
const STAGE_LABEL: Record<SmtpStage, string> = {
  connect: 'connect',
  greeting: 'greeting',
  ehlo: 'EHLO',
  starttls: 'STARTTLS',
  auth: 'AUTH',
  from: 'MAIL',
  rcpt: 'RCPT',
  data: 'DATA',
  body: 'message',
};

async function expect(
  dialogue: Dialogue,
  line: string | null,
  codes: string[],
  stage: SmtpStage,
): Promise<string> {
  const reply = await dialogue.send(line);
  if (!codes.some((c) => reply.startsWith(c))) {
    throw new SmtpError(
      `SMTP ${STAGE_LABEL[stage]} failed: ${reply.slice(0, 200)}`,
      stage,
      replyCodeOf(reply),
    );
  }
  return reply;
}

export async function sendSmtp(
  opts: SmtpOptions,
  email: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    listUnsubscribe?: ListUnsubscribe;
  },
): Promise<void> {
  const dialogue = await openSocket(opts);
  try {
    let ehlo = await expect(dialogue, 'EHLO n409', ['250'], 'ehlo');
    if (opts.port !== 465 && /STARTTLS/i.test(ehlo)) {
      await expect(dialogue, 'STARTTLS', ['220'], 'starttls');
      await dialogue.upgradeTls(opts.host);
      ehlo = await expect(dialogue, 'EHLO n409', ['250'], 'ehlo');
    }
    if (opts.user && opts.pass) {
      await expect(dialogue, 'AUTH LOGIN', ['334'], 'auth');
      await expect(dialogue, Buffer.from(opts.user, 'utf8').toString('base64'), ['334'], 'auth');
      await expect(dialogue, Buffer.from(opts.pass, 'utf8').toString('base64'), ['235'], 'auth');
    }
    await expect(dialogue, `MAIL FROM:<${bareAddress(opts.from)}>`, ['250'], 'from');
    await expect(dialogue, `RCPT TO:<${bareAddress(email.to)}>`, ['250', '251'], 'rcpt');
    await expect(dialogue, 'DATA', ['354'], 'data');
    const message = buildMimeMessage({
      from: opts.from,
      to: email.to,
      subject: email.subject,
      body: email.body,
      html: email.html,
      listUnsubscribe: email.listUnsubscribe,
      // Nothing this transport sends was typed by a person into a reply box —
      // it is all generated from a template or a workflow transition.
      autoSubmitted: 'auto-generated',
    });
    await expect(dialogue, `${message}.`, ['250'], 'body');
    await dialogue.send('QUIT').catch(() => undefined);
  } finally {
    dialogue.end();
  }
}

export interface SmtpTransportOptions extends SmtpOptions {
  /** Absolute app URL; enables the unsubscribe link and preferences footer. */
  publicBaseUrl?: string;
  /** Signs one-click unsubscribe tokens. Without it, no header is attached. */
  unsubscribeSecret?: string;
  /** White-label sender name shown in the HTML header. */
  brandName?: string;
}

/**
 * `List-Unsubscribe` for a row, or undefined.
 *
 * Three conditions, all required, and each of them is a way to get this wrong:
 * the row has to be a marketing send (migration 0138), it has to name a user
 * the token can be minted for, and the deployment has to have both a public URL
 * for the link to point at and a secret to sign it with. A header pointing at a
 * URL that 404s is worse than no header — the provider records a failed
 * unsubscribe against the domain.
 */
export function unsubscribeFor(
  email: Pick<EmailOutboxRow, 'promotional' | 'to_user_id' | 'channel'>,
  opts: Pick<SmtpTransportOptions, 'publicBaseUrl' | 'unsubscribeSecret' | 'from'>,
): ListUnsubscribe | undefined {
  if (!email.promotional || email.channel !== 'email') return undefined;
  if (!email.to_user_id || !opts.publicBaseUrl || !opts.unsubscribeSecret) return undefined;
  const token = createUnsubscribeToken(
    { userId: email.to_user_id, scope: 'marketing' },
    opts.unsubscribeSecret,
  );
  return {
    url: unsubscribeUrl(opts.publicBaseUrl, token),
    mailto: `mailto:${bareAddress(opts.from)}?subject=unsubscribe`,
    oneClick: true,
  };
}

/** EmailTransport over SMTP — plugs into the existing outbox hook. */
export function smtpTransport(opts: SmtpTransportOptions, log?: FastifyBaseLogger): EmailTransport {
  return {
    async send(email: EmailOutboxRow): Promise<void> {
      const listUnsubscribe = unsubscribeFor(email, opts);
      await sendSmtp(opts, {
        to: email.to_email,
        subject: email.subject,
        body: email.body,
        // The outbox keeps one plain-text body and stays the record of what was
        // sent; the HTML alternative is derived from it here rather than stored,
        // so the two halves of a message can never disagree about its content.
        html: renderHtmlEmail({
          subject: email.subject,
          body: email.body,
          brandName: opts.brandName,
          preferencesUrl: opts.publicBaseUrl
            ? `${opts.publicBaseUrl.replace(/\/+$/, '')}/settings`
            : undefined,
        }),
        listUnsubscribe,
      });
      // `emailId`, not the address. The recipient is on the redact list as
      // `to_email` and was logged here under the key `to`, which pino matches
      // segment by segment against the *key* — so renaming the field at the
      // log site is all it takes to undo the redaction, and every delivered
      // message put a subscriber's address in the clear. The outbox row id
      // answers the same question ("which message") and is not personal data;
      // the address is one join away for anyone entitled to it.
      log?.info({ emailId: email.id, subject: email.subject }, 'email delivered (smtp)');
    },
  };
}
