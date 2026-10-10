// HEALTHCHECK on the shipped images (round 158).
//
// All five services declared a healthcheck in docker-compose.yml and none of
// them declared one in the Dockerfile. That reads as covered and is not: a
// compose healthcheck belongs to the compose file, so it applies to exactly one
// way of starting the image. CI builds all five images (.github/workflows/ci.yml
// `docker` job) and anything that runs one of those images without compose —
// `docker run`, a plain scheduler, a registry's own probe — got no health signal
// at all, which means the container reports healthy from the instant the
// process forks. Two things follow, and both are silent: traffic is routed to a
// valuation container still running migrations, and a process that has stopped
// answering is never restarted, because nothing ever asks it.
//
// So the Dockerfile is the floor and compose is the override. This asserts the
// floor exists on every image and that both files agree about which port and
// path is the health signal.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVICES_DIR = path.join(repoRoot, 'src/services');

interface ServiceImage {
  service: string;
  file: string;
  text: string;
}

/**
 * Every service that ships a Dockerfile.
 *
 * Discovered rather than listed, for the usual reason: a hardcoded list is a
 * list somebody has to remember to extend, and the failure mode of forgetting
 * is a new image with no health signal that this file reports as fine.
 */
function serviceImages(): ServiceImage[] {
  const out: ServiceImage[] = [];
  for (const service of readdirSync(SERVICES_DIR).sort()) {
    const file = path.join(SERVICES_DIR, service, 'Dockerfile');
    if (!existsSync(file)) continue;
    out.push({ service, file, text: readFileSync(file, 'utf8') });
  }
  return out;
}

