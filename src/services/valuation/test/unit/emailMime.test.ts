import { describe, expect, it } from 'vitest';
import {
  buildMimeMessage,
  encodeHeaderWords,
  encodeQuotedPrintable,
  escapeHtml,
  foldHeader,
  messageIdDomain,
  renderHtmlEmail,
  textToHtml,
} from '../../src/email/mime.js';
import { unsubscribeFor } from '../../src/email/smtp.js';
import type { EmailOutboxRow } from '../../src/repos/emailOutbox.js';

const FROM = 'N409 Valuations <no-reply@n409.app>';

/**
 * Header block only — everything before the blank line that starts the body,
 * with folds undone so an assertion reads the value a parser would see rather
 * than the line breaks the wire happens to carry.
 */
function headersOf(message: string): string {
  return message.split('\r\n\r\n', 1)[0]!.replace(/\r\n[ \t]+/g, ' ');
}

/**
 * Decode an RFC 2047 header value back to the text a client displays.
 *
 * Adjacent encoded words are joined with the whitespace between them dropped,
 * which is what the spec requires of a decoder and the reason the encoder may
 * split a value at all. Bare (unencoded) runs are kept verbatim.
 */
function decodeHeaderWords(value: string): string {
  return value.replace(/(?:=\?utf-8\?B\?[^?]*\?=)(?:\s+=\?utf-8\?B\?[^?]*\?=)*/gi, (run) =>
    [...run.matchAll(/=\?utf-8\?B\?([^?]*)\?=/gi)]
      .map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'))
      .join(''),
  );
}

describe('quoted-printable', () => {
  it('leaves plain ASCII alone', () => {
    expect(encodeQuotedPrintable('Your draft is ready.')).toBe('Your draft is ready.');
  });

  it('encodes non-ASCII as UTF-8 bytes', () => {
    // é is C3 A9 in UTF-8; both bytes are encoded, in order.
    expect(encodeQuotedPrintable('Société')).toBe('Soci=C3=A9t=C3=A9');
  });

  it('encodes "=" so a decoder cannot mistake it for an escape', () => {
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db');
  });

  it('encodes trailing whitespace, which relays would otherwise strip', () => {
    expect(encodeQuotedPrintable('trailing ')).toBe('trailing=20');
    expect(encodeQuotedPrintable('mid space here')).toBe('mid space here');
  });

  it('encodes a leading dot, so no body line can end DATA', () => {
    expect(encodeQuotedPrintable('.hidden')).toBe('=2Ehidden');
  });

  it('soft-breaks long lines inside the 76-character maximum', () => {
    const encoded = encodeQuotedPrintable('x'.repeat(200));
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(encoded).toContain('=\r\n');
    // A soft break is invisible to the decoder: strip them and the text is back.
    expect(encoded.replace(/=\r\n/g, '')).toBe('x'.repeat(200));
  });

  it('keeps hard line breaks as CRLF', () => {
    expect(encodeQuotedPrintable('one\ntwo')).toBe('one\r\ntwo');
  });
});

