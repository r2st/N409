import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareAddress, buildMimeMessage, sendSmtp } from '../../src/email/smtp.js';

describe('MIME message builder', () => {
  it('builds an RFC 5322 message with CRLF endings', () => {
    const msg = buildMimeMessage({
      from: 'N409 <no-reply@n409.local>',
      to: 'client@example.com',
      subject: 'Your draft is ready',
      body: 'Hello\nWorld',
      date: new Date('2026-07-07T00:00:00Z'),
    });
    expect(msg).toContain('From: N409 <no-reply@n409.local>\r\n');
    expect(msg).toContain('Subject: Your draft is ready\r\n');
    expect(msg).toContain('Content-Type: text/plain; charset=utf-8');
    expect(msg).toContain('Hello\r\nWorld');
  });

  it('strips header injection attempts', () => {
    const msg = buildMimeMessage({
      from: 'a@b.c',
      to: 'x@y.z\r\nBcc: evil@example.com',
      subject: 'Hi\r\nX-Injected: 1',
      body: '',
    });
    expect(msg).not.toContain('Bcc:');
    expect(msg).not.toContain('X-Injected');
  });

  it('encodes non-ASCII subjects (RFC 2047) and dot-stuffs the body', () => {
    const msg = buildMimeMessage({ from: 'a@b.c', to: 'x@y.z', subject: 'héllo', body: '.hidden\n..more' });
    expect(msg).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(msg).toContain('\r\n..hidden');
    expect(msg).toContain('\r\n...more');
  });

  it('extracts the bare address from a display-name form', () => {
    expect(bareAddress('N409 Valuations <no-reply@n409.local>')).toBe('no-reply@n409.local');
    expect(bareAddress('plain@host.tld')).toBe('plain@host.tld');
  });
});

describe('SMTP client against a fake server', () => {
  interface Exchange {
    commands: string[];
    data: string;
  }
  const exchange: Exchange = { commands: [], data: '' };
  let server: net.Server;
  let port = 0;

  beforeAll(async () => {
    server = net.createServer((socket) => {
      socket.write('220 fake ESMTP\r\n');
      let inData = false;
      // 0 = not authenticating, 1 = expect username, 2 = expect password
      let authStep = 0;
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 queued\r\n');
            } else {
              exchange.data += `${line}\n`;
            }
            continue;
          }
          exchange.commands.push(line);
          if (authStep === 1) {
            authStep = 2;
            socket.write('334 UGFzc3dvcmQ6\r\n');
            continue;
          }
          if (authStep === 2) {
            authStep = 0;
            socket.write('235 authed\r\n');
            continue;
          }
          const verb = line.split(' ')[0]?.toUpperCase();
          if (verb === 'EHLO') socket.write('250-fake\r\n250 AUTH LOGIN PLAIN\r\n');
          else if (verb === 'AUTH') {
            authStep = 1;
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 ok\r\n');
          else if (verb === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          } else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('authenticates, sends the message, and dot-terminates DATA', async () => {
    await sendSmtp(
      {
        host: '127.0.0.1',
        port,
        user: 'mailer',
        pass: 'secret',
        from: 'N409 <no-reply@n409.local>',
        timeoutMs: 5000,
      },
      { to: 'client@example.com', subject: 'Test delivery', body: 'Line one\nLine two' },
    );

    expect(exchange.commands[0]).toMatch(/^EHLO/);
    expect(exchange.commands).toContain('AUTH LOGIN');
    expect(exchange.commands).toContain(Buffer.from('mailer').toString('base64'));
    expect(exchange.commands).toContain(Buffer.from('secret').toString('base64'));
    expect(exchange.commands).toContain('MAIL FROM:<no-reply@n409.local>');
    expect(exchange.commands).toContain('RCPT TO:<client@example.com>');
    expect(exchange.data).toContain('Subject: Test delivery');
    expect(exchange.data).toContain('Line one');
  });
});