/** The HEALTHCHECK instruction, line continuations joined. */
function healthcheckOf(text: string): string | null {
  const joined = text.replace(/\\\r?\n\s*/g, ' ');
  for (const line of joined.split('\n')) {
    const trimmed = line.trim();
    if (/^HEALTHCHECK\b/i.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * The probe's actual implementation, wherever it lives.
 *
 * The Node images carry theirs inline in the HEALTHCHECK line; the Python ones
 * run `python -m app.healthcheck`, so the substance is in that module and the
 * instruction says almost nothing. The rules below — probes /health, resolves
 * the port at run time, targets loopback — are properties of the *probe*, not
 * of the line that invokes it, so they have to be read from whichever file
 * actually holds it. Asserted against the instruction alone, the module form
 * would fail every one of them while being strictly the better implementation.
 */
function probeSourceOf(image: ServiceImage): string {
  const hc = healthcheckOf(image.text) ?? '';
  const asModule = /python -m ([\w.]+)/.exec(hc);
  if (!asModule) return hc;
  const modulePath = path.join(SERVICES_DIR, image.service, `${asModule[1]!.replace(/\./g, '/')}.py`);
  // Read, not existsSync-guarded: a HEALTHCHECK naming a module that is not in
  // the image is a broken probe, and the throw says which one.
  return `${hc}\n${readFileSync(modulePath, 'utf8')}`;
}

describe('shipped images', () => {
  it('finds the five service Dockerfiles', () => {
    // web-frontend is a build-time bundle with no server of its own, so it has
    // no Dockerfile and is not expected here.
    expect(serviceImages().map((i) => i.service)).toEqual([
      'ai',
      'engine-wrapper',
      'report',
      'valuation',
      'web',
    ]);
  });

  it('declares a HEALTHCHECK on every one', () => {
    for (const { service, text } of serviceImages()) {
      expect([service, healthcheckOf(text) !== null]).toEqual([service, true]);
    }
  });

  it('gives every HEALTHCHECK an interval, a timeout, a start period and retries', () => {
    // A bare `HEALTHCHECK CMD ...` inherits 30s/30s/3 and *no* start period,
    // which fails a valuation container three times over while it is still
    // applying migrations and marks a perfectly healthy image unhealthy.
    for (const { service, text } of serviceImages()) {
      const hc = healthcheckOf(text) ?? '';
      for (const flag of ['--interval=', '--timeout=', '--start-period=', '--retries=']) {
        expect([service, flag, hc.includes(flag)]).toEqual([service, flag, true]);
      }
    }
  });

  it('keeps every probe inside its own timeout budget', () => {
    // The probe has to lose on its own terms and say why. One killed by Docker
    // for overrunning --timeout leaves nothing in the health log.
    for (const { service, text } of serviceImages()) {
      const hc = healthcheckOf(text) ?? '';
      const timeout = /--timeout=(\d+)s/.exec(hc);
      const interval = /--interval=(\d+)s/.exec(hc);
      expect([service, timeout !== null]).toEqual([service, true]);
      // A timeout at or above the interval means probes overlap: the next one
      // starts before the last has given up, and a wedged service accumulates
      // probe processes rather than being restarted.
      expect([service, Number(timeout![1]) < Number(interval![1])]).toEqual([service, true]);
    }
  });

  it('probes /health rather than the root path', () => {
    // `/` on the BFF is the SPA, which is served from disk and answers 200 long
    // after the API behind it has stopped working.
    for (const image of serviceImages()) {
      expect([image.service, probeSourceOf(image).includes('/health')]).toEqual([image.service, true]);
    }
  });

  it('resolves the port at run time, not at build time', () => {
    // Shell form and $PORT: an image started on a remapped port has to probe
    // the port it actually bound. A hardcoded one probes a port nothing is
    // listening on and reports a healthy service as unhealthy forever.
    for (const image of serviceImages()) {
      expect([image.service, /PORT/.test(probeSourceOf(image))]).toEqual([image.service, true]);
    }
  });

  it('probes loopback, which is right under either bind address', () => {
    // The images default to HOST=127.0.0.1 and compose overrides HOST=0.0.0.0.
    // 127.0.0.1 is correct in both cases; 0.0.0.0 is not a destination address
    // and would be wrong in the first.
    for (const image of serviceImages()) {
      expect([image.service, probeSourceOf(image).includes('127.0.0.1')]).toEqual([image.service, true]);
    }
  });

  it('runs the Python probe as a module rather than an inline one-liner', () => {
    // See app/healthcheck.py: the obvious `python -c "... urlopen(url).status
    // == 200 ..."` never evaluates its own comparison, because urlopen raises
    // on refusal and on every non-2xx. What marks the container unhealthy is an
    // uncaught traceback, and it cannot distinguish "nothing listening" from
    // "answering 503".
    for (const service of ['ai', 'engine-wrapper']) {
      const image = serviceImages().find((i) => i.service === service)!;
      const hc = healthcheckOf(image.text) ?? '';
      expect([service, hc.includes('python -m app.healthcheck')]).toEqual([service, true]);
      expect([service, hc.includes('urlopen')]).toEqual([service, false]);
    }
  });
});

describe('docker-compose healthchecks', () => {
  const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');

  it('no longer carries the inline urlopen one-liner', () => {
    // Same bug as the Dockerfile would have had, in the file that was actually
    // being used. Both Python services shipped it.
    expect(compose).not.toContain('urllib.request.urlopen');
  });

  it('uses the same probe module the image does', () => {
    const uses = compose.split('\n').filter((l) => l.includes('app.healthcheck'));
    expect(uses).toHaveLength(2);
  });
});

describe('docker-compose stop_grace_period', () => {
  const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');

  /**
   * Extracts the `stop_grace_period` for each application service in the
   * compose file. Infrastructure services (postgres, redis) are excluded — they
   * have their own shutdown semantics and are not ours to bound.
   */
  function appServiceGracePeriods(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const appServices = ['valuation', 'web', 'ai', 'engine-wrapper', 'report'];
    let currentService: string | null = null;
    let indent = 0;

    for (const line of compose.split('\n')) {
      // Top-level service definition: exactly two spaces of indent, a name, and
      // a colon. Deeper lines belong to the current service.
      const svcMatch = /^  (\S+):/.exec(line);
      if (svcMatch && !/^\s{4,}/.test(line)) {
        currentService = appServices.includes(svcMatch[1]!) ? svcMatch[1]! : null;
        if (currentService && !out.has(currentService)) out.set(currentService, null);
        indent = 2;
        continue;
      }
      if (currentService === null) continue;
      // A line at the service's own indent that sets stop_grace_period.
      const graceMatch = /^\s+stop_grace_period:\s*(.+)/.exec(line);
      if (graceMatch) out.set(currentService, graceMatch[1]!.trim());
    }
    return out;
  }

  /** Parse a Docker duration string (e.g. "30s", "1m30s") into seconds. */
  function parseDockerDuration(raw: string): number {
    let total = 0;
    const minMatch = /(\d+)m(?!s)/.exec(raw);
    if (minMatch) total += Number(minMatch[1]) * 60;
    const secMatch = /(\d+)s/.exec(raw);
    if (secMatch) total += Number(secMatch[1]);
    return total || Number(raw);
  }

  it('is set on every application service', () => {
    // Docker's default is 10s. The Python services use --timeout-graceful-
    // shutdown 15, so a `docker compose down` would SIGKILL them at 10s —
    // before their own graceful path finishes. The exact race the systemd units
    // fixed with TimeoutStopSec=30, reproduced here in a different supervisor.
    const periods = appServiceGracePeriods();
    expect(periods.size).toBe(5);
    for (const [service, grace] of periods) {
      expect([service, grace !== null]).toEqual([service, true]);
    }
  });

  it('clears the application grace period on every service', () => {
    // The rule is the same one systemdShutdown.ts enforces: the supervisor must
    // give up *after* the application does, so a clean shutdown is never pre-
    // empted by a SIGKILL. The Node services exit within DEFAULT_SHUTDOWN_
    // GRACE_MS (10s); the Python ones within --timeout-graceful-shutdown (15s).
    const periods = appServiceGracePeriods();
    for (const [service, raw] of periods) {
      const seconds = parseDockerDuration(raw!);
      // Must be above both the Node grace (10s) and the uvicorn grace (15s).
      expect(seconds, `${service}: stop_grace_period=${raw} is not above 15s`).toBeGreaterThan(15);
    }
  });
});
