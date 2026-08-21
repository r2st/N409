// The parser behind the deploy-time config preflight.
//
// What is being pinned here is mostly the *gap* between a systemd
// EnvironmentFile and the dotenv file it looks exactly like. Every difference
// below is silent: the file reads correctly to a human and to a shell, and the
// service boots with a variable the operator believes is set.
import { describe, expect, it } from 'vitest';
import { mergeEnvSources, parseEnvironmentFile, parseUnitFile } from '../src/systemdEnv.js';

function vars(text: string): Record<string, string> {
  return Object.fromEntries(parseEnvironmentFile(text).vars);
}

function problems(text: string): string[] {
  return parseEnvironmentFile(text).problems.map((p) => p.message);
}

describe('parseEnvironmentFile — the ordinary readings', () => {
  it('reads plain assignments', () => {
    expect(vars('NODE_ENV=production\nPORT=3001\n')).toEqual({ NODE_ENV: 'production', PORT: '3001' });
  });

  it('ignores blank lines and both comment markers', () => {
    expect(vars('# a\n\n; b\n  # indented\nA=1\n')).toEqual({ A: '1' });
  });

  it('strips matching quotes and keeps the spaces inside them', () => {
    expect(vars('A="two words"\nB=\'two words\'\n')).toEqual({ A: 'two words', B: 'two words' });
  });

  it('undoes C escapes inside double quotes only', () => {
    expect(vars('A="a\\tb"')).toEqual({ A: 'a\tb' });
    expect(vars("A='a\\tb'")).toEqual({ A: 'a\\tb' });
  });

  it('undoes each C escape systemd honours, and passes an unknown one through', () => {
    // The set is small and closed: anything not on it is the bare character,
    // which is how `\$` survives in a password (see the trap below).
    expect(vars('A="a\\nb"')).toEqual({ A: 'a\nb' });
    expect(vars('A="a\\rb"')).toEqual({ A: 'a\rb' });
    expect(vars('A="a\\\\b"')).toEqual({ A: 'a\\b' });
    expect(vars('A="a\\"b"')).toEqual({ A: 'a"b' });
    expect(vars('A="a\\zb"')).toEqual({ A: 'azb' });
  });

  it('trims an unquoted value', () => {
    expect(vars('A=  spaced  \n')).toEqual({ A: 'spaced' });
  });

  it('keeps an = that appears inside the value', () => {
    expect(vars('DATABASE_URL=postgres://u:p@h/db?opt=1\n')).toEqual({
      DATABASE_URL: 'postgres://u:p@h/db?opt=1',
    });
  });

  it('joins a trailing-backslash continuation', () => {
    expect(vars('A=one\\\ntwo\n')).toEqual({ A: 'onetwo' });
  });
});

