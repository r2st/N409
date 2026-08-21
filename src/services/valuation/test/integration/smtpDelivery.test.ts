import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bareAddress, sendSmtp, SmtpError, smtpTransport, unsubscribeFor } from '../../src/email/smtp.js';
import { classifySmtpReply } from '../../src/domain/emailDelivery.js';
import type { EmailOutboxRow } from '../../src/repos/emailOutbox.js';

/**
 * The SMTP transport, against a socket.
 *
 * This is the last hop of the delivery half of the critical path — every
 * password reset, invitation, email verification, board-approval request and
 * "your report is ready" notification leaves the platform through `sendSmtp`
 * when EMAIL_MODE=smtp, which is what production runs. It had no test of any
 * kind: `mime.ts` is covered (what the server is handed) and the outbox is
 * covered (what is recorded), but the conversation between them — the file that
 * decides whether STARTTLS happens, whether AUTH happens, and what a refusal at
 * each of seven steps does — was never once executed by the suite.
 *
 * So this stands up a real server on loopback and speaks the protocol at it.
 * The fake is deliberately dumb: it replies from a script, one line per step,
 * so a test says what the server did and nothing else. What is being exercised
 * is entirely on our side of the wire.
 */

interface Recorded {
  /** Every line the client sent, in order. */
  lines: string[];
  /** Sockets the server accepted that the client never closed. */
  leaked: () => number;
}

interface ServerOptions {
  /** Replies, in order. A `null` entry means "say nothing at all". */
  script: (string | null)[];
  /** Close the connection instead of sending the reply at this index. */
  hangUpAt?: number;
  /** Send no greeting and never reply — a tarpit. */
  silent?: boolean;
}

const servers: { server: net.Server; open: Set<net.Socket> }[] = [];

/**
 * Tear down without waiting on a leak.
 *
 * `net.Server.close()` waits for every accepted connection to close, so against
 * the pre-fix transport this hook simply never returned: the leaked socket held
 * the server open and the run died on a 60-second hook timeout, one describe
 * block short of the assertions that would have named the problem. Sockets are
 * destroyed from this side first so teardown is always prompt, and the leak is
 * asserted explicitly — in the tests below, by count, before this runs.
 */
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(({ server, open }) => {
      for (const socket of open) socket.destroy();
      return new Promise<void>((res) => server.close(() => res()));
    }),
  );
});

/**
 * A scripted SMTP server on an ephemeral loopback port.
 *
 * Note the greeting is the first entry of `script` and is sent unprompted, which
 * is what makes the client's first `send(null)` — a read with no write — the
 * right shape.
 */
async function fakeServer(options: ServerOptions): Promise<{ port: number } & Recorded> {
  const lines: string[] = [];
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
    if (options.silent) return;

    let step = 0;
    const say = () => {
      if (options.hangUpAt === step) {
        socket.destroy();
        return;
      }
      const reply = options.script[step++];
      if (reply != null) socket.write(`${reply}\r\n`);
    };
    say(); // the greeting

    let buffer = '';
    let inData = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const at = buffer.indexOf('\r\n');
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        // Inside DATA the server stays quiet until the lone `.` terminator, so
        // the message body must not be read as a sequence of commands.
        if (inData) {
          if (line === '.') {
            inData = false;
            say();
          }
          continue;
        }
        lines.push(line);
        if (/^DATA$/i.test(line)) {
          say();
          inData = true;
          continue;
        }
        say();
      }
    });
  });
  servers.push({ server, open });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as net.AddressInfo).port;
  return { port, lines, leaked: () => open.size };
}

/** Long enough not to be flaky, short enough that a timeout test is quick. */
const FAST = 400;

const MESSAGE = { to: 'client@example.com', subject: 'Your 409A is ready', body: 'Sign in to view it.' };

