import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildCommands,
  pushRecent,
  rankCommands,
  readRecent,
  scoreCommand,
  valuationIdFromPath,
} from '../src/lib/commands';
import type { User } from '../src/lib/types';

const user = (roles: string[]): Pick<User, 'roles' | 'id'> => ({ id: 'u1', roles });

const actions = { signOut: () => {}, toggleTheme: () => {} };

function commandsFor(roles: string[], pathname = '/dashboard') {
  return buildCommands({ user: user(roles), effective: user(roles), pathname, actions });
}

const labels = (roles: string[], pathname?: string) => commandsFor(roles, pathname).map((c) => c.label);

describe('valuationIdFromPath', () => {
  it('recognises a workspace path and its tabs', () => {
    expect(valuationIdFromPath('/valuations/abc123def')).toBe('abc123def');
    expect(valuationIdFromPath('/valuations/abc123def/workbook')).toBe('abc123def');
  });

  it('is not fooled by the sibling pages', () => {
    expect(valuationIdFromPath('/valuations')).toBeNull();
    expect(valuationIdFromPath('/valuations/new')).toBeNull();
    expect(valuationIdFromPath('/dashboard')).toBeNull();
  });
});

describe('buildCommands gating', () => {
  it('hides ops and admin destinations from a client', () => {
    const client = labels(['valuation_user']);
    expect(client).toContain('Dashboard');
    expect(client).toContain('Valuations');
    expect(client).not.toContain('Review tasks');
    expect(client).not.toContain('Users & roles');
    expect(client).not.toContain('Fund portfolios');
  });

  it('gives ops the operations block but not user administration', () => {
    const reviewer = labels(['reviewer']);
    expect(reviewer).toContain('Review tasks');
    expect(reviewer).toContain('All valuations');
    expect(reviewer).not.toContain('Users & roles');
  });

  it('gives an admin everything', () => {
    const admin = labels(['admin']);
    expect(admin).toContain('Review tasks');
    expect(admin).toContain('Users & roles');
    expect(admin).toContain('Enterprise SSO');
  });

  it('respects the previewed role, not the real one', () => {
    // effectiveUser strips ops roles in "User view"; the palette must follow.
    const previewed = buildCommands({
      user: user(['admin']),
      effective: user(['valuation_user']),
      pathname: '/dashboard',
      actions,
    }).map((c) => c.label);
    expect(previewed).not.toContain('Users & roles');
  });
});

describe('this-valuation commands', () => {
  it('offers no tab commands outside a workspace', () => {
    expect(commandsFor(['admin']).some((c) => c.group === 'This valuation')).toBe(false);
  });

  it('offers the workspace tabs when one is open', () => {
    const tabs = commandsFor(['admin'], '/valuations/v-9001/params').filter(
      (c) => c.group === 'This valuation',
    );
    expect(tabs.map((t) => t.label)).toContain('Workbook');
    expect(tabs.find((t) => t.label === 'Workbook')?.to).toBe('/valuations/v-9001/workbook');
    // Overview is the bare workspace path, not '/overview'.
    expect(tabs.find((t) => t.label === 'Overview')?.to).toBe('/valuations/v-9001');
  });

  it('withholds ops-only tabs from a client standing in a workspace', () => {
    const tabs = commandsFor(['valuation_user'], '/valuations/v-9001').filter(
      (c) => c.group === 'This valuation',
    );
    const names = tabs.map((t) => t.label);
    expect(names).toContain('Documents');
    expect(names).not.toContain('Workbook');
    expect(names).not.toContain('ASC 718');
  });
});

describe('scoreCommand', () => {
  it('ranks a prefix above a mid-string hit above a keyword-only hit', () => {
    const prefix = scoreCommand('work', 'Workbook')!;
    const mid = scoreCommand('book', 'Workbook')!;
    const keyword = scoreCommand('excel', 'Workbook', 'excel export')!;
    expect(prefix).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(keyword);
  });

  it('matches initials', () => {
    expect(scoreCommand('vb', 'Value Bridge')).not.toBeNull();
    // An initials hit beats the same letters merely scattered through a label.
    expect(scoreCommand('vb', 'Value Bridge')!).toBeGreaterThan(
      scoreCommand('vb', 'Overwrites schema browser')!,
    );
  });

  it('matches a scattered subsequence and rejects a non-match', () => {
    expect(scoreCommand('wbk', 'Workbook')).not.toBeNull();
    expect(scoreCommand('zzz', 'Workbook')).toBeNull();
  });

  it('treats an empty query as a match so the list shows unfiltered', () => {
    expect(scoreCommand('', 'Anything')).toBe(0);
  });
});

describe('rankCommands', () => {
  const all = commandsFor(['admin']);

  it('filters to matches', () => {
    const hits = rankCommands(all, 'sso', []);
    expect(hits[0]?.label).toBe('Enterprise SSO');
  });

  it('floats a recently-used command above an equal-scoring one', () => {
    // Both 'Billing' and 'Bot prompts' match 'b' at the same tier.
    const cold = rankCommands(all, 'b', []);
    const warm = rankCommands(all, 'b', ['nav:billing']);
    expect(warm[0]?.label).toBe('Billing');
    expect(warm.map((c) => c.label)).toEqual(expect.arrayContaining(cold.map((c) => c.label)));
  });

  it('keeps registry order for ties with no history', () => {
    const unfiltered = rankCommands(all, '', []);
    expect(unfiltered[0]?.label).toBe('Dashboard');
  });
});

describe('recent items', () => {
  beforeEach(() => localStorage.clear());

  it('stores most-recent-first, de-duplicated and capped', () => {
    pushRecent('a');
    pushRecent('b');
    pushRecent('a');
    expect(readRecent()).toEqual(['a', 'b']);
    for (let i = 0; i < 12; i += 1) pushRecent(`x${i}`);
    expect(readRecent()).toHaveLength(8);
  });

  it('survives a corrupt store', () => {
    localStorage.setItem('n409.palette.recent', '{not json');
    expect(readRecent()).toEqual([]);
  });
});

describe('recent items — a store that is present but not what we wrote', () => {
  beforeEach(() => localStorage.clear());

  it('ignores well-formed JSON that is not a list', () => {
    // Same key, different shape: an older build, or another tab's extension.
    localStorage.setItem('n409.palette.recent', '{"a":1}');
    expect(readRecent()).toEqual([]);
    localStorage.setItem('n409.palette.recent', '"a"');
    expect(readRecent()).toEqual([]);
  });

  it('drops non-string entries rather than jumping to one', () => {
    localStorage.setItem('n409.palette.recent', JSON.stringify(['a', 7, null, 'b']));
    expect(readRecent()).toEqual(['a', 'b']);
  });

  it('still returns the new list when the store refuses the write', () => {
    // Private mode and a full quota both throw from `setItem`. Recents are a
    // convenience; losing them must not fail the jump the user just made.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    try {
      expect(pushRecent('a')).toEqual(['a']);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('scoreCommand — labels that split into nothing', () => {
  it('handles a label with repeated separators when matching initials', () => {
    // `'Value  -  Bridge'.split(/[\s-]+/)` is fine, but a leading separator
    // yields an empty first word, whose initial is nothing at all.
    expect(scoreCommand('vb', ' Value Bridge')).not.toBeNull();
    expect(scoreCommand('zz', ' Value Bridge')).toBeNull();
  });
});
