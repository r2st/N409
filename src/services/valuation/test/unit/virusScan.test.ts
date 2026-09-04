import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildInstream,
  clamdScanner,
  parseClamdReply,
  scanUpload,
  UploadRejected,
  type ScanVerdict,
  type VirusScanner,
} from '../../src/documents/virusScan.js';

describe('buildInstream', () => {
  it('frames the payload as clamd expects: command, length-prefixed chunks, zero terminator', () => {
    const out = buildInstream(Buffer.from('hello'), 64);
    expect(out.subarray(0, 10).toString('ascii')).toBe('zINSTREAM\0');
    expect(out.readUInt32BE(10)).toBe(5);
    expect(out.subarray(14, 19).toString('ascii')).toBe('hello');
    // The zero-length chunk clamd waits for.
    expect(out.readUInt32BE(19)).toBe(0);
    expect(out.length).toBe(23);
  });

  it('splits a payload larger than the chunk size', () => {
    const out = buildInstream(Buffer.alloc(10, 0x61), 4);
    // 4 + 4 + 2 across three chunks.
    expect(out.readUInt32BE(10)).toBe(4);
    expect(out.readUInt32BE(10 + 4 + 4)).toBe(4);
    expect(out.readUInt32BE(10 + (4 + 4) * 2)).toBe(2);
  });

  it('still sends the terminator for an empty payload', () => {
    const out = buildInstream(Buffer.alloc(0));
    expect(out.length).toBe(14);
    expect(out.readUInt32BE(10)).toBe(0);
  });
});

describe('parseClamdReply', () => {
  it('reads a clean reply', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean' });
  });

  /** The reply a real clamd sends for the EICAR test file. */
  it('reads an infection and keeps the signature', () => {
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('reads an error reply as an error', () => {
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toMatchObject({
      status: 'error',
    });
  });

  /**
   * The safety property: anything we cannot parse is an error, never a pass. A
   * reply we do not understand is not evidence the file is clean.
   */
  it.each(['', '\0', 'something unexpected', 'stream:'])('treats %j as an error rather than clean', (raw) => {
    expect(parseClamdReply(raw).status).toBe('error');
  });
});

// ── clamdScanner over a stub socket ───────────────────────────────────────────

/** A socket stand-in that records what was written and replays a scripted reply. */
function stubSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    connecting: boolean;
    end: (data?: Buffer) => void;
    destroy: () => void;
    written: Buffer | null;
  };
  socket.connecting = false;
  socket.written = null;
  socket.end = vi.fn((data?: Buffer) => {
    socket.written = data ?? null;
  });
  socket.destroy = vi.fn();
  return socket;
}

