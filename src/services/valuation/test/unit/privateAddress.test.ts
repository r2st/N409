import { describe, expect, it } from 'vitest';
import { isPrivateIpv4, isPrivateIpv6, isPrivateAddress } from '../../src/domain/privateAddress.js';

describe('isPrivateIpv4', () => {
  it.each([
    ['10.0.0.1', 'RFC 1918 class A'],
    ['10.255.255.255', 'RFC 1918 class A upper'],
    ['172.16.0.1', 'RFC 1918 class B lower'],
    ['172.31.255.255', 'RFC 1918 class B upper'],
    ['192.168.0.1', 'RFC 1918 class C'],
    ['192.168.255.255', 'RFC 1918 class C upper'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback upper'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', '"this network" block'],
    ['169.254.169.254', 'cloud metadata endpoint'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'RFC 6598 carrier NAT lower'],
    ['100.127.255.255', 'RFC 6598 carrier NAT upper'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['198.18.0.1', 'benchmarking lower'],
    ['198.19.255.255', 'benchmarking upper'],
    ['198.51.0.1', 'TEST-NET-2'],
    ['203.0.0.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
  ])('classifies %s as private (%s)', (addr) => {
    expect(isPrivateIpv4(addr)).toBe(true);
  });

  it.each([
    ['1.1.1.1', 'Cloudflare DNS'],
    ['8.8.8.8', 'Google DNS'],
    ['172.15.255.255', 'just below class B private'],
    ['172.32.0.0', 'just above class B private'],
    ['100.63.255.255', 'just below carrier NAT'],
    ['100.128.0.0', 'just above carrier NAT'],
    ['44.0.0.1', 'public routable'],
    ['223.255.255.255', 'last public class'],
  ])('classifies %s as public (%s)', (addr) => {
    expect(isPrivateIpv4(addr)).toBe(false);
  });

  it('rejects malformed octets as private (refuse rather than guess)', () => {
    expect(isPrivateIpv4('256.0.0.1')).toBe(true);
    expect(isPrivateIpv4('0x7f.0.0.1')).toBe(true);
    expect(isPrivateIpv4('1e2.0.0.1')).toBe(true);
    expect(isPrivateIpv4(' 10 .0.0.1')).toBe(true);
  });

  it('rejects wrong octet count as private', () => {
    expect(isPrivateIpv4('1.2.3')).toBe(true);
    expect(isPrivateIpv4('1.2.3.4.5')).toBe(true);
  });
});

describe('isPrivateIpv6', () => {
  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique local lower'],
    ['fdff::1', 'unique local upper'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped RFC 1918'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['2002:7f00:0001::', '6to4 carrying loopback'],
    ['2002:0a00:0001::', '6to4 carrying RFC 1918'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback (hex form from URL parser)'],
  ])('classifies %s as private (%s)', (addr) => {
    expect(isPrivateIpv6(addr)).toBe(true);
  });

  it.each([
    ['2001:db8::1', 'documentation prefix (routable shape)'],
    ['2607:f8b0:4004:800::200e', 'Google public'],
  ])('classifies %s as public (%s)', (addr) => {
    expect(isPrivateIpv6(addr)).toBe(false);
  });

  it('strips zone index before classifying', () => {
    expect(isPrivateIpv6('fe80::1%eth0')).toBe(true);
  });

  it('rejects unparseable addresses as private', () => {
    expect(isPrivateIpv6('not-an-address')).toBe(true);
    expect(isPrivateIpv6(':::1')).toBe(true);
  });
});

describe('isPrivateAddress', () => {
  it('dispatches to the v4 classifier for dotted-quad addresses', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('dispatches to the v6 classifier for colon addresses', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('2607:f8b0:4004:800::200e')).toBe(false);
  });

  it('refuses a hostname (not an address) as private', () => {
    expect(isPrivateAddress('localhost')).toBe(true);
    expect(isPrivateAddress('example.com')).toBe(true);
  });
});
