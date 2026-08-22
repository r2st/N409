/**
 * Validate a *deployed* environment against the guards that would reject it at
 * boot — before anything is restarted.
 *
 * The guards themselves are not new. `loadConfig` has refused a production boot
 * on a half-configured Stripe pairing, a known-example JWT secret and an unset
 * PUBLIC_BASE_URL for a long time, and the two Python services and the report
 * service refuse to start without INTERNAL_SERVICE_TOKEN. What was missing is
 * that nothing ever ran them against the file the units actually read. The
 * first evaluation of `/opt/N409/.env` happened inside the booting process, so
 * the two possible outcomes of a bad config were:
 *
 *   - the guard fires, and the deploy has already stopped the old process, so
 *     the finding arrives as a crash-looping unit and an outage; or
 *   - the guard does not exist yet, and the bad config simply serves. That is
 *     what happened with Stripe: a STRIPE_SECRET_KEY with no
 *     STRIPE_WEBHOOK_SECRET sat in production for the 324 commits between
 *     d6ddf33 and 92013c0 — checkout taking money that nothing could fulfil —
 *     and was found by the outage rather than by anything in this repo.
 *
 * Running the same guards from the deploy, against the same file, turns both of
 * those into a failed deploy with the old release still serving. That is the
 * entire point: the check has to happen at a moment where the answer "no" is
 * cheap.
 *
 * It also covers the four services whose guards live somewhere `loadConfig`
 * cannot see. Every unit shares one EnvironmentFile, so a single missing
 * INTERNAL_SERVICE_TOKEN is four services that will not boot, and the deploy
 * script restarts valuation first and would have found only the one that still
 * does.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { totalmem } from 'node:os';
import path from 'node:path';
import {
  estateCeiling,
  estateCeilingFaults,
  flagProblems,
  formatBytes,
  listenPort,
  memoryLimitFaults,
  mergeEnvSources,
  parseEnvironmentFile,
  parseUnitFile,
  parseUnitMemory,
  type UnitCeiling,
} from '@n409/shared';
import { modelledRenderCeilingBytes } from './clients/reportRender.js';
import { loadConfig } from './config.js';

export interface PreflightFault {
  /** systemd unit the fault belongs to, or `.env` for a whole-file problem. */
  scope: string;
  message: string;
}

export interface PreflightResult {
  faults: PreflightFault[];
  /** Units that were examined, for the "checked N units" line the CLI prints. */
  units: string[];
}

/**
 * How each unit decides it is misconfigured, keyed by the unit's file name.
 *
 * `loadConfig` is the real thing for valuation — the whole zod schema plus every
 * production-only guard — rather than a re-statement of it, so a guard added
 * there is enforced here on the next deploy without anyone remembering to.
 *
 * The other four are one rule each, and they are transcribed rather than
 * imported: the Python pair cannot be imported from Node at all, and the report
 * service's `registerInternalAuth` needs a live Fastify instance. Each names its
 * source so the two can be compared by eye.
 */
