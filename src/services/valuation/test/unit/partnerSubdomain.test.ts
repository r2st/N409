import { describe, expect, it } from 'vitest';
import {
  isWellFormedSubdomain,
  normalizeSubdomain,
  RESERVED_SUBDOMAINS,
  subdomainFromHost,
} from '../../src/domain/partnerSubdomain.js';

const BASE = 'app.409.ai';

describe('partner subdomain normalization', () => {
  it('forgives case and surrounding whitespace', () => {
    expect(normalizeSubdomain('  Acme  ')).toEqual({ subdomain: 'acme' });
    expect(normalizeSubdomain('ACME-CAPITAL')).toEqual({ subdomain: 'acme-capital' });
  });

  it('refuses names DNS will not serve rather than rewriting them', () => {
    // Silently repairing these hands the firm an address different from the
    // one they asked for, which they then print on something.
    for (const bad of ['ab', '-acme', 'acme-', 'acme_capital', 'acme.capital', 'acme capital', '']) {
      expect(normalizeSubdomain(bad), bad).toEqual({ problem: 'malformed' });
    }
    expect(normalizeSubdomain('a'.repeat(64))).toEqual({ problem: 'malformed' });
    expect(normalizeSubdomain('a'.repeat(63))).toEqual({ subdomain: 'a'.repeat(63) });
  });

  it('refuses the names that would let a tenant impersonate the platform', () => {
    // `secure.<our domain>` in an address bar is worth more to an attacker
    // than any amount of page content.
    for (const name of ['secure', 'login', 'auth', 'billing', 'admin', 'api', 'www', 'support']) {
      expect(normalizeSubdomain(name), name).toEqual({ problem: 'reserved' });
    }
    expect(RESERVED_SUBDOMAINS.has('n409')).toBe(true);
  });

  it('checks reservations after folding case, not before', () => {
    expect(normalizeSubdomain('ADMIN')).toEqual({ problem: 'reserved' });
  });

  it('accepts an ordinary firm name', () => {
    expect(isWellFormedSubdomain('acme-valuations')).toBe(true);
    expect(normalizeSubdomain('acme-valuations')).toEqual({ subdomain: 'acme-valuations' });
  });
});

describe('resolving a tenant from a Host header', () => {
  it('reads the tenant label under the base domain', () => {
    expect(subdomainFromHost('acme.app.409.ai', BASE)).toBe('acme');
  });

  it('normalizes the spellings a real Host header arrives in', () => {
    // Port, case, and the trailing dot that is legal in a Host header and
    // absolutely something a scanner will send. Without folding all three the
    // same tenant has several spellings and only one of them works.
    expect(subdomainFromHost('ACME.App.409.AI:443', BASE)).toBe('acme');
    expect(subdomainFromHost('acme.app.409.ai.', BASE)).toBe('acme');
    expect(subdomainFromHost('  acme.app.409.ai  ', BASE)).toBe('acme');
  });

  it('treats the bare base domain as the platform', () => {
    expect(subdomainFromHost('app.409.ai', BASE)).toBeNull();
    expect(subdomainFromHost('app.409.ai:3000', BASE)).toBeNull();
  });

  it('refuses hosts outside the base domain', () => {
    // A Host header is attacker-controlled. Suffix matching without the dot
    // would make `evilapp.409.ai` look like a tenant of `app.409.ai`.
    expect(subdomainFromHost('evil.com', BASE)).toBeNull();
    expect(subdomainFromHost('acme.app.409.ai.evil.com', BASE)).toBeNull();
    expect(subdomainFromHost('notapp.409.ai', BASE)).toBeNull();
  });

  it('resolves exactly one label deep', () => {
    // We issue one level; anything deeper is a mistake or someone probing.
    expect(subdomainFromHost('a.b.app.409.ai', BASE)).toBeNull();
  });

  it('handles hosts that carry no tenant at all', () => {
    expect(subdomainFromHost('localhost:3000', BASE)).toBeNull();
    expect(subdomainFromHost('[::1]:3000', BASE)).toBeNull();
    expect(subdomainFromHost(undefined, BASE)).toBeNull();
    expect(subdomainFromHost('acme.app.409.ai', '')).toBeNull();
  });

  it('rejects a malformed label instead of passing it to a lookup', () => {
    expect(subdomainFromHost('-acme.app.409.ai', BASE)).toBeNull();
    expect(subdomainFromHost('ab.app.409.ai', BASE)).toBeNull();
  });

  it('reports a reserved label rather than filtering it', () => {
    // The lookup is what refuses it — and it refuses by finding no row,
    // because normalizeSubdomain never let one be stored.
    expect(subdomainFromHost('admin.app.409.ai', BASE)).toBe('admin');
  });
});