/** The eight-step happy path: greeting, EHLO, MAIL, RCPT, DATA, dot, QUIT. */
const PLAIN_SCRIPT = [
  '220 mail.test ESMTP',
  '250-mail.test\r\n250 SIZE',
  '250 ok',
  '250 ok',
  '354 go',
  '250 queued',
  '221 bye',
];

/**
 * `open.size` settles a tick after the client destroys its end. Waiting for the
 * count rather than sleeping a fixed amount keeps the leak assertions honest
 * without making them slow.
 */
async function settled(leaked: () => number, expected: number): Promise<number> {
  for (let i = 0; i < 50 && leaked() !== expected; i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  return leaked();
}

describe('sendSmtp — the conversation', () => {
  it('walks the full dialogue and hands over the message', async () => {
    const server = await fakeServer({ script: PLAIN_SCRIPT });
    await sendSmtp(
      { host: '127.0.0.1', port: server.port, from: 'N409 <no-reply@n409.local>', timeoutMs: FAST },
      MESSAGE,
    );
    expect(server.lines).toEqual([
      'EHLO n409',
      'MAIL FROM:<no-reply@n409.local>',
      'RCPT TO:<client@example.com>',
      'DATA',
      'QUIT',
    ]);
  });

  it('sends the envelope as bare addresses, not the display-name form', async () => {
    // The header keeps "N409 <no-reply@…>"; the envelope must not — a server
    // reading `MAIL FROM:<N409 <no-reply@…>>` rejects the whole transaction.
    const server = await fakeServer({ script: PLAIN_SCRIPT });
    await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        from: 'N409 Valuations <no-reply@n409.local>',
        timeoutMs: FAST,
      },
      { ...MESSAGE, to: 'Ada Lovelace <ada@example.com>' },
    );
    expect(server.lines[1]).toBe('MAIL FROM:<no-reply@n409.local>');
    expect(server.lines[2]).toBe('RCPT TO:<ada@example.com>');
  });

  it('authenticates only when both a user and a password are configured', async () => {
    const script = [
      '220 mail.test ESMTP',
      '250-mail.test\r\n250 AUTH LOGIN',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '235 authenticated',
      '250 ok',
      '250 ok',
      '354 go',
      '250 queued',
      '221 bye',
    ];
    const server = await fakeServer({ script });
    await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        user: 'postmaster@n409.local',
        pass: 'hunter2',
        from: 'no-reply@n409.local',
        timeoutMs: FAST,
      },
      MESSAGE,
    );
    expect(server.lines.slice(0, 4)).toEqual([
      'EHLO n409',
      'AUTH LOGIN',
      Buffer.from('postmaster@n409.local').toString('base64'),
      Buffer.from('hunter2').toString('base64'),
    ]);
  });

  it('skips AUTH when only half the credential pair is set', async () => {
    // Half a credential is the local-relay case, not an authenticated one.
    // Sending `AUTH LOGIN` anyway earns a 503 from a server that offered no
    // AUTH, which would fail delivery that would otherwise have worked.
    const server = await fakeServer({ script: PLAIN_SCRIPT });
    await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        user: 'postmaster',
        from: 'no-reply@n409.local',
        timeoutMs: FAST,
      },
      MESSAGE,
    );
    expect(server.lines).not.toContain('AUTH LOGIN');
  });

  it('does not offer STARTTLS to a server that did not advertise it', async () => {
    const server = await fakeServer({ script: PLAIN_SCRIPT });
    await sendSmtp(
      { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
      MESSAGE,
    );
    expect(server.lines).not.toContain('STARTTLS');
  });

  it('accepts 251 as well as 250 for a forwarded recipient', async () => {
    // "251 User not local; will forward" is an acceptance. Reading only 250
    // would fail delivery to every address behind a forwarder.
    const script = [...PLAIN_SCRIPT];
    script[3] = '251 User not local; will forward to <ada@elsewhere.example>';
    const server = await fakeServer({ script });
    await expect(
      sendSmtp(
        { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
        MESSAGE,
      ),
    ).resolves.toBeUndefined();
  });

  it('reads a multi-line reply as one reply', async () => {
    // 250-… continuation lines then a final "250 ". Treating the first line as
    // complete would put every later command a reply out of step.
    const script = [...PLAIN_SCRIPT];
    script[1] = '250-mail.test greets you\r\n250-PIPELINING\r\n250-8BITMIME\r\n250 SIZE 35882577';
    const server = await fakeServer({ script });
    await sendSmtp(
      { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
      MESSAGE,
    );
    expect(server.lines[1]).toBe('MAIL FROM:<no-reply@n409.local>');
  });
});

describe('sendSmtp — the refusals', () => {
  const dial = (port: number) =>
    sendSmtp({ host: '127.0.0.1', port, from: 'no-reply@n409.local', timeoutMs: FAST }, MESSAGE);

  it.each([
    ['greeting', 0, '554 no service here', /unexpected greeting/],
    ['EHLO', 1, '502 command not implemented', /EHLO failed/],
    ['MAIL FROM', 2, '550 sender rejected', /MAIL failed/],
    ['RCPT TO', 3, '550 no such user', /RCPT failed/],
    ['DATA', 4, '552 too big', /DATA failed/],
    ['the terminating dot', 5, '451 try later', /failed/],
  ])('reports a refusal at %s', async (_step, index, reply, expected) => {
    const script = [...PLAIN_SCRIPT];
    script[index] = reply;
    const server = await fakeServer({ script });
    await expect(dial(server.port)).rejects.toThrow(expected);
  });

  it('quotes the server, so the outbox failure says why', async () => {
    // The row is left 'failed' with this text on it; it is what somebody reads
    // when they ask why a client never got their report.
    const script = [...PLAIN_SCRIPT];
    script[3] = '550 5.1.1 <client@example.com>: Recipient address rejected';
    const server = await fakeServer({ script });
    await expect(dial(server.port)).rejects.toThrow(/Recipient address rejected/);
  });

  /**
   * The failure text is written to `email_outbox.error` and logged. Two of the
   * lines this transport sends are the base64 of the SMTP username and
   * password, and the message used to be built from the line — so a relay
   * answering anything but 235 to the password put the credential, trivially
   * decodable, into a database column and the log stream. A wrong SMTP password
   * is a common misconfiguration, so this was reachable by accident rather than
   * by attack.
   */
  it('never puts the SMTP credential in the failure message', async () => {
    const script = [
      '220 mail.test ESMTP',
      '250-mail.test\r\n250 AUTH LOGIN',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '535 5.7.8 authentication failed',
    ];
    const server = await fakeServer({ script });
    const pass = 'hunter2-the-real-password';
    const encoded = Buffer.from(pass).toString('base64');

    const err = await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        user: 'postmaster@n409.local',
        pass,
        from: 'no-reply@n409.local',
        timeoutMs: FAST,
      },
      MESSAGE,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message}`;
    expect(text).not.toContain(encoded);
    expect(text).not.toContain(pass);
    expect(text).not.toContain(Buffer.from('postmaster@n409.local').toString('base64'));
    // Still says what failed and what the server said.
    expect(text).toMatch(/AUTH failed/);
    expect(text).toMatch(/authentication failed/);
  });

  /**
   * The stage and the reply code are what `classifySmtpReply` reads. Without
   * them a 550 at RCPT TO — a dead mailbox, knowable immediately — is
   * indistinguishable from a 535 at AUTH, and the retry ladder spends six
   * attempts over eight hours on each.
   */
  it('carries the stage and reply code so a refusal can be classified', async () => {
    const script = [...PLAIN_SCRIPT];
    script[3] = '550 5.1.1 <client@example.com>: Recipient address rejected';
    const server = await fakeServer({ script });
    const err = (await dial(server.port).catch((e: unknown) => e)) as SmtpError;
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.stage).toBe('rcpt');
    expect(err.replyCode).toBe(550);
    expect(classifySmtpReply(err.stage, err.replyCode)).toBe('hard');
  });

  it('classifies an auth failure as ours, never as the recipient’s', async () => {
    const script = [
      '220 mail.test ESMTP',
      '250-mail.test\r\n250 AUTH LOGIN',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '535 5.7.8 authentication failed',
    ];
    const server = await fakeServer({ script });
    const err = (await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        user: 'u',
        pass: 'p',
        from: 'no-reply@n409.local',
        timeoutMs: FAST,
      },
      MESSAGE,
    ).catch((e: unknown) => e)) as SmtpError;
    expect(err.stage).toBe('auth');
    expect(err.replyCode).toBe(535);
    // Soft, so the address is not suppressed for our own misconfiguration.
    expect(classifySmtpReply(err.stage, err.replyCode)).toBe('soft');
  });

  it('fails rather than hanging when the server never speaks', async () => {
    const server = await fakeServer({ script: [], silent: true });
    await expect(dial(server.port)).rejects.toThrow(/timeout/i);
  });

  it('fails at once when the server hangs up mid-dialogue', async () => {
    // Not "fails slowly" — before the `close` handler this never settled at
    // all. A clean FIN is not an `error`, and the inactivity timeout was no
    // backstop: Node clears a socket's timers when the socket closes, so the
    // timer meant to bound this was cancelled by the event that needed it.
    //
    // `retryFailedEmails` awaits this under `nonOverlapping`, so a promise that
    // never resolves is every later sweep declining to start — email retries
    // stopped on that instance until a restart.
    const server = await fakeServer({ script: PLAIN_SCRIPT, hangUpAt: 2 });
    const started = Date.now();
    await expect(dial(server.port)).rejects.toThrow(/closed by the server/);
    expect(Date.now() - started).toBeLessThan(FAST);
  });

  it('fails when nothing is listening', async () => {
    // Bind a port, learn it, give it back — the reliable way to name a port
    // nothing is on. SMTP_HOST pointing at a relay that has moved is the case.
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', res));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((res) => probe.close(() => res()));
    await expect(
      sendSmtp({ host: '127.0.0.1', port, from: 'no-reply@n409.local', timeoutMs: FAST }, MESSAGE),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

/**
 * Every failure above happens against a server the outbox sweep will dial again
 * in EMAIL_RETRY_SCAN_MINUTES, for every failed row. A connection left open per
 * attempt is therefore not a slow leak — it is one descriptor per undeliverable
 * message per sweep, on the service that also holds the database pool.
 */
describe('sendSmtp — the socket', () => {
  it('closes the connection after a successful send', async () => {
    const server = await fakeServer({ script: PLAIN_SCRIPT });
    await sendSmtp(
      { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
      MESSAGE,
    );
    expect(await settled(server.leaked, 0)).toBe(0);
  });

  it('closes the connection when the greeting refuses us', async () => {
    // The leak this file was written for. `openSocket` rejects, so `sendSmtp`
    // throws above its own `try` and the `finally { dialogue.end() }` never runs.
    const server = await fakeServer({ script: ['421 too many connections'] });
    await expect(
      sendSmtp(
        { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
        MESSAGE,
      ),
    ).rejects.toThrow(/unexpected greeting/);
    expect(await settled(server.leaked, 0)).toBe(0);
  });

  it('closes the connection when the server accepts it and then says nothing', async () => {
    // The other half: a greylisting or tarpitting server, where the reject comes
    // from the inactivity timeout rather than from a reply.
    const server = await fakeServer({ script: [], silent: true });
    await expect(
      sendSmtp(
        { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
        MESSAGE,
      ),
    ).rejects.toThrow(/timeout/i);
    expect(await settled(server.leaked, 0)).toBe(0);
  });

  it('closes the connection when a command is refused mid-dialogue', async () => {
    const script = [...PLAIN_SCRIPT];
    script[3] = '550 no such user';
    const server = await fakeServer({ script });
    await expect(
      sendSmtp(
        { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
        MESSAGE,
      ),
    ).rejects.toThrow(/RCPT failed/);
    expect(await settled(server.leaked, 0)).toBe(0);
  });

  it('leaks nothing across a run of failures', async () => {
    const server = await fakeServer({ script: ['554 no service here'] });
    for (let i = 0; i < 5; i++) {
      await expect(
        sendSmtp(
          { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
          MESSAGE,
        ),
      ).rejects.toThrow();
    }
    expect(await settled(server.leaked, 0)).toBe(0);
  });

  it('does not wait out the timeout when the server closes instead of answering QUIT', async () => {
    // Plenty of servers do. The message is already accepted at that point, so
    // this was pure latency — one full timeout per delivered message.
    const server = await fakeServer({ script: PLAIN_SCRIPT, hangUpAt: 6 });
    const started = Date.now();
    await sendSmtp(
      { host: '127.0.0.1', port: server.port, from: 'no-reply@n409.local', timeoutMs: FAST },
      MESSAGE,
    );
    expect(Date.now() - started).toBeLessThan(FAST);
  });
});

describe('the message the server is handed', () => {
  /** The DATA payload, recovered from the fake server. */
  async function captureBody(
    email: Parameters<typeof sendSmtp>[1],
    opts: Partial<Parameters<typeof sendSmtp>[0]> = {},
  ): Promise<string> {
    let body = '';
    const open = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      const script = [...PLAIN_SCRIPT];
      let step = 0;
      let inData = false;
      let buffer = '';
      socket.on('error', () => undefined);
      socket.write(`${script[step++]}\r\n`);
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const at = buffer.indexOf('\r\n');
          if (at < 0) break;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write(`${script[step++]}\r\n`);
            } else body += `${line}\n`;
            continue;
          }
          socket.write(`${script[step++]}\r\n`);
          if (/^DATA$/i.test(line)) inData = true;
        }
      });
    });
    servers.push({ server, open });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as net.AddressInfo).port;
    await sendSmtp(
      { host: '127.0.0.1', port, from: 'N409 <no-reply@n409.local>', timeoutMs: FAST, ...opts },
      email,
    );
    return body;
  }

  it('carries the headers the transport is responsible for', async () => {
    const body = await captureBody(MESSAGE);
    expect(body).toContain('To: client@example.com');
    expect(body).toContain('Subject: Your 409A is ready');
    // Nothing this transport sends was typed by a person into a reply box.
    expect(body).toContain('Auto-Submitted: auto-generated');
  });

  it('carries the List-Unsubscribe header when one was built', async () => {
    const body = await captureBody({
      ...MESSAGE,
      listUnsubscribe: {
        url: 'https://app.example.com/u/tok',
        mailto: 'mailto:no-reply@n409.local',
        oneClick: true,
      },
    });
    expect(body).toContain('https://app.example.com/u/tok');
    expect(body).toContain('List-Unsubscribe-Post');
  });
});

describe('bareAddress', () => {
  it('takes the address out of a display-name form', () => {
    expect(bareAddress('N409 Valuations <no-reply@n409.local>')).toBe('no-reply@n409.local');
  });

  it('passes a plain address through', () => {
    expect(bareAddress('  ada@example.com  ')).toBe('ada@example.com');
  });

  it('strips CR/LF, which would otherwise be SMTP command injection', () => {
    // A newline that survived into `MAIL FROM:<…>` is a second command, not an
    // address. Nothing attacker-shaped reaches here — every route that writes an
    // outbox row parses the address through `z.string().email()` first, which
    // admits neither a newline nor an angle bracket — but this is the layer
    // that would have to hold if one ever did.
    expect(bareAddress('x@y.test\r\nRCPT TO: attacker@evil.test')).toBe(
      'x@y.testRCPT TO: attacker@evil.test',
    );
    expect(bareAddress('<x@y.test\nDATA>')).toBe('x@y.testDATA');
  });

  it('reads the angle-bracket form first, wherever it appears', () => {
    // Worth pinning because it is the surprising half of the rule: the bracket
    // match runs before the newline strip, so the bracketed address wins even
    // when something precedes it. That is right for `Ada Lovelace <ada@x>` and
    // it is why the `.email()` parse upstream is the guard that matters.
    expect(bareAddress('Ada Lovelace <ada@example.com>')).toBe('ada@example.com');
    expect(bareAddress('x@y.test\r\nRCPT TO:<attacker@evil.test>')).toBe('attacker@evil.test');
  });
});

describe('smtpTransport', () => {
  const row = (over: Partial<EmailOutboxRow> = {}): EmailOutboxRow =>
    ({
      to_email: 'client@example.com',
      subject: 'Your 409A is ready',
      body: 'Sign in to view it.',
      promotional: false,
      channel: 'email',
      to_user_id: null,
      ...over,
    }) as EmailOutboxRow;

  it('delivers an outbox row and logs it', async () => {
    const server = await fakeServer({ script: PLAIN_SCRIPT });
    const logged: unknown[] = [];
    const transport = smtpTransport(
      { host: '127.0.0.1', port: server.port, from: 'N409 <no-reply@n409.local>', timeoutMs: FAST },
      { info: (obj: unknown) => logged.push(obj) } as never,
    );
    await transport.send(row());
    expect(server.lines).toContain('RCPT TO:<client@example.com>');
    expect(logged).toHaveLength(1);
  });

  it('lets a transport failure through, so the outbox row is left failed for retry', async () => {
    // The row's delivery state is the outbox's business; swallowing here would
    // record a message as sent that no server ever accepted.
    const script = [...PLAIN_SCRIPT];
    script[3] = '550 no such user';
    const server = await fakeServer({ script });
    const transport = smtpTransport({
      host: '127.0.0.1',
      port: server.port,
      from: 'no-reply@n409.local',
      timeoutMs: FAST,
    });
    await expect(transport.send(row())).rejects.toThrow(/RCPT failed/);
  });

  it('attaches List-Unsubscribe to a marketing send with everything it needs', async () => {
    const opts = {
      host: '127.0.0.1',
      port: 0,
      from: 'N409 <no-reply@n409.local>',
      publicBaseUrl: 'https://app.example.com',
      unsubscribeSecret: 'a-secret-long-enough-to-sign-with',
    };
    expect(unsubscribeFor(row({ promotional: true, to_user_id: 'u1' }), opts)).toMatchObject({
      oneClick: true,
      mailto: 'mailto:no-reply@n409.local?subject=unsubscribe',
    });
  });

  it.each([
    ['a transactional send', { promotional: false, to_user_id: 'u1' }],
    ['a send with no user to mint a token for', { promotional: true, to_user_id: null }],
    ['an SMS row', { promotional: true, to_user_id: 'u1', channel: 'sms' as const }],
  ])('attaches no List-Unsubscribe to %s', (_name, over) => {
    // A header pointing at a URL that 404s is worse than no header — the
    // provider records a failed unsubscribe against the domain.
    expect(
      unsubscribeFor(row(over), {
        from: 'no-reply@n409.local',
        publicBaseUrl: 'https://app.example.com',
        unsubscribeSecret: 'a-secret-long-enough-to-sign-with',
      }),
    ).toBeUndefined();
  });

  it('attaches no List-Unsubscribe when the deployment cannot sign or address one', () => {
    const marketing = row({ promotional: true, to_user_id: 'u1' });
    expect(
      unsubscribeFor(marketing, { from: 'no-reply@n409.local', unsubscribeSecret: 'x'.repeat(32) }),
    ).toBeUndefined();
    expect(
      unsubscribeFor(marketing, { from: 'no-reply@n409.local', publicBaseUrl: 'https://app.example.com' }),
    ).toBeUndefined();
  });
});
