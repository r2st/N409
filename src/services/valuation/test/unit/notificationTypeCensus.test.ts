import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EVENT_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  notificationsForTransition,
  type NotificationEventType,
} from '../../src/domain/emailWorkflows.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';
import { NOTIFICATION_TYPES, unboundInAppKeys } from '../../src/domain/notificationTypes.js';

/**
 * What can arrive in a reader's inbox, and whether they can stop it (R218).
 *
 * `notifications.type` is free text and every writer outside the state-change
 * hook picks its own value at the call site, so the platform had fifteen kinds
 * of notification the preference matrix has never listed. Most of them must
 * send — a chargeback deadline is not a preference — but that was true by
 * accident of where each writer was written, and nothing anywhere recorded
 * which of them was a decision.
 *
 * So this reads the notification writes back out of the source. It is a source
 * scan and not a database census deliberately: a type is wrong the moment it
 * is written, not the moment somebody triggers the path, and half of these
 * paths only run under a Stripe webhook.
 *
 * The scan is the fragile half, so it checks itself: `sitesFound` must stay
 * above a floor, and every dynamic `type:` expression at a write site must be
 * one this file knows how to resolve. A scan that silently matches nothing is
 * the failure mode a green census hides — see the notes on
 * `errorBodyDisclosure.test.ts` for the two ways that has happened here before.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Every call that writes a notification row, however it spells the type. */
const WRITERS = ['createNotifications', 'createNotification', 'alertBilling'];

/**
 * `type:` expressions that are not literals, and what they resolve to.
 *
 * `alertBilling` is scanned as a writer in its own right, so `args.type` is
 * the parameter it forwards and its real values are the literals at the five
 * call sites. `spec.type` is a workflow rule's notify type, which the census
 * in `emailWorkflows.test.ts` already holds inside the frozen taxonomy.
 */
const RESOLVED_DYNAMIC: Record<string, string[] | 'from-rules'> = {
  'args.type': [],
  'spec.type': 'from-rules',
  COMMENT_NOTIFICATION_TYPE: ['comment_posted'],
};

/** The notify types the workflow rules can emit, for `spec.type`. */
function ruleNotifyTypes(): string[] {
  const snapshot = {
    id: '01N409VALCENSUS00000000000',
    kind: '409a',
    company_name: 'Census Co',
    user_id: 'owner',
    assigned_reviewer_id: 'reviewer',
  };
  return VALUATION_STATES.flatMap((state) => notificationsForTransition(snapshot, state)).map((n) => n.type);
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * The source of one call expression, from its opening paren to the matching
 * close. Written by hand rather than with a regex because the argument to
 * `createNotifications` is routinely a `.map()` over an object literal, and
 * "up to the next `)`" stops inside it — which is how a scan reads as green
 * over a call it never actually looked at.
 */
function callBody(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

interface Site {
  file: string;
  literals: string[];
  dynamic: string[];
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of tsFiles(SRC)) {
    // The repo itself defines these functions; scanning the definitions would
    // find the `type` field of the input interface, not a write.
    if (file.endsWith(join('repos', 'notifications.ts'))) continue;
    const source = readFileSync(file, 'utf8');
    for (const writer of WRITERS) {
      const pattern = new RegExp(`\\b${writer}\\s*\\(`, 'g');
      for (const match of source.matchAll(pattern)) {
        const open = match.index! + match[0].length - 1;
        const body = callBody(source, open);
        const literals = [...body.matchAll(/\btype:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]!);
        const dynamic = [...body.matchAll(/\btype:\s*([A-Za-z_][\w.]*)\s*[,\n]/g)].map((m) => m[1]!);
        if (literals.length > 0 || dynamic.length > 0)
          sites.push({ file: file.slice(SRC.length + 1), literals, dynamic });
      }
    }
  }
  return sites;
}

describe('notification type census', () => {
  const sites = scan();

  it('finds the notification writes it is supposed to be reading', () => {
    // Nineteen call sites across six modules at the time of writing. The floor
    // is what stops a rename of `createNotifications` turning this whole file
    // into a test that asserts nothing — a scan matching nothing passes every
    // other case here, because every other case is a claim about what it found.
    expect(sites.length, `sites found: ${sites.map((s) => s.file).join(', ')}`).toBeGreaterThanOrEqual(15);
    const files = new Set(sites.map((s) => s.file));
    for (const expected of [
      join('hooks', 'stateChange.ts'),
      join('hooks', 'jobAlerts.ts'),
      join('hooks', 'commentNotifications.ts'),
      join('routes', 'billing.ts'),
      join('routes', 'payments.ts'),
      join('routes', 'auditorPortal.ts'),
    ]) {
      expect(files.has(expected), `no notification write found in ${expected}`).toBe(true);
    }
  });

  it('knows how to resolve every non-literal type at a write site', () => {
    for (const site of sites) {
      for (const expr of site.dynamic) {
        expect(
          Object.hasOwn(RESOLVED_DYNAMIC, expr),
          `${site.file} writes a notification with type \`${expr}\`, which this census cannot resolve — ` +
            'add it to RESOLVED_DYNAMIC or use a literal',
        ).toBe(true);
      }
    }
  });

  it('declares every type it can write', () => {
    const written = new Set(sites.flatMap((s) => s.literals));
    for (const type of written) {
      expect(
        Object.hasOwn(NOTIFICATION_TYPES, type),
        `notification type '${type}' is written but not declared in domain/notificationTypes.ts — ` +
          'say whether a reader can turn it off, and why not if they cannot',
      ).toBe(true);
    }
  });

  it('writes every type it declares', () => {
    const written = new Set(sites.flatMap((s) => s.literals));
    // Resolved through the same table the previous case checks, so a dynamic
    // site cannot be excused here and unexplained there.
    for (const expr of new Set(sites.flatMap((s) => s.dynamic))) {
      const resolution = RESOLVED_DYNAMIC[expr];
      if (resolution === 'from-rules') for (const type of ruleNotifyTypes()) written.add(type);
      else for (const type of resolution ?? []) written.add(type);
    }
    for (const type of Object.keys(NOTIFICATION_TYPES)) {
      expect(written.has(type), `'${type}' is declared but nothing writes it`).toBe(true);
    }
  });

  it('binds every opt-out to a key the settings screen actually shows', () => {
    const known = new Set<string>(NOTIFICATION_EVENT_TYPES);
    for (const [type, spec] of Object.entries(NOTIFICATION_TYPES)) {
      if (spec.optOut === null) continue;
      expect(known.has(spec.optOut), `${type} opts out via '${spec.optOut}', which is not a matrix key`).toBe(
        true,
      );
      expect(
        NOTIFICATION_EVENT_CHANNELS[spec.optOut as NotificationEventType].in_app,
        `${type} opts out via '${spec.optOut}', whose in-app channel is declared unused`,
      ).toBe(true);
    }
  });

  /**
   * The direction that goes wrong quietly. A matrix key advertising an in-app
   * switch with no notification type bound to it is a checkbox that silences
   * nothing — the same class of lie as the four dead switches this round
   * removed, one level further in.
   */
  it('leaves no in-app switch with nothing bound to it', () => {
    expect(unboundInAppKeys()).toEqual([]);
  });

  it('gives every must-send a reason', () => {
    for (const [type, spec] of Object.entries(NOTIFICATION_TYPES)) {
      if (spec.optOut !== null) continue;
      expect(spec.why.length, `${type} must send and says nothing about why`).toBeGreaterThan(20);
    }
  });
});
