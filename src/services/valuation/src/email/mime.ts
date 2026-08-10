import { newUlid } from '@n409/shared';

/**
 * Message construction for outgoing mail: MIME assembly, and the HTML half of
 * every message.
 *
 * The outbox stores one plain-text body per row and that stays true — it is
 * what the ops screen shows and what a support reply quotes. What was missing
 * is everything a receiving mail server looks at *around* that text, and the
 * absence of it is why perfectly ordinary notifications land in spam:
 *
 *   * **No `Message-ID`.** Every large receiver treats a missing one as a
 *     bulk-sender signal, and without it a client's mail app threads two
 *     unrelated notifications together — or files a resend as a duplicate of
 *     nothing. It is also the only handle support has when a client says "I
 *     never got it" and the log says it was delivered.
 *   * **No HTML part.** A 409A draft-ready notice arriving as unstyled
 *     monospace reads as a phishing attempt of the exact kind finance teams are
 *     trained to report. `multipart/alternative` keeps the text body as the
 *     fallback, so nothing is lost for a text-only reader.
 *   * **No `List-Unsubscribe`.** Since 2024 the large mailbox providers require
 *     it, with one-click POST, on bulk mail — and a promotional campaign
 *     carrying only a footer link does not satisfy it. See `routes/unsubscribe`.
 *   * **`Content-Transfer-Encoding: 8bit` unconditionally.** 8bit is only legal
 *     when the server advertises 8BITMIME, and it is not negotiated anywhere in
 *     this codebase. A non-ASCII company name — an accent, a Japanese
 *     subsidiary — went out as a body the relay was entitled to mangle.
 *     Quoted-printable is 7-bit clean and needs no negotiation.
 *   * **No line-length ceiling.** RFC 5321 caps a line at 998 octets. One long
 *     pasted URL in an analyst's message exceeded it and the relay was within
 *     its rights to fold it wherever it liked, which usually means through the
 *     middle of the link.
 *
 * Everything here is pure apart from the default `Message-ID` local part, which
 * is injectable for tests.
 */

// ── Header encoding ─────────────────────────────────────────────────────────

/** Header values end at the first CR/LF — anything after it is an injection. */
export function sanitizeHeaderValue(value: string): string {
  return (value.split(/[\r\n]/, 1)[0] ?? '').trim();
}

const isAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);

/**
 * RFC 2047 encoding for a header value carrying non-ASCII text.
 *
 * Split into several encoded words rather than one: the spec caps an encoded
 * word at 75 characters, and a subject naming a company with an accented name
 * — "Société Générale — your 409A draft is ready" — comfortably exceeds that
 * as a single word. Clients that enforce the cap showed the raw `=?utf-8?B?…`
 * to the reader instead of decoding it.
 *
 * The split is on UTF-8 *character* boundaries: cutting a multi-byte sequence
 * across two encoded words produces a replacement character in every client
 * that decodes each word independently, which is all of them.
 */
export function encodeHeaderWords(value: string): string {
  if (isAscii(value)) return value;
  // "=?utf-8?B?" + "?=" is 12 chars; base64 of n bytes is 4*ceil(n/3). Keeping
  // the payload to 45 bytes leaves the whole word at 72 — inside the 75 cap.
  const MAX_BYTES = 45;
  const words: string[] = [];
  let chunk = Buffer.alloc(0);
  for (const char of value) {
    const bytes = Buffer.from(char, 'utf8');
    if (chunk.length + bytes.length > MAX_BYTES) {
      words.push(`=?utf-8?B?${chunk.toString('base64')}?=`);
      chunk = Buffer.alloc(0);
    }
    chunk = Buffer.concat([chunk, bytes]);
  }
  if (chunk.length > 0) words.push(`=?utf-8?B?${chunk.toString('base64')}?=`);
  // A CRLF + space between encoded words is a fold; decoders join the words
  // and drop the whitespace between them, which is what we want.
  return words.join('\r\n ');
}

/**
 * `Name: value`, folded so no line exceeds the 998-octet limit.
 *
 * Folding happens at whitespace only, which is the only place RFC 5322 allows
 * it. A single unbreakable token longer than the limit (a pathological URL) is
 * emitted whole rather than corrupted by an illegal fold — better a message the
 * relay may reject than one it silently truncates.
 */