const GUARDS: Record<string, (env: Record<string, string>) => string[]> = {
  'n409-valuation.service': (env) => {
    try {
      loadConfig(env);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  },
  // src/services/report/src/app.ts registerInternalAuth → shared/internalAuth.ts
  // MissingInternalTokenError, plus src/services/report/src/index.ts listenPort.
  'n409-report.service': (env) => [...requiresInternalToken(env, 'NODE_ENV', 'report'), ...bindsAPort(env)],
  // src/services/ai/app/internal_auth.py enforce_token_configured. No port
  // guard: both Python units pass `--port` on the ExecStart line, so PORT in
  // the environment is a variable uvicorn never reads.
  'n409-ai.service': (env) => requiresInternalToken(env, 'APP_ENV', 'ai'),
  // src/services/engine-wrapper/app/internal_auth.py enforce_token_configured.
  'n409-engine-wrapper.service': (env) => requiresInternalToken(env, 'APP_ENV', 'engine-wrapper'),
  // The web service is the public BFF and registers no internal-auth gate. Its
  // one start-up guard is the port it binds — which on this unit is the port
  // Caddy dials, so a wrong one here is the whole site.
  'n409-web.service': (env) => bindsAPort(env),
};

/**
 * The port guard for the two Node units without a config schema.
 *
 * Valuation gets this from `loadConfig` above, which now bounds `PORT` the way
 * it bounds everything else. Web and report call `listenPort` directly, so this
 * calls the same function against the same environment rather than restating
 * its rules.
 */
function bindsAPort(env: Record<string, string>): string[] {
  try {
    // The fallback is irrelevant here: an absent PORT is valid for every unit
    // and returns without complaint. Only a *set* one is being judged.
    listenPort(3000, env);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function requiresInternalToken(env: Record<string, string>, envVar: string, service: string): string[] {
  const production = (env[envVar] ?? '').toLowerCase() === 'production';
  if (production && !env.INTERNAL_SERVICE_TOKEN) {
    return [
      `INTERNAL_SERVICE_TOKEN is required when ${envVar}=production — the ${service} service refuses to ` +
        'start without it, because every non-health route would otherwise accept unauthenticated requests',
    ];
  }
  return [];
}

/**
 * The variable each unit reads to decide it is serving production, and which
 * therefore must say so.
 *
 * THE HOLE THIS CLOSES: every guard above that matters is conditional on this
 * variable. `requiresInternalToken` returns no faults at all unless the merged
 * environment says production, and `loadConfig`'s production-only checks — the
 * Stripe pairing, the known-example JWT secret, PUBLIC_BASE_URL — are gated the
 * same way. So a unit that *loses* its production declaration does not fail
 * this checker; it silently stops being checked, and reports a clean preflight
 * while running with every production guard switched off.
 *
 * That is not hypothetical. The engine-wrapper unit installed on the host had
 * no `Environment=APP_ENV=production` for four weeks (see
 * infra/install-units.sh), which left `internal_token_middleware` willing to
 * pass unauthenticated requests through the moment the secret went missing.
 * Preflight said nothing, and could not have: an absent declaration made every
 * question it asks answer "not applicable".
 *
 * Stated positively here instead. deploy.sh deploys production and only
 * production, so a unit it is about to install that does not claim to be
 * production is a fault in its own right, whatever the rest of the environment
 * says.
 */
const PRODUCTION_MARKERS: Record<string, string> = {
  'n409-valuation.service': 'NODE_ENV',
  'n409-report.service': 'NODE_ENV',
  'n409-web.service': 'NODE_ENV',
  'n409-ai.service': 'APP_ENV',
  'n409-engine-wrapper.service': 'APP_ENV',
};

/**
 * Fault the unit unless its own environment declares production.
 *
 * Deliberately not tolerant of near-misses. `APP_ENV=prod` is not production to
 * `is_production()` in either Python service — it compares against the literal
 * string — so treating it as production here would report healthy a box whose
 * guards are all off. The value has to be the one the services actually accept.
 */
function declaresProduction(env: Record<string, string>, unitName: string): string[] {
  const marker = PRODUCTION_MARKERS[unitName];
  if (marker === undefined) return [];
  const value = env[marker] ?? '';
  if (value.toLowerCase() === 'production') return [];
  const seen = value === '' ? 'unset' : `"${value}"`;
  return [
    `${marker} is ${seen}, not "production" — this unit is deployed to production, and every ` +
      `production-only guard it has (INTERNAL_SERVICE_TOKEN, the Stripe pairing, the JWT secret) is ` +
      `conditional on ${marker}, so leaving it ${seen} does not merely mislabel the service: it turns ` +
      `those guards off and makes this check pass by having nothing left to ask. Add ` +
      `Environment=${marker}=production to the unit.`,
  ];
}

/** Unit files this checker knows how to validate, in restart order. */
export const KNOWN_UNITS = Object.keys(GUARDS);

export interface PreflightOptions {
  /** Directory holding the `.service` files (normally `infra/systemd`). */
  unitDir: string;
  /**
   * Where a unit's `EnvironmentFile=` path resolves to. The deployed units name
   * absolute host paths (`/opt/N409/.env`), so a check run from anywhere but the
   * host has to redirect them; the CLI passes `--env-file` through here.
   */
  resolveEnvFile?: (declared: string) => string;
  /** Reads a file; injectable so the unit tests need no fixtures on disk. */
  readFile?: (file: string) => string;
  /** File mode of the env file, for the permissions check. */
  statFile?: (file: string) => number | null;
  /**
   * Every directory `infra/install-units.sh` installs from — `infra/systemd`
   * *and* `infra/backup`. Defaults to `[unitDir]`, which is what a caller that
   * only knows about the services wants; the deploy passes both.
   *
   * Separate from `unitDir` because the two checks have genuinely different
   * scopes and pretending otherwise would be worse than either. The environment
   * guards above are about what a service reads at boot, and the backup pair
   * reads a second file, `/etc/n409/backup-verify.env`, which is deliberately
   * mode 0640 root:n409 so the service user can read a credential root owns —
   * a shape the `.env` permission rule is right to reject and right not to be
   * applied to. The memory rules have no such asymmetry: every unit installed
   * on this host shares its RAM with every other one, so the resource sweep
   * covers the whole install set.
   */
  installDirs?: string[];
  /**
   * Physical memory of the host the units will boot on. Defaults to
   * `os.totalmem()`, which is the right answer when this runs where it is meant
   * to — on the host, from the deploy, before anything is restarted.
   */
  hostTotalBytes?: number;
  /** Lists `unitDir`; injectable so the unit tests need no fixtures on disk. */
  readDir?: (dir: string) => string[];
  /**
   * Environment the units inherit. Empty by default and deliberately NOT
   * `process.env`: the deploy runs this from a shell whose variables the
   * services never see, and inheriting them would let a value that exists only
   * in the deployer's session satisfy a guard.
   */
  baseEnv?: Record<string, string | undefined>;
}

/**
 * Run every unit's guards against the environment it would actually boot with.
 *
 * Each guard runs twice, once under each precedence reading of
 * `Environment=` vs `EnvironmentFile=` (see {@link mergeEnvSources}), and a
 * fault raised by either reading is reported. A deployment that is only valid
 * under one of the two readings is not a deployment anyone should have to reason
 * about.
 */
export function preflight(options: PreflightOptions): PreflightResult {
  const read = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  const stat =
    options.statFile ??
    ((file: string) => {
      try {
        return statSync(file).mode;
      } catch {
        return null;
      }
    });
  const resolve = options.resolveEnvFile ?? ((declared: string) => declared);
  const list =
    options.readDir ??
    ((dir: string) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    });
  const faults: PreflightFault[] = [];
  const units: string[] = [];
  /** Env files already reported on, so one shared `.env` is not reported five times. */
  const reportedFiles = new Set<string>();

  for (const unitName of KNOWN_UNITS) {
    const unitPath = path.join(options.unitDir, unitName);
    let unitText: string;
    try {
      unitText = read(unitPath);
    } catch {
      faults.push({ scope: unitName, message: `unit file is missing at ${unitPath}` });
      continue;
    }
    units.push(unitName);
    const unit = parseUnitFile(unitText);

    const fileVars = new Map<string, string>();
    for (const declared of unit.environmentFiles) {
      const resolved = resolve(declared.path);
      let text: string;
      try {
        text = read(resolved);
      } catch {
        if (!declared.optional) {
          faults.push({
            scope: unitName,
            message:
              `EnvironmentFile=${declared.path} could not be read (looked at ${resolved}) — systemd fails ` +
              'the unit when a non-optional environment file is missing',
          });
        }
        continue;
      }
      const parsed = parseEnvironmentFile(text);
      if (!reportedFiles.has(resolved)) {
        reportedFiles.add(resolved);
        for (const problem of parsed.problems) {
          faults.push({
            scope: path.basename(declared.path),
            message: `line ${problem.line}: ${problem.message}`,
          });
        }
        const mode = stat(resolved);
        // The file holds JWT_SECRET, DATABASE_URL credentials and every OAuth
        // client secret in the estate. Group- or world-readable, it is those
        // secrets shared with every account on the box.
        if (mode !== null && (mode & 0o077) !== 0) {
          faults.push({
            scope: path.basename(declared.path),
            message:
              `is mode ${(mode & 0o777).toString(8).padStart(3, '0')} — it holds JWT_SECRET, the database ` +
              'credentials and every OAuth client secret, and is readable beyond its owner. `chmod 600` it.',
          });
        }

        // A feature flag set to something no parser recognises.
        //
        // Reported here — once per env file, alongside the parse problems and
        // the mode check — rather than in a per-unit guard, because the flags
        // are declared centrally and read by units on both sides of the
        // language split: `FLAG_BACKUP_VERIFICATION` is consumed by a shell
        // script, and a guard keyed on a systemd unit name would never see it.
        //
        // Worth failing a deploy over precisely because the runtime *cannot*
        // fail: `flagEnabled` falls back to the default rather than throwing on
        // the request path, so `FLAG_CIRCUIT_BREAKERS=disable` leaves the
        // breakers on and reports nothing. Without this line the operator's
        // typo is invisible until they notice the switch they threw did
        // nothing — which, given when these switches get thrown, is mid-incident.
        for (const problem of flagProblems(Object.fromEntries(parsed.vars))) {
          faults.push({ scope: path.basename(declared.path), message: problem });
        }
      }
      for (const [name, value] of parsed.vars) fileVars.set(name, value);
    }

    const merged = mergeEnvSources(unit.environment, fileVars, options.baseEnv ?? {});
    for (const conflict of merged.conflicts) {
      faults.push({
        scope: unitName,
        message:
          `${conflict.name} is set to "${conflict.unitValue}" by the unit and "${conflict.fileValue}" by its ` +
          'EnvironmentFile — which one the service boots with depends on a systemd precedence rule that is ' +
          'not visible from either file. Set it in one place.',
      });
    }

    const guard = GUARDS[unitName]!;
    const seen = new Set<string>();
    for (const env of [merged.unitWins, merged.fileWins]) {
      // The posture check runs alongside the guard, under the same
      // both-precedences loop and the same dedupe, because a marker set in one
      // source and not the other is exactly the ambiguity this loop exists for.
      for (const message of [...declaresProduction(env, unitName), ...guard(env)]) {
        if (seen.has(message)) continue;
        seen.add(message);
        faults.push({ scope: unitName, message });
      }
    }
  }

  // ── Units on disk that this checker has never heard of ──────────────────
  //
  // Everything above iterates KNOWN_UNITS, which is `Object.keys(GUARDS)` — the
  // checker's own list. So a sixth unit file added to `infra/systemd/` is
  // installed onto the host by `infra/install-units.sh` like every other one,
  // started by systemd like every other one, and validated by nothing; and the
  // CLI goes on printing "5 unit(s) validated, no configuration faults", which
  // reads like coverage rather than like the gap it is.
  //
  // That is the same vacuity as a unit that forgets to declare production, one
  // level up: a check whose scope is a hardcoded list silently narrows to
  // nothing the moment reality grows past it. Stated positively here too — the
  // directory is the estate, and a member of it with no guard is a fault, which
  // is answered either by giving it one or by not shipping it in this
  // directory.
  const known = new Set(KNOWN_UNITS);
  for (const entry of list(options.unitDir).sort()) {
    if (!entry.endsWith('.service')) continue;
    if (known.has(entry)) continue;
    faults.push({
      scope: entry,
      message:
        `is in ${options.unitDir} and has no guard in this checker — deploy.sh installs every unit in ` +
        'that directory and restarts it, so this one boots unvalidated while the summary line still ' +
        'reports every unit as checked. Add it to GUARDS in preflight.ts, or keep it out of this directory.',
    });
  }

  // ── Memory ceilings, over everything install-units.sh installs ──────────
  //
  // THE GAP THIS CLOSES: until round 99 no unit in this estate set a
  // `MemoryMax`, which was harmless while every process was small and flat, and
  // stopped being harmless the moment round 98 made one of them a function of
  // load. Without a per-unit limit the answer to a leak is the kernel's global
  // OOM killer, which chooses by resident size rather than by blame — and on
  // 204.168.241.124 the two largest processes are an unrelated product and
  // PostgreSQL. A memory bug in the report renderer would have taken the
  // database down and left the renderer running.
  //
  // Checked here rather than in a script of its own because this is the one
  // place in the deploy where a "no" is cheap: it runs after the build, before
  // the first restart, and a fault leaves the previous release serving.
  for (const message of memoryFaults(options, read, list)) faults.push(message);

  return { faults, units };
}

/**
 * The floor a unit's `MemoryMax` has to clear, for the units whose working set
 * is a function of something this repo controls.
 *
 * Only the report service qualifies, and it qualifies because of round 98: its
 * memory is `idle + concurrent renders x per-render cost`, and the concurrency
 * is not the operating system's business or the operator's — it is two
 * constants in `clients/reportRender.ts`. Recomputing the floor from those
 * constants is what stops the two files drifting: raise `MAX_DELEGATED_QUEUED`
 * to 100 and this fails the deploy, rather than the host discovering it.
 *
 * Every other unit is sized from a measurement, and a measurement cannot be
 * recomputed from source. Those are pinned by the unit file's own comment and
 * by `systemdResources.test.ts`, not from here.
 */
const MODELLED_FLOORS: Record<string, () => { bytes: number; why: string }> = {
  'n409-report.service': () => ({
    bytes: modelledRenderCeilingBytes(),
    why:
      'MAX_DELEGATED_IN_FLIGHT + MAX_DELEGATED_QUEUED renders can be resident at once, at the idle size ' +
      'and per-render cost measured in round 98 (clients/reportRender.ts)',
  }),
};

/**
 * Every `.service` in the install set must declare a bounded ceiling, and the
 * ceilings together must fit the host.
 *
 * Separate from the loop above and deliberately so: that one iterates
 * `KNOWN_UNITS`, a hardcoded list, and this one iterates the directories the
 * installer actually reads. A limit that only covered the list would miss the
 * two backup units — which is not hypothetical, it is where they were before
 * this function existed: installed by `install-units.sh` onto the same host,
 * validated by nothing.
 */
function memoryFaults(
  options: PreflightOptions,
  read: (file: string) => string,
  list: (dir: string) => string[],
): PreflightFault[] {
  const faults: PreflightFault[] = [];
  const dirs = options.installDirs ?? [options.unitDir];
  const ceilings: UnitCeiling[] = [];
  // A unit named by two directories is one unit on the host and must be counted
  // once, or the estate sum double-counts its ceiling and fails a deploy over
  // memory nothing will ever hold.
  const seen = new Set<string>();

  for (const dir of dirs) {
    for (const entry of list(dir).sort()) {
      if (!entry.endsWith('.service')) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      let text: string;
      try {
        text = read(path.join(dir, entry));
      } catch {
        // A unit missing from a directory it was listed in is a race or a
        // permission problem, not a memory fault. The env loop above already
        // reports an unreadable unit for the services it knows; saying it twice
        // here in different words would not help anyone.
        continue;
      }
      const resources = parseUnitMemory(text);
      ceilings.push({ unit: entry, resources });
      for (const message of memoryLimitFaults(resources)) faults.push({ scope: entry, message });

      const floor = MODELLED_FLOORS[entry]?.();
      const declared = resources.max?.bytes ?? null;
      if (floor && declared !== null && declared < floor.bytes) {
        faults.push({
          scope: entry,
          message:
            `MemoryMax=${resources.max!.raw} is below the ${formatBytes(floor.bytes)} this service is ` +
            `designed to be able to hold — ${floor.why}. Either raise the limit or lower the bound; ` +
            'leaving them disagreeing means the service is killed by its own design at full load.',
        });
      }
    }
  }

  if (ceilings.length === 0) return faults;
  const total = options.hostTotalBytes ?? totalmem();
  for (const message of estateCeilingFaults(estateCeiling(ceilings), total)) {
    faults.push({ scope: 'estate', message });
  }
  return faults;
}

/** One line per fault, plus a headline. Empty string when there are none. */
export function formatFaults(result: PreflightResult): string {
  if (result.faults.length === 0) return '';
  const lines = result.faults.map((f) => `  ${f.scope}: ${f.message}`);
  const count = result.faults.length;
  return `${count} configuration fault${count === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}
