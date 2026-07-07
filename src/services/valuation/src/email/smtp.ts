import net from 'node:net';
import tls from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailTransport } from '../hooks/stateChange.js';
import type { EmailOutboxRow } from '../repos/emailOutbox.js';

/**
 * Minimal SMTP transport (remaining-gaps §6 P0 #1 — real email delivery).
 *
 * Deliberately dependency-free: EHLO → STARTTLS (or implicit TLS on 465) →
 * AUTH LOGIN → MAIL FROM/RCPT TO/DATA. The outbox keeps delivery state, so a
 * thrown error here just leaves the row 'failed' for a later retry.
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

/** RFC 5322 message with a text body; keeps headers injection-safe. */
export function buildMimeMessage(args: {
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: Date;
}): string {
  // Header values end at the first CR/LF — anything after is an injection.
  const clean = (v: string) => (v.split(/[\r\n]/, 1)[0] ?? '').trim();
  // Non-ASCII subjects go out RFC 2047 base64-encoded.
  const subject = /^[\x20-\x7e]*$/.test(args.subject)
    ? clean(args.subject)
    : `=?utf-8?B?${Buffer.from(args.subject, 'utf8').toString('base64')}?=`;
  const headers = [
    `From: ${clean(args.from)}`,
    `To: ${clean(args.to)}`,
    `Subject: ${subject}`,
    `Date: ${(args.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  // Dot-stuff body lines starting with '.' (RFC 5321 §4.5.2).
  const body = args.body.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** Bare address out of "Display Name <user@host>". */
export function bareAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1]! : from).trim();
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
  email: { to: string; subject: string; body: string },
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
    });
    await expect(dialogue, `${message}.`, ['250']);
    await dialogue.send('QUIT').catch(() => undefined);
  } finally {
    dialogue.end();
  }
}

/** EmailTransport over SMTP — plugs into the existing outbox hook. */
export function smtpTransport(opts: SmtpOptions, log?: FastifyBaseLogger): EmailTransport {
  return {
    async send(email: EmailOutboxRow): Promise<void> {
      await sendSmtp(opts, { to: email.to_email, subject: email.subject, body: email.body });
      log?.info({ to: email.to_email, subject: email.subject }, 'email delivered (smtp)');
    },
  };
}
