import { describe, expect, it } from 'vitest';
import { buildValuationWhere } from '../../src/repos/valuations.js';
import { contentFromManagedTemplate } from '../../src/domain/report.js';

/** Final-status §4.3 gap sweep — pure pieces. */

describe('unread scope (gap 4)', () => {
  it('filters on last_comment_at vs the side read marker', () => {
    const admin = buildValuationWhere({ kind: 'all' }, { unreadFor: 'admin' });
    expect(admin.whereSql).toContain('last_comment_at IS NOT NULL');
    expect(admin.whereSql).toContain('admin_read_at IS NULL OR last_comment_at > admin_read_at');

    const user = buildValuationWhere({ kind: 'own', userId: 'U1' }, { unreadFor: 'user' });
    expect(user.whereSql).toContain('user_read_at IS NULL OR last_comment_at > user_read_at');
  });

  it('prefixes the alias on joined queries', () => {
    const { whereSql } = buildValuationWhere({ kind: 'all' }, { unreadFor: 'admin' }, 'v.');
    expect(whereSql).toContain('v.last_comment_at > v.admin_read_at');
  });
});

describe('requester search (gap 7)', () => {
  it('matches company, workflow id, or the requesting user name/email', () => {
    const { whereSql, params } = buildValuationWhere({ kind: 'all' }, { q: 'jane' });
    expect(whereSql).toContain('company_name ILIKE $1');
    expect(whereSql).toContain('su.email ILIKE $1');
    expect(whereSql).toContain("concat_ws(' ', su.first_name, su.last_name) ILIKE $1");
    expect(whereSql).toContain('su.id = valuations.user_id');
    expect(params).toEqual(['%jane%', 'jane']);
  });

  it('uses the alias for the owner reference on joined queries', () => {
    const { whereSql } = buildValuationWhere({ kind: 'all' }, { q: 'jane' }, 'v.');
    expect(whereSql).toContain('su.id = v.user_id');
  });

  it('exact ULID / number searches stay exact (no user subquery)', () => {
    const ulid = buildValuationWhere({ kind: 'all' }, { q: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(ulid.whereSql).not.toContain('su.email');
    const num = buildValuationWhere({ kind: 'all' }, { q: '#123' });
    expect(num.whereSql).toContain('number = $1');
  });
});

describe('managed template merge (gap 6)', () => {
  const vars = {
    company_name: 'Acme Inc',
    kind: '409a' as const,
    valuation_ref: 'REF',
    date: '2026-07-07',
    currency: 'USD',
  };

  it('splits <h1> headings into sections and fills placeholders', () => {
    const content = contentFromManagedTemplate(
      {
        name: 'Custom 409A',
        body: '<h1>Opening</h1><p>About {{company_name}} as of {{date}}.</p><h1>Close</h1><p>Ref {{valuation_ref}}.</p>',
      },
      vars,
    );
    expect(content.title).toBe('Custom 409A — Acme Inc');
    expect(content.sections.map((s) => s.heading)).toEqual(['Opening', 'Close']);
    expect(content.sections[0]!.html).toContain('About Acme Inc as of 2026-07-07.');
    expect(content.sections[1]!.html).toContain('Ref REF.');
  });

  it('keeps content before the first heading as an introduction', () => {
    const content = contentFromManagedTemplate(
      { name: 'T', body: '<p>Preamble.</p><h1>Body</h1><p>Rest.</p>' },
      vars,
    );
    expect(content.sections.map((s) => s.heading)).toEqual(['Introduction', 'Body']);
  });

  it('wraps a heading-less body in a single section and sanitizes scripts', () => {
    const content = contentFromManagedTemplate(
      { name: 'T', body: '<p>Only.</p><script>alert(1)</script>' },
      vars,
    );
    expect(content.sections).toHaveLength(1);
    expect(content.sections[0]!.heading).toBe('Report');
    expect(content.sections[0]!.html).not.toContain('script');
  });

  it('keeps an unclosed trailing <h1> with the body it opens', () => {
    const content = contentFromManagedTemplate(
      { name: 'T', body: '<h1>Done</h1><p>Closed.</p><h1>Dangling<p>Trailing.</p>' },
      vars,
    );
    expect(content.sections.map((s) => s.heading)).toEqual(['Done']);
    expect(content.sections[0]!.html).toBe('<p>Closed.</p><h1>Dangling<p>Trailing.</p>');
  });

  it('splits a body whose headings are never closed in linear time', () => {
    // The split is paid on every report generated from the template, not once
    // by whoever saved it, so a quadratic scan here bills the wrong person.
    const body = '<h1>'.repeat(250_000);
    const started = performance.now();
    contentFromManagedTemplate({ name: 'T', body }, vars);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
