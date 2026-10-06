/**
 * R389: observability round — intake audit trail and document storage integrity.
 *
 * Two gaps closed:
 *
 * 1. The three firm-side intake operations (create, revoke, convert) wrote no
 *    admin events. These are significant credential-lifecycle and engagement-
 *    creation operations that an auditor asking "what did this firm do" would
 *    expect to find on the spine.
 *
 * 2. A stored document file missing from disk (DB row present, file absent)
 *    threw `problems.notFound` with no logging at all — a storage integrity
 *    failure that should page somebody.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_EVENT_CATALOG } from '../../src/domain/auditTrail.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sourceOf(relative: string): string {
  return readFileSync(path.resolve(HERE, '../..', relative), 'utf8');
}

describe('intake audit trail (R389)', () => {
  const INTAKE_TYPES = [
    'intake_link_created',
    'intake_link_revoked',
    'intake_link_converted',
  ] as const;

  it('has catalog entries for all three intake operations', () => {
    for (const type of INTAKE_TYPES) {
      expect(Object.keys(ADMIN_EVENT_CATALOG), type).toContain(type);
    }
  });

  it('grades conversion as critical and the other two as notice', () => {
    expect(ADMIN_EVENT_CATALOG.intake_link_created.severity).toBe('notice');
    expect(ADMIN_EVENT_CATALOG.intake_link_revoked.severity).toBe('notice');
    expect(ADMIN_EVENT_CATALOG.intake_link_converted.severity).toBe('critical');
  });

  it('places all three in the lifecycle category', () => {
    for (const type of INTAKE_TYPES) {
      expect(ADMIN_EVENT_CATALOG[type].category).toBe('lifecycle');
    }
  });

  it('writes recordAdminEvent for each operation in clientIntake.ts', () => {
    const src = sourceOf('src/routes/clientIntake.ts');
    for (const type of INTAKE_TYPES) {
      expect(src, `${type} should be written`).toContain(`'${type}'`);
    }
    const calls = src.match(/recordAdminEvent\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('document storage integrity logging (R389)', () => {
  it('logs with alert: true when a stored file is missing from disk', () => {
    const src = sourceOf('src/routes/documents.ts');
    const catchBlock = src.slice(
      src.indexOf('stored = await readFile(abs)'),
      src.indexOf("throw problems.notFound('Stored file is missing')") + 60,
    );
    expect(catchBlock).toContain('alert: true');
    expect(catchBlock).toContain('req.log.error');
  });
});
