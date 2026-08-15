/**
 * Reading a deployed `.env` the way the thing that boots the services reads it.
 *
 * Every unit in `infra/systemd/` takes its configuration from one
 * `EnvironmentFile=/opt/N409/.env` plus a handful of in-unit `Environment=`
 * lines. Nothing in this repo has ever looked at that file: the config guards
 * in `loadConfig` run *inside* the booting process, so the first thing that
 * evaluates the deployed environment is the deploy itself, and a fault it finds
 * is an outage rather than a failed deploy. `preflight.ts` closes that, and this
 * module is the half that has to be right about what the file *means*.
 *
 * Being right is not free. A systemd `EnvironmentFile` looks exactly like a
 * dotenv file and is not one, and the differences are all silent:
 *
 *   - `export FOO=bar` assigns to a variable named `export FOO`, which is not a
 *     legal name, so systemd drops the line with a log warning and `FOO` is
 *     unset. A shell, `source`, docker-compose and every dotenv library set
 *     `FOO`. So the file can test clean by hand and boot the service with the
 *     variable missing.
 *   - There is no `${OTHER}` expansion. A value that references another
 *     variable is the literal text.
 *   - A `#` after a value may or may not start a comment depending on the
 *     parser; the same line therefore has two readings.
 *   - A CRLF file leaves `\r` on the end of every unquoted value, so
 *     `NODE_ENV=production` sets NODE_ENV to `production\r`, which compares
 *     equal to nothing and disarms every production-only guard in the estate
 *     while looking correct in every editor.
 *
 * The parser below therefore reports two things rather than one: the reading it
 * is confident about, and a list of lines whose meaning is *not* single-valued.
 * An ambiguous line is treated as a fault in its own right — a production
 * environment whose contents depend on parser trivia is a bug regardless of
 * which reading wins today, and the fix (quote it, or split the comment onto
 * its own line) is cheap.
 *
 * Deliberately NOT modelled: whether `EnvironmentFile=` overrides `Environment=`
 * or the other way round. That precedence has changed description across systemd
 * versions and is not worth encoding from memory. {@link mergeEnvSources}
 * instead computes both readings and treats any variable the two disagree on as
 * a fault — which is the stronger check anyway, because an operator staring at a
 * unit file cannot tell which value is live either.
 */

/** A line that does not have one unambiguous meaning, or that systemd drops. */
export interface EnvFileProblem {
  /** 1-based line number in the file, counting the physical line the item started on. */
  line: number;
  /** The variable the line was trying to set, when that much is recoverable. */
  name?: string;
  message: string;
}

export interface ParsedEnvFile {
  /** The confident reading: name → value, later assignments winning. */
  vars: Map<string, string>;
  problems: EnvFileProblem[];
}

/** systemd requires a C-identifier; anything else is logged and dropped. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split a file into logical lines, honouring a trailing backslash as a
 * continuation. The line number reported is the first physical line, because
 * that is the one an operator will look at.
 */
function logicalLines(text: string): { line: number; raw: string }[] {
  const out: { line: number; raw: string }[] = [];
  const physical = text.split('\n');
  let buffer: string | null = null;
  let startedAt = 0;
  for (let i = 0; i < physical.length; i++) {
    const current = physical[i] ?? '';
    const continues = /\\$/.test(current);
    const body = continues ? current.slice(0, -1) : current;
    if (buffer === null) {
      buffer = body;
      startedAt = i + 1;
    } else {
      buffer += body;
    }
    if (!continues) {
      out.push({ line: startedAt, raw: buffer });
      buffer = null;
    }
  }
  // A file ending on a continuation still has a pending line.
  if (buffer !== null) out.push({ line: startedAt, raw: buffer });
  return out;
}

/** Undo the C-style escapes systemd honours inside a double-quoted value. */
function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\(.)/g, (_all, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '\\':
        return '\\';
      case '"':
        return '"';
      default:
        return ch;
    }
  });
}

/**
 * Parse the text of a systemd `EnvironmentFile`.
 *
 * The value rules applied, which are the ones every systemd version agrees on:
 * a blank line or one whose first non-space character is `#` or `;` is skipped;
 * otherwise the text up to the first `=` is the name and the rest is the value;
 * a value wholly wrapped in single or double quotes has them removed (C escapes
 * are undone inside double quotes only); an unquoted value has surrounding
 * whitespace stripped. Nothing is expanded.
 */