describe('header encoding', () => {
  it('leaves an ASCII subject unencoded', () => {
    expect(encodeHeaderWords('Your draft is ready')).toBe('Your draft is ready');
  });

  it('splits a long non-ASCII subject into several ≤75-char encoded words', () => {
    const encoded = encodeHeaderWords(`Société Générale — ${'votre rapport 409A est prêt '.repeat(4)}`);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.startsWith('=?utf-8?B?')).toBe(true);
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character across two encoded words', () => {
    const subject = '評価レポートの準備ができました'.repeat(6);
    const decoded = encodeHeaderWords(subject)
      .split('\r\n ')
      .map((word) => Buffer.from(word.slice('=?utf-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
  });

  it('folds a long header at whitespace only', () => {
    const folded = foldHeader(
      'List-Unsubscribe',
      `<https://n409.app/a> , <mailto:${'x'.repeat(40)}@n409.app>`,
    );
    for (const line of folded.split('\r\n')) {
      expect(line.length).toBeLessThan(998);
    }
    expect(folded.startsWith('List-Unsubscribe:')).toBe(true);
  });

  it('leaves a short header on one line', () => {
    expect(foldHeader('Subject', 'Hello')).toBe('Subject: Hello');
  });
});

describe('Message-ID', () => {
  it('takes the domain from the envelope sender', () => {
    expect(messageIdDomain(FROM)).toBe('n409.app');
    expect(messageIdDomain('ops@example.test')).toBe('example.test');
  });

  it('falls back to an obviously local domain rather than inventing one', () => {
    expect(messageIdDomain('not-an-address')).toBe('n409.invalid');
  });

  it('is present on every message and syntactically addr-spec shaped', () => {
    const msg = buildMimeMessage({ from: FROM, to: 'a@b.test', subject: 'Hi', body: 'x' });
    expect(headersOf(msg)).toMatch(/Message-ID: <[^@<>\s]+@n409\.app>/);
  });

  it('is unique per message', () => {
    const ids = new Set(
      Array.from(
        { length: 5 },
        () =>
          /Message-ID: (<[^>]+>)/.exec(
            buildMimeMessage({ from: FROM, to: 'a@b.test', subject: 's', body: 'b' }),
          )?.[1],
      ),
    );
    expect(ids.size).toBe(5);
  });
});

describe('MIME assembly', () => {
  it('sends text/plain quoted-printable when there is no HTML part', () => {
    const msg = buildMimeMessage({ from: FROM, to: 'a@b.test', subject: 'Hi', body: 'Hello\nWorld' });
    const headers = headersOf(msg);
    expect(headers).toContain('Content-Type: text/plain; charset=utf-8');
    expect(headers).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(headers).not.toContain('8bit');
    expect(msg).toContain('Hello\r\nWorld');
  });

  it('builds multipart/alternative with the HTML part LAST', () => {
    const msg = buildMimeMessage({
      from: FROM,
      to: 'a@b.test',
      subject: 'Hi',
      body: 'plain body',
      html: '<p>rich body</p>',
      boundary: 'BOUND',
    });
    expect(headersOf(msg)).toContain('Content-Type: multipart/alternative; boundary="BOUND"');
    // RFC 2046: the last renderable part wins, so text must precede HTML.
    expect(msg.indexOf('text/plain')).toBeLessThan(msg.indexOf('text/html'));
    expect(msg).toContain('plain body');
    expect(msg).toContain('rich body');
    expect(msg.trimEnd().endsWith('--BOUND--')).toBe(true);
  });

  it('attaches List-Unsubscribe and the one-click POST directive together', () => {
    const headers = headersOf(
      buildMimeMessage({
        from: FROM,
        to: 'a@b.test',
        subject: 'Renewal',
        body: 'x',
        listUnsubscribe: {
          url: 'https://n409.app/api/v1/unsubscribe?token=abc',
          mailto: 'mailto:no-reply@n409.app?subject=unsubscribe',
          oneClick: true,
        },
      }),
    );
    expect(headers).toContain(
      'List-Unsubscribe: <https://n409.app/api/v1/unsubscribe?token=abc>, <mailto:no-reply@n409.app?subject=unsubscribe>',
    );
    expect(headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('omits the one-click directive when the URL does not accept POST', () => {
    const headers = headersOf(
      buildMimeMessage({
        from: FROM,
        to: 'a@b.test',
        subject: 's',
        body: 'x',
        listUnsubscribe: { url: 'https://n409.app/settings' },
      }),
    );
    expect(headers).toContain('List-Unsubscribe: <https://n409.app/settings>');
    expect(headers).not.toContain('List-Unsubscribe-Post');
  });

  it('marks machine-sent mail so mailboxes do not auto-reply to it', () => {
    const headers = headersOf(
      buildMimeMessage({
        from: FROM,
        to: 'a@b.test',
        subject: 's',
        body: 'x',
        autoSubmitted: 'auto-generated',
      }),
    );
    expect(headers).toContain('Auto-Submitted: auto-generated');
    expect(headers).toContain('X-Auto-Response-Suppress: All');
  });

  it('strips header injection out of every header it accepts', () => {
    const msg = buildMimeMessage({
      from: FROM,
      to: 'x@y.test\r\nBcc: evil@example.com',
      subject: 'Hi\r\nX-Injected: 1',
      body: '',
      replyTo: 'ops@n409.app\r\nCc: also-evil@example.com',
      listUnsubscribe: { url: 'https://n409.app/u\r\nX-Bad: 1' },
    });
    expect(msg).not.toContain('Bcc:');
    expect(msg).not.toContain('X-Injected');
    expect(msg).not.toContain('Cc:');
    expect(msg).not.toContain('X-Bad');
  });

  /**
   * The sanitizer keeps the first line only, and the encoder separates encoded
   * words with a fold. Composed encode-then-sanitize, the fold reads as the end
   * of the value — so these assert on the decoded header, which is what a mail
   * client actually shows, rather than on the wire bytes.
   */
  it('keeps the whole address when a non-ASCII sender spans several encoded words', () => {
    const from = '"N409 Bewertungen für Beteiligungsgesellschaften" <no-reply@n409.app>';
    const headers = headersOf(buildMimeMessage({ from, to: 'a@b.test', subject: 's', body: '' }));
    const value = /^From: (.*)$/m.exec(headers)?.[1] ?? '';
    // More than one word, or the case this guards against cannot arise.
    expect(value.split(' ').length).toBeGreaterThan(1);
    expect(decodeHeaderWords(value)).toBe(from);
    // The mailbox is the half that used to be dropped.
    expect(decodeHeaderWords(value)).toContain('<no-reply@n409.app>');
  });

  it('keeps the whole address for a non-ASCII recipient and reply-to', () => {
    const to = '"Zoë Müller-Lüdenscheidt (Finanzabteilung)" <zoe@example.test>';
    const replyTo = '"Betreuung für Beteiligungsgesellschaften" <ops@n409.app>';
    const headers = headersOf(buildMimeMessage({ from: FROM, to, subject: 's', body: '', replyTo }));
    expect(decodeHeaderWords(/^To: (.*)$/m.exec(headers)?.[1] ?? '')).toBe(to);
    expect(decodeHeaderWords(/^Reply-To: (.*)$/m.exec(headers)?.[1] ?? '')).toBe(replyTo);
  });

  /**
   * The reorder must not buy header integrity at the cost of injection safety:
   * a CRLF in a value that is *also* non-ASCII is the case that exercises both
   * halves, and it is the one an attacker would reach for now that a bare CRLF
   * no longer truncates.
   */
  it('still strips injection from a non-ASCII header value', () => {
    const msg = buildMimeMessage({
      from: FROM,
      to: '"Zoë Müller für Beteiligungen" <z@y.test>\r\nBcc: evil@example.com',
      subject: 'Société Générale — rapport prêt\r\nX-Injected: 1',
      body: '',
      replyTo: '"Betreuung für Kunden" <ops@n409.app>\r\nCc: also-evil@example.com',
    });
    expect(msg).not.toContain('Bcc:');
    expect(msg).not.toContain('X-Injected');
    expect(msg).not.toContain('Cc:');
    expect(msg).not.toContain('evil@example.com');
    // And the surviving values are the pre-CRLF halves, intact rather than cut
    // at the encoder's fold.
    const headers = headersOf(msg);
    expect(decodeHeaderWords(/^To: (.*)$/m.exec(headers)?.[1] ?? '')).toBe(
      '"Zoë Müller für Beteiligungen" <z@y.test>',
    );
    expect(decodeHeaderWords(/^Subject: (.*)$/m.exec(headers)?.[1] ?? '')).toBe(
      'Société Générale — rapport prêt',
    );
  });

  it('keeps every line inside the RFC 5321 998-octet limit', () => {
    const msg = buildMimeMessage({
      from: FROM,
      to: 'a@b.test',
      subject: 'Long link',
      body: `See https://n409.app/valuations/${'x'.repeat(1500)}`,
      html: `<a href="https://n409.app/${'y'.repeat(1500)}">link</a>`,
    });
    for (const line of msg.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('never emits a body line beginning with a bare dot', () => {
    const msg = buildMimeMessage({ from: FROM, to: 'a@b.test', subject: 's', body: '.\n.stop' });
    for (const line of msg.split('\r\n')) {
      expect(line.startsWith('.') && !line.startsWith('..')).toBe(false);
    }
  });
});

describe('HTML rendering', () => {
  it('escapes everything the body could smuggle in', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    const html = textToHtml('Company <script>alert(1)</script> & Co');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp; Co');
  });

  it('makes paragraphs of blank-line-separated blocks and <br> of single breaks', () => {
    const html = textToHtml('One\nstill one\n\nTwo');
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).toContain('One<br>still one');
  });

  it('links bare URLs without mangling their query strings', () => {
    const html = textToHtml('Open https://n409.app/v/1?a=1&b=2 to review.');
    expect(html).toContain('href="https://n409.app/v/1?a=1&amp;b=2"');
    // Escaped once, not twice — &amp;amp; in an href points somewhere else.
    expect(html).not.toContain('&amp;amp;');
  });

  it('leaves sentence punctuation outside the link', () => {
    const html = textToHtml('See https://n409.app/x.');
    expect(html).toContain('href="https://n409.app/x"');
    expect(html).toContain('</a>.');
  });

  it('renders a self-contained document with no network requests', () => {
    const html = renderHtmlEmail({
      subject: 'Your draft is ready',
      body: 'The draft 409A for Acme is ready to review.',
      brandName: 'Acme Advisors',
      preferencesUrl: 'https://n409.app/settings',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Acme Advisors');
    expect(html).toContain('Your draft is ready');
    expect(html).toContain('https://n409.app/settings');
    // No remote asset can be blocked, and none can report that it was opened.
    expect(html).not.toMatch(/<img|<script|<link|@import/);
  });

  it('escapes a white-label brand name rather than trusting it', () => {
    const html = renderHtmlEmail({ subject: 's', body: 'b', brandName: '<img src=x onerror=1>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('omits the preferences link entirely when there is nowhere to point it', () => {
    expect(renderHtmlEmail({ subject: 's', body: 'b' })).not.toContain('Manage email preferences');
  });
});

describe('unsubscribeFor', () => {
  const row = (over: Partial<EmailOutboxRow> = {}): EmailOutboxRow =>
    ({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      valuation_id: null,
      to_user_id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      to_email: 'client@example.test',
      channel: 'email',
      template_key: 'renewal',
      subject: 's',
      body: 'b',
      promotional: true,
      status: 'queued',
      error: null,
      attempts: 0,
      created_at: new Date(),
      sent_at: null,
      claimed_at: null,
      ...over,
    }) as EmailOutboxRow;

  const opts = { publicBaseUrl: 'https://n409.app', unsubscribeSecret: 'x'.repeat(32), from: FROM };

  it('offers a signed one-click URL for a marketing send', () => {
    const result = unsubscribeFor(row(), opts);
    expect(result?.oneClick).toBe(true);
    expect(result?.url).toMatch(/^https:\/\/n409\.app\/api\/v1\/unsubscribe\?token=/);
    expect(result?.mailto).toContain('no-reply@n409.app');
  });

  it('never attaches one to transactional mail — a client must keep hearing about their own valuation', () => {
    expect(unsubscribeFor(row({ promotional: false }), opts)).toBeUndefined();
  });

  it('withholds it when there is no user to unsubscribe, or nothing to sign with', () => {
    expect(unsubscribeFor(row({ to_user_id: null }), opts)).toBeUndefined();
    expect(unsubscribeFor(row(), { ...opts, unsubscribeSecret: undefined })).toBeUndefined();
    expect(unsubscribeFor(row(), { ...opts, publicBaseUrl: undefined })).toBeUndefined();
  });

  it('does not attach a mail header to an SMS row', () => {
    expect(unsubscribeFor(row({ channel: 'sms' }), opts)).toBeUndefined();
  });
});