describe('clamdScanner', () => {
  it('streams the payload and resolves the verdict', async () => {
    const socket = stubSocket();
    const scanner = clamdScanner({
      host: 'clamd',
      port: 3310,
      connect: () => socket as unknown as net.Socket,
    });

    const promise = scanner.scan(Buffer.from('payload'));
    expect(socket.written?.subarray(0, 10).toString('ascii')).toBe('zINSTREAM\0');

    socket.emit('data', Buffer.from('stream: OK\0'));
    socket.emit('end');
    await expect(promise).resolves.toEqual({ status: 'clean' });
  });

  it('reports an infection with its signature', async () => {
    const socket = stubSocket();
    const scanner = clamdScanner({
      host: 'clamd',
      port: 3310,
      connect: () => socket as unknown as net.Socket,
    });
    const promise = scanner.scan(Buffer.from('x'));
    socket.emit('data', Buffer.from('stream: Eicar-Signature FOUND\0'));
    socket.emit('end');
    await expect(promise).resolves.toEqual({
      status: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  /**
   * Every failure path resolves rather than rejects, so the fail-open/closed
   * decision lives in one place (scanUpload) instead of a try/catch per caller.
   */
  it('resolves an error when the socket fails', async () => {
    const socket = stubSocket();
    const scanner = clamdScanner({
      host: 'clamd',
      port: 3310,
      connect: () => socket as unknown as net.Socket,
    });
    const promise = scanner.scan(Buffer.from('x'));
    socket.emit('error', new Error('ECONNREFUSED'));
    await expect(promise).resolves.toMatchObject({ status: 'error' });
  });

  it('resolves an error when connecting throws outright', async () => {
    const scanner = clamdScanner({
      host: 'clamd',
      port: 3310,
      connect: () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    await expect(scanner.scan(Buffer.from('x'))).resolves.toMatchObject({ status: 'error' });
  });

  /** A closed connection with no reply is a failure, not a pass. */
  it('resolves an error when clamd closes without replying', async () => {
    const socket = stubSocket();
    const scanner = clamdScanner({
      host: 'clamd',
      port: 3310,
      connect: () => socket as unknown as net.Socket,
    });
    const promise = scanner.scan(Buffer.from('x'));
    socket.emit('close');
    await expect(promise).resolves.toMatchObject({ status: 'error' });
  });

  it('gives up on a scanner that never answers', async () => {
    vi.useFakeTimers();
    try {
      const socket = stubSocket();
      const scanner = clamdScanner({
        host: 'clamd',
        port: 3310,
        timeoutMs: 1000,
        connect: () => socket as unknown as net.Socket,
      });
      const promise = scanner.scan(Buffer.from('x'));
      vi.advanceTimersByTime(1001);
      await expect(promise).resolves.toMatchObject({
        status: 'error',
        message: expect.stringContaining('timed out'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Policy ────────────────────────────────────────────────────────────────────

const scannerReturning = (verdict: ScanVerdict): VirusScanner => ({
  name: 'stub',
  scan: vi.fn(async () => verdict),
});

function fakeLog() {
  const lines: Array<{ level: 'warn' | 'error'; obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    warn: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'warn', obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'error', obj, msg }),
  };
}

describe('scanUpload', () => {
  const payload = Buffer.from('x');

  it('passes silently when no scanner is configured', async () => {
    await expect(scanUpload(payload, { failClosed: true })).resolves.toEqual({ status: 'clean' });
  });

  it('passes a clean file', async () => {
    const policy = { scanner: scannerReturning({ status: 'clean' }), failClosed: true };
    await expect(scanUpload(payload, policy)).resolves.toEqual({ status: 'clean' });
  });

  it('rejects an infected file regardless of the fail policy', async () => {
    for (const failClosed of [true, false]) {
      const policy = {
        scanner: scannerReturning({ status: 'infected', signature: 'Eicar' }),
        failClosed,
      };
      await expect(scanUpload(payload, policy, { filename: 'model.xlsx' })).rejects.toBeInstanceOf(
        UploadRejected,
      );
    }
  });

  it('names the signature so the uploader knows this is not a retry', async () => {
    const policy = {
      scanner: scannerReturning({ status: 'infected', signature: 'Eicar' }),
      failClosed: false,
    };
    const err = await scanUpload(payload, policy).catch((e: unknown) => e);
    expect((err as UploadRejected).reason).toContain('Eicar');
  });

  it('refuses an unscannable upload when fail-closed', async () => {
    const policy = {
      scanner: scannerReturning({ status: 'error', message: 'clamd down' }),
      failClosed: true,
    };
    await expect(scanUpload(payload, policy)).rejects.toBeInstanceOf(UploadRejected);
  });

  it('lets an unscannable upload through when fail-open', async () => {
    const policy = {
      scanner: scannerReturning({ status: 'error', message: 'clamd down' }),
      failClosed: false,
    };
    await expect(scanUpload(payload, policy)).resolves.toMatchObject({ status: 'error' });
  });

  /**
   * The point of logging on both branches: a scanner that has quietly stopped
   * answering is something ops need to see even where the policy lets uploads
   * through, because that is precisely the case with no other symptom.
   */
  it('logs an unavailable scanner whichever way the policy falls', async () => {
    for (const failClosed of [true, false]) {
      const log = fakeLog();
      const policy = {
        scanner: scannerReturning({ status: 'error', message: 'clamd down' }),
        failClosed,
        log,
      };
      await scanUpload(payload, policy, { filename: 'f.pdf' }).catch(() => {});
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]!.msg).toBe('virus scan unavailable');
      expect(log.lines[0]!.obj).toMatchObject({ failClosed });
    }
  });

  /**
   * R412: the level and the flag, not just the line.
   *
   * `warn` in this estate means "a retry is coming" (`shared/failure.ts`), and
   * nothing retries a dead clamd — fail-open stores the file unscanned for
   * good, fail-closed sends the analyst back to re-upload, not to restart the
   * daemon. `alert: true` is the one field `log_alert_lines_total` counts, so
   * without it the only symptom of a security control that has stopped working
   * is a line in the journal.
   */
  it('alerts on an unavailable scanner rather than warning about it', async () => {
    for (const failClosed of [true, false]) {
      const log = fakeLog();
      await scanUpload(
        payload,
        {
          scanner: scannerReturning({ status: 'error', message: 'clamd down' }),
          failClosed,
          log,
        },
        { filename: 'f.pdf' },
      ).catch(() => {});
      expect(log.lines[0]!.level).toBe('error');
      expect(log.lines[0]!.obj).toMatchObject({ alert: true, failClosed });
    }
  });

  /**
   * The other half of the same decision: an infected file is the control
   * *working*, so it stays a warning and carries no alert. Asserted so a later
   * round does not sweep both onto one level.
   */
  it('does not alert on an infected file — the control worked', async () => {
    const log = fakeLog();
    await scanUpload(
      payload,
      { scanner: scannerReturning({ status: 'infected', signature: 'Eicar' }), failClosed: true, log },
      { filename: 'model.xlsx' },
    ).catch(() => {});
    expect(log.lines[0]!.level).toBe('warn');
    expect(log.lines[0]!.obj.alert).toBeUndefined();
  });

  it('logs a rejection with the filename and signature', async () => {
    const log = fakeLog();
    const policy = {
      scanner: scannerReturning({ status: 'infected', signature: 'Eicar' }),
      failClosed: true,
      log,
    };
    await scanUpload(payload, policy, { filename: 'cap-table.xlsx' }).catch(() => {});
    expect(log.lines[0]!.obj).toMatchObject({ filename: 'cap-table.xlsx', signature: 'Eicar' });
  });
});
