import net from 'node:net';
import tls from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import type { EmailOutboxRow } from '../repos/emailOutbox.js';
import { buildMimeMessage, renderHtmlEmail, type ListUnsubscribe } from './mime.js';
import { createUnsubscribeToken, unsubscribeUrl } from '../domain/unsubscribeToken.js';

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

class SmtpError extends Error {}

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
    const onError = (err: Error) => {
      pending?.reject(err);
      pending = null;
      reject(err);
    };

    const attach = () => {
      socket.setTimeout(timeoutMs, () => onError(new SmtpError('SMTP timeout')));
      socket.on('data', onData);
      socket.on('error', onError);
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
        if (!greeting.startsWith('220')) reject(new SmtpError(`unexpected greeting: ${greeting}`));
        else resolve(dialogue);
      },
      (err) => reject(err),
    );
  });
}

async function expect(dialogue: Dialogue, line: string | null, codes: string[]): Promise<string> {
  const reply = await dialogue.send(line);
  if (!codes.some((c) => reply.startsWith(c))) {
    throw new SmtpError(`SMTP ${line?.split(' ')[0] ?? 'reply'} failed: ${reply.slice(0, 200)}`);
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
    let ehlo = await expect(dialogue, 'EHLO n409', ['250']);
    if (opts.port !== 465 && /STARTTLS/i.test(ehlo)) {
      await expect(dialogue, 'STARTTLS', ['220']);
      await dialogue.upgradeTls(opts.host);
      ehlo = await expect(dialogue, 'EHLO n409', ['250']);
    }
    if (opts.user && opts.pass) {
      await expect(dialogue, 'AUTH LOGIN', ['334']);
      await expect(dialogue, Buffer.from(opts.user, 'utf8').toString('base64'), ['334']);
      await expect(dialogue, Buffer.from(opts.pass, 'utf8').toString('base64'), ['235']);
    }
    await expect(dialogue, `MAIL FROM:<${bareAddress(opts.from)}>`, ['250']);
    await expect(dialogue, `RCPT TO:<${bareAddress(email.to)}>`, ['250', '251']);
    await expect(dialogue, 'DATA', ['354']);
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
    await expect(dialogue, `${message}.`, ['250']);
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
      log?.info({ to: email.to_email, subject: email.subject }, 'email delivered (smtp)');
    },
  };
}