export function parseEnvironmentFile(text: string): ParsedEnvFile {
  const vars = new Map<string, string>();
  const problems: EnvFileProblem[] = [];
  const seenAt = new Map<string, number>();
  /** Deferred until every name in the file is known — see the loop below. */
  const expansions: { line: number; name: string; value: string }[] = [];

  for (const { line, raw } of logicalLines(text)) {
    // A stray CR is the CRLF trap: it is invisible, it survives into the value,
    // and `production\r` arms nothing. Reported before anything else because it
    // affects every line in the file, not just this one.
    const hadCr = raw.endsWith('\r');
    const stripped = hadCr ? raw.slice(0, -1) : raw;
    const trimmed = stripped.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      problems.push({
        line,
        message: `no '=' in "${trimmed}" — systemd drops the line, so nothing on it is set`,
      });
      continue;
    }

    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);

    if (/^export\s/.test(name)) {
      const intended = name.replace(/^export\s+/, '');
      problems.push({
        line,
        name: intended,
        message:
          `"export ${intended}=..." assigns to a variable named "export ${intended}", which is not a legal ` +
          `name — systemd drops the line and ${intended} is UNSET. A shell, \`source\` and every dotenv ` +
          `library set ${intended} instead, so this file does not mean the same thing to you and to systemd. ` +
          `Drop the \`export\`.`,
      });
      continue;
    }

    if (!VALID_NAME.test(name)) {
      problems.push({
        line,
        name,
        message: `"${name}" is not a valid environment variable name — systemd drops the line`,
      });
      continue;
    }

    if (hadCr) {
      problems.push({
        line,
        name,
        message:
          `line ends CRLF — depending on the systemd version the carriage return either terminates the ` +
          `line or lands in the value, making ${name} "${value}\\r" rather than "${value}". A value with a ` +
          `trailing \\r compares equal to nothing, which silently disarms any guard keyed off it. ` +
          `Convert the file to LF.`,
      });
    }

    const quoted = value.trim();
    if (quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')) {
      value = unescapeDoubleQuoted(quoted.slice(1, -1));
    } else if (quoted.length >= 2 && quoted.startsWith("'") && quoted.endsWith("'")) {
      value = quoted.slice(1, -1);
    } else {
      if ((quoted.startsWith('"') || quoted.startsWith("'")) && quoted.length >= 1) {
        problems.push({
          line,
          name,
          message: `${name}'s value opens with ${quoted[0]} and never closes it — the quote is part of the value`,
        });
      }
      // An unquoted `#` is the ambiguous case: systemd versions differ on
      // whether it begins a comment, so the value is either `bar` or
      // `bar # note`. Both readings are plausible and only one is intended.
      if (/\s#/.test(quoted)) {
        problems.push({
          line,
          name,
          message:
            `${name}'s unquoted value contains " #" — that is either a trailing comment or part of the ` +
            `value depending on the systemd version. Quote the value, or move the comment to its own line.`,
        });
      }
      value = quoted;
    }

    expansions.push({ line, name, value });

    const previous = seenAt.get(name);
    if (previous !== undefined && vars.get(name) !== value) {
      problems.push({
        line,
        name,
        message:
          `${name} was already set on line ${previous} to "${vars.get(name) ?? ''}" and is set again here to ` +
          `"${value}" — the last assignment wins, which is rarely what a duplicate means`,
      });
    }
    seenAt.set(name, line);
    vars.set(name, value);
  }

  // Nothing is expanded in an EnvironmentFile, so a `$` is only worth reporting
  // when it looks like someone expected it to be.
  //
  // `${NAME}` is unambiguous: the braces exist for no other purpose. A bare
  // `$NAME` is not — a generated password holds one about as often as a
  // reference does, and flagging `pa$$w0rd` on every deploy is how a check
  // teaches people to skip it. So a bare reference is reported only when the
  // name it would have expanded to is actually assigned in this same file,
  // which is when it stops being a coincidence.
  for (const { line, name, value } of expansions) {
    const braced = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(value)?.[0];
    const bare = braced
      ? undefined
      : [...value.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].find((m) => vars.has(m[1]!))?.[0];
    const reference = braced ?? bare;
    if (reference === undefined) continue;
    problems.push({
      line,
      name,
      message:
        `${name}'s value contains "${reference}" — systemd does not expand variables in an ` +
        `EnvironmentFile, so ${name} is the literal text "${value}" rather than anything substituted`,
    });
  }

  return { vars, problems };
}