export function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || /\r\n/.test(value)) return line;
  const out: string[] = [];
  let current = `${name}:`;
  for (const token of value.split(' ')) {
    if (current.length + 1 + token.length > 78 && current !== `${name}:`) {
      out.push(current);
      current = ` ${token}`;
    } else {
      current += ` ${token}`;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

// ── Body encoding ───────────────────────────────────────────────────────────

const hex = (byte: number): string => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Quoted-printable (RFC 2045 §6.7).
 *
 * Chosen over 8bit because it needs no ESMTP negotiation, and over base64
 * because a text body should stay readable in a raw message — which is how the
 * ops team debugs a delivery complaint.
 *
 * Three cases beyond the obvious byte mapping:
 *   * Trailing space or tab is encoded. Relays strip trailing whitespace, and
 *     a stripped space changes the decoded bytes, which breaks any signature
 *     computed over them.
 *   * A leading `.` is encoded, so no body line can begin with the character
 *     SMTP uses to end DATA. Dot-stuffing still runs downstream; this makes it
 *     a no-op rather than a load-bearing step.
 *   * Soft breaks land at 75 characters so the `=` that marks them keeps the
 *     line inside the 76-character maximum.
 */
export function encodeQuotedPrintable(input: string): string {
  const lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf8');
    let current = '';
    const push = (token: string) => {
      if (current.length + token.length > 75) {
        out.push(`${current}=`);
        current = '';
      }
      current += token;
    };
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i]!;
      const last = i === bytes.length - 1;
      const space = byte === 0x20 || byte === 0x09;
      if (space && last) push(hex(byte));
      else if (space) push(String.fromCharCode(byte));
      else if (byte === 0x3d) push(hex(byte));
      else if (byte === 0x2e && i === 0) push(hex(byte));
      else if (byte >= 0x21 && byte <= 0x7e) push(String.fromCharCode(byte));
      else push(hex(byte));
    }
    out.push(current);
  }
  return out.join('\r\n');
}

// ── HTML rendering ──────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bare `http(s)://…` runs, so a link in a plain-text body is clickable. */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * The plain-text body as HTML: paragraphs on blank lines, `<br>` on single
 * ones, and bare URLs linked.
 *
 * Linking is done over the *raw* text and each side escaped separately, because
 * escaping first would turn an `&` inside a query string into `&amp;` before
 * the pattern ran, and the href would then point somewhere else. Trailing
 * sentence punctuation is left outside the link — "see https://n409.app/x." is
 * a link followed by a full stop, not a link to a path ending in one.
 */
export function textToHtml(text: string): string {
  const linkify = (segment: string): string =>
    segment.replace(URL_PATTERN, (raw) => {
      const trimmed = raw.replace(/[.,;:!?]+$/, '');
      const tail = raw.slice(trimmed.length);
      const safe = escapeHtml(trimmed);
      return `<a href="${safe}" style="color:#1d4ed8;text-decoration:underline">${safe}</a>${escapeHtml(tail)}`;
    });

  const escapeOutsideUrls = (segment: string): string => {
    let out = '';
    let cursor = 0;
    for (const match of segment.matchAll(URL_PATTERN)) {
      out += escapeHtml(segment.slice(cursor, match.index));
      out += linkify(match[0]);
      cursor = match.index + match[0].length;
    }
    return out + escapeHtml(segment.slice(cursor));
  };

  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;line-height:1.55">${escapeOutsideUrls(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');
}

export interface HtmlEmailOptions {
  subject: string;
  /** The plain-text body this is the alternative for. */
  body: string;
  /** White-label sender name; falls back to the product name. */
  brandName?: string;
  /** Rendered under a rule, above the unsubscribe line. Plain text. */
  footer?: string;
  /** Where "manage preferences" points. Omitted entirely when absent. */
  preferencesUrl?: string;
}

/**
 * A complete HTML document for one message.
 *
 * Table layout and inline styles, because Outlook's Word-based renderer
 * supports neither flexbox nor a `<style>` block reliably, and a notification
 * that collapses into a single unstyled column in the one client most finance
 * departments use is worse than no HTML part at all. Nothing is loaded from the
 * network — no web fonts, no tracking pixel, no remote images — so the message
 * renders identically whether or not the client blocks remote content, and
 * there is no image to block in the first place.
 *
 * The preheader is the text a client shows beside the subject in the list view.
 * Left unset it shows whatever the first visible characters happen to be, which
 * for a branded header is the brand name repeated after the sender name.
 */