describe('parseEnvironmentFile — the traps', () => {
  it('does not set a variable written with export, and says why', () => {
    // The whole failure: `source .env` sets JWT_SECRET, systemd does not.
    const parsed = parseEnvironmentFile('export JWT_SECRET=abc\n');
    expect(parsed.vars.has('JWT_SECRET')).toBe(false);
    expect(parsed.problems[0]!.name).toBe('JWT_SECRET');
    expect(parsed.problems[0]!.message).toContain('UNSET');
  });

  it('flags a CRLF line, because a trailing \\r disarms every guard keyed off the value', () => {
    const parsed = parseEnvironmentFile('NODE_ENV=production\r\n');
    expect(parsed.problems.map((p) => p.message).join()).toContain('CRLF');
  });

  it('flags an unquoted value with an inline #, which has two readings', () => {
    expect(problems('EMAIL_MODE=smtp # the real one\n').join()).toContain('trailing comment');
  });

  it('leaves a quoted # alone — it is unambiguous', () => {
    expect(problems('A="a # b"')).toEqual([]);
    expect(vars('A="a # b"')).toEqual({ A: 'a # b' });
  });

  it('flags a braced reference, which exists for no other purpose', () => {
    expect(vars('B=${A}/x')).toEqual({ B: '${A}/x' });
    expect(problems('B=${A}/x').join()).toContain('does not expand');
  });

  it('flags a bare reference to a name this same file sets', () => {
    expect(problems('BASE=https://a.example\nURL=$BASE/x\n').join()).toContain('does not expand');
  });

  it('does not mistake a $ in a password for an expansion', () => {
    // Flagging every generated password is how a check teaches people to skip
    // it — and here the literal reading is also the correct one.
    expect(problems('PASSWORD=pa$$w0rd')).toEqual([]);
    expect(problems('DATABASE_URL=postgres://u:se$cret@h/db')).toEqual([]);
  });

  it('flags a duplicate assignment with a different value', () => {
    const parsed = parseEnvironmentFile('A=1\nA=2\n');
    expect(parsed.vars.get('A')).toBe('2');
    expect(parsed.problems[0]!.message).toContain('last assignment wins');
  });

  it('says nothing about a duplicate that repeats the same value', () => {
    expect(problems('A=1\nA=1\n')).toEqual([]);
  });

  it('flags an unclosed quote rather than guessing where it ends', () => {
    expect(problems('A="unclosed\n').join()).toContain('never closes');
  });

  it('flags a line with no = at all', () => {
    expect(problems('JUST_A_NAME\n').join()).toContain("no '='");
  });

  it('flags a name systemd will not accept', () => {
    const parsed = parseEnvironmentFile('MY-VAR=1\n');
    expect(parsed.vars.size).toBe(0);
    expect(parsed.problems[0]!.message).toContain('not a valid environment variable name');
  });

  it('keeps a line that ends the file on a continuation', () => {
    // No newline follows the backslash, so the loop exits with the line still
    // buffered. Dropping it would silently lose the last assignment in a file
    // an editor did not terminate.
    expect(vars('A=one\\')).toEqual({ A: 'one' });
  });

  it('reports the physical line a continuation started on', () => {
    const parsed = parseEnvironmentFile('A=1\nB=x\\\ny\nexport C=2\n');
    expect(parsed.problems[0]!.line).toBe(4);
  });
});

