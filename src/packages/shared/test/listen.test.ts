import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTEN_HOST, listenHost, listenPort } from '../src/listen.js';

/**
 * Bind interface. Every Node service hard-coded 0.0.0.0, publishing ports
 * 3000–3004 on the public interface with the host firewall as the only guard.
 * The Python services already defaulted to loopback; this makes all five agree.
 */

describe('listenHost', () => {
  it('defaults to loopback', () => {
    expect(listenHost({})).toBe('127.0.0.1');
    expect(DEFAULT_LISTEN_HOST).toBe('127.0.0.1');
  });

  it('honours an explicit HOST, because containers need 0.0.0.0', () => {
    // Docker publishes a port by reaching the container's own interface, so a
    // loopback bind inside a container is unreachable — docker-compose sets this.
    expect(listenHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('accepts a specific interface address', () => {
    expect(listenHost({ HOST: '10.0.1.7' })).toBe('10.0.1.7');
  });

  it('treats an empty or whitespace HOST as unset', () => {
    // An EnvironmentFile with a bare `HOST=` must not bind to the empty string,
    // which Node would read as "every interface" — the exact failure being fixed.
    expect(listenHost({ HOST: '' })).toBe('127.0.0.1');
    expect(listenHost({ HOST: '   ' })).toBe('127.0.0.1');
  });

  it('trims a stray trailing space from an env file', () => {
    expect(listenHost({ HOST: '0.0.0.0 ' })).toBe('0.0.0.0');
  });
});

/**
 * The port half of the same address, and the same class of bug the `HOST=` case
 * above was written for — except that this one had no floor at all.
 */
describe('listenPort', () => {
  it('falls back when PORT is absent, which is how every service runs locally', () => {
    expect(listenPort(3000, {})).toBe(3000);
    expect(listenPort(3004, {})).toBe(3004);
  });

  it('honours a valid PORT', () => {
    expect(listenPort(3000, { PORT: '3001' })).toBe(3001);
    expect(listenPort(3000, { PORT: '1' })).toBe(1);
    expect(listenPort(3000, { PORT: '65535' })).toBe(65535);
  });

  it('trims whitespace an env file left behind', () => {
    expect(listenPort(3000, { PORT: ' 3001 ' })).toBe(3001);
  });

  it('refuses a bare PORT= rather than binding a random ephemeral port', () => {
    // The whole reason this function exists. `Number('')` is 0, and
    // `listen({ port: 0 })` asks the kernel for any free port: the service comes
    // up, logs "listening", and answers on a port nothing in the estate dials.
    expect(() => listenPort(3000, { PORT: '' })).toThrow(/PORT is set but empty/);
    expect(() => listenPort(3000, { PORT: '   ' })).toThrow(/PORT is set but empty/);
  });

  it('refuses an explicit zero for the same reason', () => {
    expect(() => listenPort(3000, { PORT: '0' })).toThrow(/between 1 and 65535/);
  });

  it('refuses a port outside the representable range', () => {
    // Both used to reach `listen()` and die with a bare ERR_SOCKET_BAD_PORT
    // naming neither the variable nor the file it came from.
    expect(() => listenPort(3000, { PORT: '65536' })).toThrow(/got "65536"/);
    expect(() => listenPort(3000, { PORT: '-1' })).toThrow(/got "-1"/);
  });

  it('refuses a non-numeric or fractional port', () => {
    expect(() => listenPort(3000, { PORT: 'abc' })).toThrow(/got "abc"/);
    expect(() => listenPort(3000, { PORT: '3000.5' })).toThrow(/got "3000.5"/);
    expect(() => listenPort(3000, { PORT: 'Infinity' })).toThrow(/got "Infinity"/);
  });

  it('refuses spellings `Number` would accept but nobody would write', () => {
    // Each of these is a valid in-range integer to `Number`: 3000, 3000, 1000.
    // Accepting them means the port the process binds is not the string in the
    // unit file, which is the one thing an operator reading that file can check.
    expect(() => listenPort(3000, { PORT: '0x0bb8' })).toThrow(/got "0x0bb8"/);
    expect(() => listenPort(3000, { PORT: '+3000' })).toThrow(/got "\+3000"/);
    expect(() => listenPort(3000, { PORT: '1e3' })).toThrow(/got "1e3"/);
  });

  it('names PORT in every message, because the stack trace never did', () => {
    for (const value of ['', 'abc', '0', '70000']) {
      expect(() => listenPort(3000, { PORT: value })).toThrow(/PORT/);
    }
  });

  it('reads process.env when no environment is passed', () => {
    const saved = process.env.PORT;
    try {
      process.env.PORT = '4321';
      expect(listenPort(3000)).toBe(4321);
    } finally {
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });
});
