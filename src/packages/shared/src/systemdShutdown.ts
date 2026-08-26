/**
 * The shutdown half of a unit file's contract.
 *
 * `shutdown.ts` bounds the graceful path at {@link DEFAULT_SHUTDOWN_GRACE_MS}
 * and exits either way, and the entire reason that is safe is a sentence in its
 * own docstring: 10s is "comfortably under systemd's 90s `TimeoutStopSec`". That
 * is a claim about a *distro default* — nothing in this repository set it, no
 * test read it, and a host that shipped a different one would have quietly
 * inverted the relationship the bounded shutdown depends on.
 *
 * The Python services had the same gap from the other direction and worse.
 * uvicorn's graceful shutdown is unbounded by default: on SIGTERM it waits for
 * in-flight requests with no deadline at all. The AI pipelines block on an LLM
 * for up to 90 seconds and the engine holds a worker thread for a whole
 * OPM/waterfall run, so "wait for in-flight requests" was routinely longer than
 * systemd's patience. The process never exited on its own terms, systemd waited
 * out its default and SIGKILLed mid-flight — precisely the outcome the graceful
 * path exists to prevent, arrived at by way of a graceful path.
 *
 * So there are two numbers per unit and one rule joining them: the application
 * must give up before the supervisor does. This module reads both numbers off
 * the unit file and reports where that ordering does not hold.
 *
 * Faults are returned rather than thrown, matching `systemdResources.ts`: the
 * caller collects them across the whole install set, and a deploy should report
 * every one at once rather than the first.
 */

import { DEFAULT_SHUTDOWN_GRACE_MS } from './shutdown.js';

/** A systemd time span, or the reason it could not be read as one. */
export type TimeSpan =
  | { kind: 'seconds'; seconds: number; raw: string }
  /** `infinity`, and also `0` — systemd spells "never time out" both ways. */
  | { kind: 'infinity'; raw: string }
  | { kind: 'unparseable'; raw: string };

/** systemd's unit suffixes, in seconds. `us`/`ns` are omitted deliberately: a
 *  shutdown deadline expressed in microseconds is a typo, not a configuration,
 *  and reading it as valid would let it through. */
const UNITS: [RegExp, number][] = [
  [/^(\d+(?:\.\d+)?)(?:ms)$/, 1 / 1000],
  [/^(\d+(?:\.\d+)?)(?:s|sec|secs|second|seconds)$/, 1],
  [/^(\d+(?:\.\d+)?)(?:m|min|mins|minute|minutes)$/, 60],
  [/^(\d+(?:\.\d+)?)(?:h|hr|hour|hours)$/, 3600],
  // A bare number is seconds. This is the form the units actually use.
  [/^(\d+(?:\.\d+)?)$/, 1],
];

/**
 * Reads a systemd time span.
 *
 * Handles the compound form (`1min 30s`) because systemd does and because it is
 * the spelling somebody reaches for when raising a limit past a minute — read
 * as unparseable it would be reported as a missing deadline, which points at
 * the wrong fix.
 */
export function parseTimeSpan(raw: string): TimeSpan {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'unparseable', raw };
  const lowered = trimmed.toLowerCase();
  // `0` disables the timeout, exactly as `infinity` does. Treating it as "zero
  // seconds" would read the most dangerous setting in this file as the
  // strictest one.
  if (lowered === 'infinity' || /^0+(?:\.0+)?$/.test(lowered)) {
    return { kind: 'infinity', raw };
  }

  let total = 0;
  for (const part of lowered.split(/\s+/)) {
    const match = UNITS.map(([re, mult]) => [re.exec(part), mult] as const).find(([m]) => m !== null);
    if (!match) return { kind: 'unparseable', raw };
    total += Number(match[0]![1]) * match[1];
  }
  return { kind: 'seconds', seconds: total, raw };
}

export interface UnitShutdown {
  /** `Type=`, lowercased. `simple` is the long-running shape. */
  type: string | null;
  /** `TimeoutStopSec=`, or `TimeoutSec=` where only that is set. */
  stopTimeout: TimeSpan | null;
  /** Which directive supplied {@link stopTimeout}; for the fault message. */
  stopTimeoutKey: 'TimeoutStopSec' | 'TimeoutSec' | null;
  /** The full `ExecStart=` line, unsplit. */
  execStart: string | null;
  /** `--timeout-graceful-shutdown N`, when ExecStart runs uvicorn. */
  uvicornGraceSeconds: number | null;
  /** True when ExecStart runs uvicorn at all. */
  runsUvicorn: boolean;
}

