import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEAD_LINK_DETAIL, type PublicLinkKind } from '../../src/domain/linkRefusal.js';
import { INVITE_TTL } from '../../src/repos/invitations.js';
import { VERIFICATION_TOKEN_TTL } from '../../src/repos/emailVerifications.js';
import { RESET_TOKEN_TTL } from '../../src/repos/passwordResets.js';

/**
 * Round 222 rewrote three of these and round 239 found the other three still
 * carrying the sentence it was written to replace — "This reset link is
 * invalid, expired, or already used" — on the two highest-volume public links
 * on the platform. So the census below is over the *shape* rather than over
 * the three strings that happened to be wrong, and over the routes as well as
 * the constants, because the failure mode is a seventh surface being added
 * with its own sentence.
 */
const KINDS = Object.keys(DEAD_LINK_DETAIL) as PublicLinkKind[];

const ROUTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes');
const routeSources = readdirSync(ROUTES)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ rel: f, text: readFileSync(path.join(ROUTES, f), 'utf8') }));

describe('every public link refusal', () => {
  it('covers all six surfaces', () => {
    // A census that lost its population passes every assertion under it.
    expect(KINDS).toEqual(
      expect.arrayContaining(['intake', 'auditor', 'board', 'reset', 'verification', 'invitation']),
    );
  });

  it.each(KINDS)('names the cause a reader can fix, for %s', (kind) => {
    // The likeliest cause of an unrecognised token is a link that did not
    // survive being copied, and it is the only one fixed in five seconds.
    expect(DEAD_LINK_DETAIL[kind]).toMatch(/cut short when it was copied/i);
    expect(DEAD_LINK_DETAIL[kind]).toMatch(/wrapped onto a second line/i);
  });

  it.each(KINDS)('names who reissues it, for %s', (kind) => {
    expect(DEAD_LINK_DETAIL[kind]).toMatch(/ask |reply to |sign in/i);
  });

  it.each(KINDS)('does not list causes and stop, for %s', (kind) => {
    // The shape this file exists to keep out.
    expect(DEAD_LINK_DETAIL[kind]).not.toMatch(/invalid, expired, or/i);
  });

  it('answers the question each reader is actually asking', () => {
    // Different per surface, which is why these are six strings and not one.
    expect(DEAD_LINK_DETAIL.intake).toMatch(/already saved is kept/i);
    expect(DEAD_LINK_DETAIL.board).toMatch(/no decision has been recorded/i);
    expect(DEAD_LINK_DETAIL.reset).toMatch(/password has not been changed/i);
    expect(DEAD_LINK_DETAIL.verification).toMatch(/account still exists/i);
    expect(DEAD_LINK_DETAIL.invitation).toMatch(/no account has been created/i);
  });

  it('states each deadline from the constant the row is written with', () => {
    // A deadline copied into prose is a deadline that starts lying the day
    // somebody changes the interval.
    expect(DEAD_LINK_DETAIL.reset).toContain(RESET_TOKEN_TTL);
    expect(DEAD_LINK_DETAIL.verification).toContain(VERIFICATION_TOKEN_TTL);
    expect(DEAD_LINK_DETAIL.invitation).toContain(INVITE_TTL);
  });

  it('leaves no route writing a dead-link sentence of its own', () => {
    /*
     * The oracle argument that keeps the causes merged only holds while every
     * dead state on a surface gets the *identical* string, so a route composing
     * its own is both a worse message and a hole in that reasoning.
     */
    const findings = routeSources
      .filter(({ text }) => /'This [a-z- ]*(link|invitation) is invalid/i.test(text))
      .map(({ rel }) => rel);
    expect(findings, 'routes still listing causes and stopping').toEqual([]);
  });
});