export interface ParsedUnit {
  /** `EnvironmentFile=` paths in declaration order; a leading `-` means optional. */
  environmentFiles: { path: string; optional: boolean }[];
  /** `Environment=` assignments in the unit itself. */
  environment: Map<string, string>;
}

/**
 * Pull the environment-relevant directives out of a `.service` file.
 *
 * Only `[Service]` is read: `Environment=` is meaningless in `[Unit]` or
 * `[Install]`, and a directive that looks like one there is not one. Continuation
 * lines are honoured because a long `Environment=` is commonly wrapped.
 */
export function parseUnitFile(text: string): ParsedUnit {
  const environmentFiles: { path: string; optional: boolean }[] = [];
  const environment = new Map<string, string>();
  let section = '';

  for (const { raw } of logicalLines(text)) {
    const trimmed = raw.replace(/\r$/, '').trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();

    if (key === 'EnvironmentFile') {
      // An empty assignment resets the list — systemd's documented way to drop
      // everything inherited from a drop-in.
      if (value === '') {
        environmentFiles.length = 0;
        continue;
      }
      const optional = value.startsWith('-');
      environmentFiles.push({ path: optional ? value.slice(1) : value, optional });
    } else if (key === 'Environment') {
      if (value === '') {
        environment.clear();
        continue;
      }
      // `Environment=` takes space-separated assignments on one line, with
      // quoting to keep a value holding spaces together.
      for (const assignment of splitAssignments(value)) {
        const at = assignment.indexOf('=');
        if (at < 0) continue;
        const name = assignment.slice(0, at);
        if (!VALID_NAME.test(name)) continue;
        environment.set(name, unquote(assignment.slice(at + 1)));
      }
    }
  }

  return { environmentFiles, environment };
}

/** Split `A=1 B="two words" C=3` respecting quotes. */
function splitAssignments(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < value.length) {
        current += ch + value[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '') out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export interface MergedEnv {
  /** The reading in which the unit's own `Environment=` wins a collision. */
  unitWins: Record<string, string>;
  /** The reading in which the `EnvironmentFile` wins a collision. */
  fileWins: Record<string, string>;
  /** Names set in both places with different values — live value unknowable by eye. */
  conflicts: { name: string; unitValue: string; fileValue: string }[];
}

/**
 * Combine a unit's `Environment=` with its `EnvironmentFile` contents.
 *
 * Both precedence readings are returned rather than one. systemd has a rule and
 * this module refuses to guess it, because guessing wrong here means the
 * preflight validates an environment the service will never see — the exact
 * failure it exists to catch. Any name the two readings disagree on is a
 * conflict, and the caller treats a conflict as a fault: an operator reading the
 * unit file cannot tell which value is live either, so the ambiguity is a
 * production problem in itself and the fix is to set it in one place.
 */
export function mergeEnvSources(
  unitEnvironment: Map<string, string>,
  fileVars: Map<string, string>,
  base: Record<string, string | undefined> = {},
): MergedEnv {
  const cleanBase: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) cleanBase[k] = v;

  const unitWins = { ...cleanBase, ...Object.fromEntries(fileVars), ...Object.fromEntries(unitEnvironment) };
  const fileWins = { ...cleanBase, ...Object.fromEntries(unitEnvironment), ...Object.fromEntries(fileVars) };

  const conflicts: { name: string; unitValue: string; fileValue: string }[] = [];
  for (const [name, unitValue] of unitEnvironment) {
    const fileValue = fileVars.get(name);
    if (fileValue !== undefined && fileValue !== unitValue) {
      conflicts.push({ name, unitValue, fileValue });
    }
  }

  return { unitWins, fileWins, conflicts };
}
