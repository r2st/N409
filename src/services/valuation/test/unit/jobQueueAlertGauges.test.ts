import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOB_SOURCES } from '../../src/domain/jobQueue.js';
import { JOB_ALERT_RULE_STATES } from '../../src/hooks/jobAlerts.js';

/**
 * The two job-queue gauges, held to the shape that makes them readable (R329).
 *
 * `job_queue_alert_open` is the job monitor's verdict per queue, and R321 put
 * it there because the verdict reached an in-app notification list, the admin
 * trail and the journal — three channels, none of them on-call. What it could
 * not say is whether the monitor was in a position to reach a verdict at all: a
 * queue with no *enabled rule* produces no findings, so it published the same
 * confident 0 per kind that a healthy watched queue does, and
 * `JobQueueAlertOpen` could never fire for it again.
 *
 * The composition root is where these are wired, so this is a source census —
 * the same instrument `scheduledSweepRoster` uses on the sweeps next door. The
 * behaviour underneath it is pinned in `integration/jobAlerts.test.ts`.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.resolve(HERE, '../../src/index.ts'), 'utf8');

/** The body of one `app.metrics.gauge('name', …)` call, paren-balanced. */
function gaugeCall(name: string): string {
  const at = INDEX.indexOf(`app.metrics.gauge(\n  '${name}'`);
  expect(at, `${name} is registered in index.ts`).toBeGreaterThan(-1);
  const open = INDEX.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '(') depth++;
    else if (INDEX[i] === ')' && --depth === 0) return INDEX.slice(open, i);
  }
  throw new Error(`unbalanced gauge call for ${name}`);
}

describe('the job-queue alert gauges', () => {
  it('publishes the open verdict only for queues something is actually watching', () => {
    // Not a 0 for a queue nobody is judging. The filter is the whole fix: with
    // it, "no alert here" and "nothing is looking here" are two different
    // readings instead of the same one.
    const open = gaugeCall('job_queue_alert_open');
    expect(open).toContain('jobAlertRuleStates()');
    expect(open).toMatch(/states\[source\] === 'enabled'/);
  });

  it('publishes the reason a queue is missing from it', () => {
    // Leaving a series out is only honest when something else says why —
    // otherwise it is the absent series R321 argued against, which reads
    // exactly like a healthy scrape.
    const rule = gaugeCall('job_queue_alert_rule');
    expect(rule).toContain('JOB_ALERT_RULE_STATES');
    expect(rule).toContain('labels: { source, state }');
  });

  it('reports nothing at all before the first scan, on both', () => {
    // "Nothing has looked" is not "every queue is watched", and it is not "no
    // queue is in trouble" either. A process whose job-alert sweep is switched
    // off must not publish either reassurance; whether the sweep runs is
    // `SweepStopped`'s question.
    for (const name of ['job_queue_alert_open', 'job_queue_alert_rule']) {
      expect(gaugeCall(name), name).toMatch(/=== null\) return \[\]/);
    }
  });

  it('keeps a state for every source and a source for every state', () => {
    // Non-vacuity for the census above: both vocabularies are code constants,
    // and a gauge built from an empty one publishes nothing while passing every
    // assertion about what it contains.
    expect(JOB_SOURCES.length).toBeGreaterThan(3);
    expect([...JOB_ALERT_RULE_STATES]).toEqual(['enabled', 'disabled', 'unconfigured']);
  });
});