export function renderHtmlEmail(options: HtmlEmailOptions): string {
  const brand = escapeHtml(options.brandName?.trim() || 'N409');
  const preheader = escapeHtml(options.body.replace(/\s+/g, ' ').trim().slice(0, 140));
  const footer = options.footer ? `<p style="margin:0 0 8px">${escapeHtml(options.footer)}</p>` : '';
  const preferences = options.preferencesUrl
    ? `<p style="margin:0"><a href="${escapeHtml(options.preferencesUrl)}" style="color:#64748b">Manage email preferences</a></p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(options.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:16px">${brand}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 18px;font-size:19px;line-height:1.35;font-weight:600">${escapeHtml(options.subject)}</h1>
${textToHtml(options.body)}
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5">
${footer}${preferences}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Message assembly ────────────────────────────────────────────────────────

export interface ListUnsubscribe {
  /** HTTPS endpoint accepting the RFC 8058 one-click POST. */
  url: string;
  /** Optional mailto fallback for clients that will not POST. */
  mailto?: string;
  /** Adds `List-Unsubscribe-Post`. Only set it when `url` accepts POST. */
  oneClick?: boolean;
}

export interface MimeMessageInput {
  from: string;
  to: string;
  subject: string;
  /** Plain-text body. Always present, always the `multipart` fallback. */
  body: string;
  /** HTML alternative. Its absence makes this a plain `text/plain` message. */
  html?: string;
  date?: Date;
  replyTo?: string;
  listUnsubscribe?: ListUnsubscribe;
  /** RFC 3834. Set for anything a human did not personally type. */
  autoSubmitted?: 'auto-generated' | 'auto-replied';
  /** Overrides for determinism in tests; both are generated otherwise. */
  messageId?: string;
  boundary?: string;
}

/**
 * The domain a `Message-ID` is minted under.
 *
 * It must be one the sender controls, and the only such name we can derive
 * without new configuration is the envelope sender's. A `From` with no `@` at
 * all is a misconfiguration; `n409.invalid` is used rather than inventing a
 * real-looking domain, because a Message-ID pointing at somebody else's host is
 * worse than one that is obviously local.
 */
export function messageIdDomain(from: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  const domain = address.split('@')[1]?.trim().replace(/[>\s]/g, '');
  return domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'n409.invalid';
}

/**
 * An RFC 5322 message, `multipart/alternative` when an HTML part is supplied.
 *
 * Every header value is sanitized rather than trusted: subjects and company
 * names reach here from user input, and a CRLF in one of them is a header
 * injection that would let a caller add a `Bcc`.
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const boundary = input.boundary ?? `n409-${newUlid()}`;
  const localPart = input.messageId ?? newUlid();
  const headers: string[] = [
    foldHeader('From', sanitizeHeaderValue(encodeHeaderWords(input.from))),
    foldHeader('To', sanitizeHeaderValue(encodeHeaderWords(input.to))),
    foldHeader('Subject', encodeHeaderWords(sanitizeHeaderValue(input.subject))),
    foldHeader('Date', (input.date ?? new Date()).toUTCString()),
    foldHeader('Message-ID', `<${localPart}@${messageIdDomain(input.from)}>`),
    'MIME-Version: 1.0',
  ];
  if (input.replyTo) {
    headers.push(foldHeader('Reply-To', sanitizeHeaderValue(encodeHeaderWords(input.replyTo))));
  }
  if (input.listUnsubscribe) {
    const targets = [`<${sanitizeHeaderValue(input.listUnsubscribe.url)}>`];
    if (input.listUnsubscribe.mailto) {
      targets.push(`<${sanitizeHeaderValue(input.listUnsubscribe.mailto)}>`);
    }
    headers.push(foldHeader('List-Unsubscribe', targets.join(', ')));
    if (input.listUnsubscribe.oneClick) {
      headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    }
  }
  if (input.autoSubmitted) {
    headers.push(`Auto-Submitted: ${input.autoSubmitted}`);
    // Suppresses out-of-office replies to a machine-sent message; without it a
    // client on holiday bounces an autoreply at the no-reply mailbox for every
    // milestone on their engagement.
    headers.push('X-Auto-Response-Suppress: All');
  }

  const textPart = encodeQuotedPrintable(input.body);
  let message: string;
  if (input.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    // Ordering is load-bearing: RFC 2046 says the *last* part a client can
    // render wins, so HTML must follow the text fallback, not precede it.
    message =
      `${headers.join('\r\n')}\r\n\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Transfer-Encoding: quoted-printable\r\n\r\n' +
      `${textPart}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: text/html; charset=utf-8\r\n' +
      'Content-Transfer-Encoding: quoted-printable\r\n\r\n' +
      `${encodeQuotedPrintable(input.html)}\r\n` +
      `--${boundary}--\r\n`;
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: quoted-printable');
    message = `${headers.join('\r\n')}\r\n\r\n${textPart}\r\n`;
  }

  // Dot-stuffing (RFC 5321 §4.5.2). Quoted-printable already encodes a leading
  // '.', so this cannot fire on a body line — it stays as the guarantee that
  // the DATA terminator is unambiguous no matter what the encoder does.
  return message.replace(/(^|\r\n)\./g, '$1..');
}
