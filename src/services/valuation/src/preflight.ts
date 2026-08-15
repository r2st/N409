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
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { flagProblems, listenPort, mergeEnvSources, parseEnvironmentFile, parseUnitFile } from '@n409/shared';
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
  'n409-report.service': (env) => [
    ...requiresInternalToken(env, 'NODE_ENV', 'report'),
    ...bindsAPort(env),
  ],
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
      for (const message of guard(env)) {
        if (seen.has(message)) continue;
        seen.add(message);
        faults.push({ scope: unitName, message });
      }
    }
  }

  return { faults, units };
}

/** One line per fault, plus a headline. Empty string when there are none. */
export function formatFaults(result: PreflightResult): string {
  if (result.faults.length === 0) return '';
  const lines = result.faults.map((f) => `  ${f.scope}: ${f.message}`);
  const count = result.faults.length;
  return `${count} configuration fault${count === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}
