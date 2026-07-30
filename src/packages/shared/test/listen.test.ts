import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTEN_HOST, listenHost } from '../src/listen.js';

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
