/**
 * Antivirus scanning for uploaded documents.
 *
 * `fileType.ts` already refuses a file whose bytes contradict its extension,
 * which stops the crude "rename evil.exe to report.pdf" case. It is explicitly
 * not antivirus, and the gap it leaves is the one that matters here: a
 * genuinely malicious document that is a *valid* document. A weaponised XLSX is
 * a real ZIP with real sheets; a malicious PDF is a real PDF. Both sniff clean,
 * both get stored, and both are then handed back to whoever downloads them —
 * and on this platform that is an auditor or a board member opening a
 * spreadsheet from a company they do not know, which is the exact shape of the
 * attack a 409A workflow invites.
 *
 * The scanner is an interface with a ClamAV implementation, not a hard
 * dependency. Deployments that have clamd point at it; deployments that do not
 * are unchanged, because a scan nobody configured must not become a service
 * that fails to boot. `resolveScanner` returns undefined when unconfigured and
 * `scanUpload` is a no-op in that case.
 *
 * Wired into `storeDocument` rather than into the two upload routes, so the
 * scan cannot be forgotten by whatever becomes the third way to upload a file.
 */

import net from 'node:net';

export type ScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  /** The scanner could not give an answer — down, timed out, or protocol error. */
  | { status: 'error'; message: string };

export interface VirusScanner {
  /** Human-readable name for logs and the rejection message. */
  readonly name: string;
  scan(buffer: Buffer): Promise<ScanVerdict>;
}

// ── clamd INSTREAM protocol ───────────────────────────────────────────────────

/**
 * clamd's INSTREAM framing: a 4-byte big-endian length prefix per chunk, and a
 * zero-length chunk to mark the end. Split out from the socket work because the
 * framing is the part that is easy to get wrong and impossible to see failing —
 * a mis-framed stream makes clamd hang rather than complain.
 *
 * `chunkSize` stays well under clamd's default StreamMaxLength; the buffers
 * here are already capped at MAX_DOCUMENT_BYTES by the routes.
 */
export function buildInstream(buffer: Buffer, chunkSize = 64 * 1024): Buffer {
  const parts: Buffer[] = [Buffer.from('zINSTREAM\0', 'ascii')];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const chunk = buffer.subarray(offset, offset + chunkSize);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(chunk.length, 0);
    parts.push(header, chunk);
  }
  // The terminating zero-length chunk. Without it clamd waits forever.
  parts.push(Buffer.from([0, 0, 0, 0]));
  return Buffer.concat(parts);
}

/**
 * Reads clamd's one-line reply.
 *
 * Replies look like `stream: OK`, `stream: Eicar-Test-Signature FOUND`, or
 * `... ERROR`, with a trailing NUL in the `z` protocol. Anything unrecognised
 * is an error rather than a pass: a reply we cannot parse is not evidence the
 * file is clean.
 */
export function parseClamdReply(raw: string): ScanVerdict {
  const line = raw.replace(/\0/g, '').trim();
  if (line === '') return { status: 'error', message: 'empty reply from clamd' };
  if (/\bOK$/.test(line)) return { status: 'clean' };
  const found = /^(?:.*?:\s*)?(.+?)\s+FOUND$/.exec(line);
  if (found) return { status: 'infected', signature: found[1]!.trim() };
  if (/\bERROR$/.test(line)) return { status: 'error', message: line };
  return { status: 'error', message: `unrecognised clamd reply: ${line}` };
}

export interface ClamdOptions {
  host: string;
  port: number;
  /** Whole-scan deadline. A scanner that hangs must not hang the upload. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real TCP connection. */
  connect?: (host: string, port: number) => net.Socket;
}

/**
 * A `VirusScanner` backed by clamd over TCP.
 *
 * Every failure path resolves to `{status:'error'}` rather than rejecting: the
 * caller's policy decides whether an unavailable scanner blocks an upload (see
 * `scanUpload`), and that decision should be made in one place rather than in
 * every try/catch around a scan.
 */
export function clamdScanner(opts: ClamdOptions): VirusScanner {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const connect = opts.connect ?? ((host, port) => net.createConnection({ host, port }));

  return {
    name: `clamd(${opts.host}:${opts.port})`,
    scan(buffer) {
      return new Promise<ScanVerdict>((resolve) => {
        let socket: net.Socket;
        try {
          socket = connect(opts.host, opts.port);
        } catch (err) {
          resolve({ status: 'error', message: `could not connect: ${String(err)}` });
          return;
        }

        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (verdict: ScanVerdict) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(verdict);
        };

        const timer = setTimeout(
          () => finish({ status: 'error', message: `scan timed out after ${timeoutMs}ms` }),
          timeoutMs,
        );
        // Do not keep the process alive for a scan; shutdown should not wait on
        // clamd, and the timeout above already bounds the wait.
        if (typeof timer.unref === 'function') timer.unref();

        socket.on('error', (err) => finish({ status: 'error', message: String(err) }));
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => finish(parseClamdReply(Buffer.concat(chunks).toString('utf8'))));
        socket.on('close', () =>
          // A close with no reply is a failure, not a pass. Harmless if `end`
          // already settled it.
          finish({ status: 'error', message: 'clamd closed the connection without replying' }),
        );

        const send = () => socket.end(buildInstream(buffer));
        // `connect` has already fired when a test hands back a live stub.
        if ('connecting' in socket && socket.connecting) socket.on('connect', send);
        else send();
      });
    },
  };
}

// ── Policy ────────────────────────────────────────────────────────────────────

export interface ScanPolicy {
  scanner?: VirusScanner;
  /**
   * What an *unavailable* scanner means. `true` — the default whenever a
   * scanner is configured — refuses the upload, because a control that silently
   * stops working is worse than no control: nobody notices, and the uploads
   * that arrive while clamd is down are exactly the ones nobody will re-check.
   * Set false where availability genuinely outranks the scan.
   */
  failClosed: boolean;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/** Thrown for an infected or (when fail-closed) unscannable upload. */
export class UploadRejected extends Error {
  constructor(
    readonly reason: string,
    readonly verdict: ScanVerdict,
  ) {
    super(reason);
    this.name = 'UploadRejected';
  }
}

/**
 * Applies `policy` to `buffer`, returning normally when the upload may proceed.
 *
 * A clean verdict and an unconfigured scanner are both silent passes. An
 * infected verdict always throws. An error verdict throws only when fail-closed,
 * and is logged either way — a scanner that has quietly stopped answering is
 * something ops need to see whichever way the policy falls.
 */
export async function scanUpload(
  buffer: Buffer,
  policy: ScanPolicy,
  context: { filename: string } = { filename: 'upload' },
): Promise<ScanVerdict> {
  if (!policy.scanner) return { status: 'clean' };

  const verdict = await policy.scanner.scan(buffer);

  if (verdict.status === 'infected') {
    policy.log?.warn(
      { filename: context.filename, signature: verdict.signature, scanner: policy.scanner.name },
      'upload rejected by virus scan',
    );
    throw new UploadRejected(`file failed virus scan (${verdict.signature})`, verdict);
  }

  if (verdict.status === 'error') {
    policy.log?.warn(
      {
        filename: context.filename,
        error: verdict.message,
        scanner: policy.scanner.name,
        failClosed: policy.failClosed,
      },
      'virus scan unavailable',
    );
    if (policy.failClosed) {
      throw new UploadRejected('file could not be virus scanned; try again shortly', verdict);
    }
  }

  return verdict;
}