/** Reads the `[Service]` directives that decide how a stop ends. */
export function parseUnitShutdown(text: string): UnitShutdown {
  const out: UnitShutdown = {
    type: null,
    stopTimeout: null,
    stopTimeoutKey: null,
    execStart: null,
    uvicornGraceSeconds: null,
    runsUvicorn: false,
  };
  let section = '';
  let sawStopSec = false;
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (section !== 'Service') continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    switch (key) {
      case 'Type':
        out.type = value === '' ? null : value.toLowerCase();
        break;
      // TimeoutSec sets start *and* stop; TimeoutStopSec overrides it for the
      // stop half. Order in the file does not decide which wins, so the
      // specific key is preferred whenever it appears at all.
      case 'TimeoutStopSec':
        sawStopSec = true;
        out.stopTimeout = parseTimeSpan(value);
        out.stopTimeoutKey = 'TimeoutStopSec';
        break;
      case 'TimeoutSec':
        if (!sawStopSec) {
          out.stopTimeout = parseTimeSpan(value);
          out.stopTimeoutKey = 'TimeoutSec';
        }
        break;
      case 'ExecStart':
        out.execStart = value;
        if (/(^|[/\s])uvicorn(\s|$)/.test(value)) {
          out.runsUvicorn = true;
          const grace = /--timeout-graceful-shutdown[= ]\s*(\d+)/.exec(value);
          out.uvicornGraceSeconds = grace ? Number(grace[1]) : null;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** systemd's own default when a unit says nothing, in seconds. */
export const SYSTEMD_DEFAULT_TIMEOUT_STOP_S = 90;

/**
 * The rules every long-running unit has to satisfy.
 *
 * Scoped to `Type=simple` on purpose. The two backup units are `Type=oneshot`:
 * they are a `pg_dump` and a restore rehearsal, they hold no in-flight requests
 * and have no graceful path to bound, and a stop deadline on them would cut a
 * backup short rather than protect anything. A rule that applied to every
 * `.service` in the install set would have to be given an exception list, and
 * the exception list is the thing that goes stale — keying on the unit's own
 * declared shape means a sixth service added later is covered by construction.
 */
export function shutdownFaults(unit: UnitShutdown): string[] {
  const faults: string[] = [];
  // Only long-running services. `Type=` absent defaults to `simple` when
  // ExecStart is set, which is systemd's rule and therefore ours.
  const longRunning = unit.type === null ? unit.execStart !== null : unit.type === 'simple';
  if (!longRunning) return faults;

  const appGraceS = DEFAULT_SHUTDOWN_GRACE_MS / 1000;

  if (unit.stopTimeout === null) {
    faults.push(
      'no TimeoutStopSec — the stop deadline is whatever the host defaults to ' +
        `(${SYSTEMD_DEFAULT_TIMEOUT_STOP_S}s on most distros, but nothing here sets it). The bounded ` +
        'graceful shutdown in shared/shutdown.ts is only safe while the app gives up before the ' +
        'supervisor does, and that ordering cannot be asserted against a number no file states.',
    );
  } else if (unit.stopTimeout.kind === 'infinity') {
    faults.push(
      `TimeoutStopSec=${unit.stopTimeout.raw} disables the stop deadline entirely — a wedged process ` +
        'is then never killed, and the unit hangs a deploy forever instead of failing it. ' +
        '(systemd spells "never" as both `infinity` and `0`.)',
    );
  } else if (unit.stopTimeout.kind === 'unparseable') {
    faults.push(
      `${unit.stopTimeoutKey}=${unit.stopTimeout.raw} is not a time span systemd will read as intended.`,
    );
  } else if (unit.stopTimeout.seconds <= appGraceS) {
    faults.push(
      `${unit.stopTimeoutKey}=${unit.stopTimeout.raw} is not above the ${appGraceS}s the application ` +
        'allows itself to shut down in (shared/shutdown.ts DEFAULT_SHUTDOWN_GRACE_MS). systemd would ' +
        'SIGKILL a shutdown that was still working, which is the exact outcome the bounded graceful ' +
        'path exists to avoid — and the kill lands mid-flush, so telemetry is lost and the DB sees an ' +
        'abandoned connection.',
    );
  }

  if (unit.runsUvicorn) {
    if (unit.uvicornGraceSeconds === null) {
      faults.push(
        'ExecStart runs uvicorn without --timeout-graceful-shutdown, which is unbounded by default: ' +
          'on SIGTERM uvicorn waits for in-flight requests with no deadline. The process then never ' +
          'exits on its own and systemd SIGKILLs it, losing whatever was in flight. The Node services ' +
          'have been bounded since they gained shared/shutdown.ts; this is the same contract.',
      );
    } else if (unit.stopTimeout?.kind === 'seconds' && unit.uvicornGraceSeconds >= unit.stopTimeout.seconds) {
      faults.push(
        `--timeout-graceful-shutdown ${unit.uvicornGraceSeconds} is not below ` +
          `${unit.stopTimeoutKey}=${unit.stopTimeout.raw}, so systemd kills the process before uvicorn ` +
          'ever reaches its own deadline. The flag is then decorative: every shutdown ends in SIGKILL ' +
          'and the bound reads as configured while doing nothing.',
      );
    }
  }

  return faults;
}