describe('parseUnitFile', () => {
  const unit = [
    '[Unit]',
    'Description=example',
    'Environment=NOT_THIS=1',
    '',
    '[Service]',
    'EnvironmentFile=/opt/N409/.env',
    'Environment=NODE_ENV=production',
    'Environment=PORT=3001',
    'ExecStart=/usr/bin/node dist/index.js',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  it('reads EnvironmentFile and Environment from [Service]', () => {
    const parsed = parseUnitFile(unit);
    expect(parsed.environmentFiles).toEqual([{ path: '/opt/N409/.env', optional: false }]);
    expect(Object.fromEntries(parsed.environment)).toEqual({ NODE_ENV: 'production', PORT: '3001' });
  });

  it('ignores an Environment= outside [Service], where it means nothing', () => {
    expect(parseUnitFile(unit).environment.has('NOT_THIS')).toBe(false);
  });

  it('marks a leading - as an optional file', () => {
    const parsed = parseUnitFile('[Service]\nEnvironmentFile=-/opt/N409/.env.local\n');
    expect(parsed.environmentFiles).toEqual([{ path: '/opt/N409/.env.local', optional: true }]);
  });

  it('treats an empty assignment as the documented reset', () => {
    const parsed = parseUnitFile(
      '[Service]\nEnvironmentFile=/a\nEnvironmentFile=\nEnvironment=A=1\nEnvironment=\n',
    );
    expect(parsed.environmentFiles).toEqual([]);
    expect(parsed.environment.size).toBe(0);
  });

  it('splits several assignments on one Environment= line, respecting quotes', () => {
    const parsed = parseUnitFile('[Service]\nEnvironment=A=1 B="two words" C=3\n');
    expect(Object.fromEntries(parsed.environment)).toEqual({ A: '1', B: 'two words', C: '3' });
  });
});

describe('parseUnitFile — the malformed lines it has to survive', () => {
  it('skips a [Service] line with no = at all', () => {
    const parsed = parseUnitFile('[Service]\nExecStart\nEnvironment=A=1\n');
    expect(Object.fromEntries(parsed.environment)).toEqual({ A: '1' });
  });

  it('skips a bare token on an Environment= line', () => {
    // `B` is not an assignment; systemd ignores it rather than setting it empty.
    const parsed = parseUnitFile('[Service]\nEnvironment=A=1 B C=3\n');
    expect(Object.fromEntries(parsed.environment)).toEqual({ A: '1', C: '3' });
  });

  it('skips an Environment= name systemd would not accept', () => {
    const parsed = parseUnitFile('[Service]\nEnvironment=1BAD=x A-B=y OK=z\n');
    expect(Object.fromEntries(parsed.environment)).toEqual({ OK: 'z' });
  });

  it('keeps an escaped quote inside a quoted Environment= value', () => {
    const parsed = parseUnitFile('[Service]\nEnvironment=A="say \\"hi\\" now" B=2\n');
    expect(Object.fromEntries(parsed.environment)).toEqual({ A: 'say "hi" now', B: '2' });
  });

  it('leaves a value too short to be quoted alone', () => {
    // A single `"` is not an opening and a closing quote, so `unquote` has to
    // measure before it slices — otherwise it returns the empty string for a
    // value that is genuinely one character.
    const parsed = parseUnitFile('[Service]\nEnvironment=A="\n');
    expect(parsed.environment.get('A')).toBe('"');
  });

  it('lets an unterminated quote swallow the rest of the line, as systemd does', () => {
    const parsed = parseUnitFile(['[Service]', "Environment=A=' B=2", ''].join('\n'));
    expect(Object.fromEntries(parsed.environment)).toEqual({ A: "' B=2" });
  });

  it('ignores a section header that is not [Service] and keeps reading after it', () => {
    const parsed = parseUnitFile(
      '[Service]\nEnvironment=A=1\n[Install]\nEnvironment=B=2\n[Service]\nEnvironment=C=3\n',
    );
    expect(Object.fromEntries(parsed.environment)).toEqual({ A: '1', C: '3' });
  });
});

describe('mergeEnvSources', () => {
  const unit = new Map([['NODE_ENV', 'production']]);

  it('agrees with itself when nothing collides', () => {
    const merged = mergeEnvSources(unit, new Map([['PORT', '3001']]));
    expect(merged.conflicts).toEqual([]);
    expect(merged.unitWins).toEqual(merged.fileWins);
  });

  it('reports a collision instead of picking a winner', () => {
    // The precedence of Environment= vs EnvironmentFile= is a systemd rule not
    // visible from either file. Rather than encode it, a disagreement is a
    // fault — an operator reading the unit cannot tell which value is live
    // either, and here the two readings are "production guards armed" and
    // "production guards off".
    const merged = mergeEnvSources(unit, new Map([['NODE_ENV', 'development']]));
    expect(merged.conflicts).toEqual([
      { name: 'NODE_ENV', unitValue: 'production', fileValue: 'development' },
    ]);
    expect(merged.unitWins.NODE_ENV).toBe('production');
    expect(merged.fileWins.NODE_ENV).toBe('development');
  });

  it('is not a conflict when both sides say the same thing', () => {
    expect(mergeEnvSources(unit, new Map([['NODE_ENV', 'production']])).conflicts).toEqual([]);
  });

  it('lets both sources override the inherited base', () => {
    const merged = mergeEnvSources(unit, new Map([['PORT', '3001']]), { PORT: '9', OTHER: 'kept' });
    expect(merged.unitWins).toEqual({ NODE_ENV: 'production', PORT: '3001', OTHER: 'kept' });
  });

  it('drops undefined entries from the base rather than passing them on', () => {
    const merged = mergeEnvSources(new Map(), new Map(), { A: undefined, B: 'x' });
    expect(merged.unitWins).toEqual({ B: 'x' });
  });
});
