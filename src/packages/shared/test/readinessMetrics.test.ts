import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { MetricsRegistry } from '../src/prometheus.js';
import { READINESS_METRIC_MAX_AGE_MS, registerHealth, registerReadinessMetrics } from '../src/health.js';

/**
 * The readiness verdict, published where the alerting actually looks (R405,
 * methodology M11).
 *
 * `/ready` is a claim about whether this instance can serve, and on this estate
 * it is made to nobody: `deploy.sh` polls it once per restart and nothing polls
 * it afterwards — there is no load balancer on the box, and
 * `infra/monitoring/alerts.yml` describes a scraper that reads `/metrics` and
 * only `/metrics`. `ServiceDown`, the availability rule, fires on `up == 0` —
 * a missed scrape — and `/metrics` is rendered out of process memory and
 * touches no dependency, so a unit whose Postgres has gone answers every scrape
 * in full with a complete set of healthy-looking numbers while its own
 * readiness verdict has said `unavailable` for a week.
 */

function harness(checks: {
  required?: Record<string, () => Promise<void>>;
  optional?: Record<string, () => Promise<void>>;
}) {
  const app = Fastify({ logger: false });
  const readiness = registerHealth(app, {
    service: 'test-svc',
    checks: checks.required,
    optional: checks.optional,
    // The coalescing window is about bursts of probes; these tests drive the
    // verdict directly and must not read a cached one.
    readyCacheMs: 0,
  });
  const metrics = new MetricsRegistry();
  registerReadinessMetrics(metrics, readiness);
  return { app, readiness, metrics };
}

const ok = async () => {};
const fails = (why: string) => async () => {
  throw new Error(why);
};

/** Wait for the background refresh a `collect` asked for to land. */
async function settled(readiness: { verdict: () => unknown }): Promise<void> {
  for (let i = 0; i < 50 && readiness.verdict() === null; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the readiness verdict on the scrape endpoint', () => {
  it('says nothing at all until something has looked', async () => {
    const { app, metrics } = harness({ required: { postgres: ok } });
    // A `service_ready` of 1 here would be a claim made before any check ran,
    // and a 0 would fire on every restart. An absent series is what "nothing
    // has looked yet" reads as; `service_readiness_age_seconds` is the reading
    // that stops it staying absent unnoticed.
    const first = metrics.render();
    expect(first).not.toMatch(/^service_ready /m);
    expect(first).not.toMatch(/^service_dependency_up\{/m);
    expect(first).not.toMatch(/^service_readiness_age_seconds /m);
    await app.close();
  });

  it('publishes the gating verdict a scrape asked for', async () => {
    const { app, readiness, metrics } = harness({ required: { postgres: ok, fonts: ok } });
    metrics.render();
    await settled(readiness);

    const body = metrics.render();
    expect(body).toMatch(/^service_ready 1$/m);
    expect(body).toMatch(/^service_dependency_up\{dependency="postgres",required="true"\} 1$/m);
    expect(body).toMatch(/^service_dependency_up\{dependency="fonts",required="true"\} 1$/m);
    expect(body).toMatch(/^service_readiness_age_seconds /m);
    await app.close();
  });

  it('reports 0 for a service that has said it cannot serve, and names the check', async () => {
    // The whole point: this process answers its scrape in full — `up` is 1 and
    // every other number is healthy — while `/ready` is a 503. Before this
    // metric existed that difference reached no rule at all.
    const { app, readiness, metrics } = harness({
      required: { postgres: fails('connection refused'), fonts: ok },
    });
    metrics.render();
    await settled(readiness);

    const body = metrics.render();
    expect(body).toMatch(/^service_ready 0$/m);
    expect(body).toMatch(/^service_dependency_up\{dependency="postgres",required="true"\} 0$/m);
    expect(body).toMatch(/^service_dependency_up\{dependency="fonts",required="true"\} 1$/m);
    await app.close();
  });

  it('keeps a degraded optional dependency off the gating verdict but on the scrape', async () => {
    // `OptionalDependencyDown` is a ticket and `ServiceNotReady` is a page, and
    // the `required` label is the only thing that keeps them apart. An optional
    // dependency must never move `service_ready`: the service is designed to
    // serve without it, and paging over one is the readiness check that
    // manufactures the outage it reports.
    const { app, readiness, metrics } = harness({
      required: { postgres: ok },
      optional: { ai: fails('ai unreachable'), engine: ok },
    });
    metrics.render();
    await settled(readiness);

    const body = metrics.render();
    expect(body).toMatch(/^service_ready 1$/m);
    expect(body).toMatch(/^service_dependency_up\{dependency="ai",required="false"\} 0$/m);
    expect(body).toMatch(/^service_dependency_up\{dependency="engine",required="false"\} 1$/m);
    await app.close();
  });

  it('never puts the scrubbed failure reason on the scrape', async () => {
    // `/ready` withholds the reason from an unauthenticated caller because it
    // describes the inside of the estate. A label value carrying the same text
    // would publish it to every scrape, unbounded in cardinality on top —
    // the reason belongs in the journal and the token-gated body.
    const { app, readiness, metrics } = harness({
      required: { postgres: fails('valuation unreachable at http://127.0.0.1:3001/ready: ECONNREFUSED') },
    });
    metrics.render();
    await settled(readiness);

    const body = metrics.render();
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('127.0.0.1');
    await app.close();
  });

  it('ages the verdict rather than freezing it at the last good reading', async () => {
    // A verdict frozen at the last successful run reads exactly like a current
    // one, which is the failure this whole file is against, one level up.
    const { app, readiness, metrics } = harness({ required: { postgres: ok } });
    metrics.render();
    await settled(readiness);

    const age = () => Number(/^service_readiness_age_seconds (\S+)$/m.exec(metrics.render())![1]);
    const first = age();
    await new Promise((r) => setTimeout(r, 30));
    expect(age()).toBeGreaterThanOrEqual(first);
    // And well inside the window a scrape refreshes on, so this reading is the
    // age of the verdict rather than the age of the process.
    expect(age()).toBeLessThan(READINESS_METRIC_MAX_AGE_MS / 1000);
    await app.close();
  });

  it('collapses concurrent scrapes onto one fan-out', async () => {
    // `collect` is synchronous and the checks are network-bound, so the refresh
    // is fire-and-forget — which makes overlapping scrapes a way to multiply
    // the fan-out against the dependency readiness itself depends on.
    let runs = 0;
    const slow = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
    };
    const { app, readiness, metrics } = harness({ required: { postgres: slow } });
    metrics.render();
    metrics.render();
    metrics.render();
    await settled(readiness);
    expect(runs).toBe(1);

    // And a scrape inside the freshness window does not start another.
    metrics.render();
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(1);
    await app.close();
  });
});
