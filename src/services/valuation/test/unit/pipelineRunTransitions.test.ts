import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIPELINE_RUN_STATUSES,
  PIPELINE_RUN_TRANSITIONS,
  canTransitionPipelineRun,
  type PipelineRunStatus,
} from '../../src/repos/pipelineRuns.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('pipeline run transition table', () => {
  it('gives every status a row, and every edge a valid destination', () => {
    const known = new Set<string>(PIPELINE_RUN_STATUSES);
    expect(Object.keys(PIPELINE_RUN_TRANSITIONS).sort()).toEqual([...PIPELINE_RUN_STATUSES].sort());
    for (const from of PIPELINE_RUN_STATUSES) {
      for (const to of PIPELINE_RUN_TRANSITIONS[from]) {
        expect(known.has(to), `${from} → ${to} names a status that does not exist`).toBe(true);
      }
    }
  });

  it('has no self-edges', () => {
    for (const from of PIPELINE_RUN_STATUSES) {
      expect(PIPELINE_RUN_TRANSITIONS[from], `${from} has a self-edge`).not.toContain(from);
    }
  });

  it('makes ready and failed terminal', () => {
    const terminal = PIPELINE_RUN_STATUSES.filter((s) => PIPELINE_RUN_TRANSITIONS[s].length === 0);
    expect(terminal.sort()).toEqual(['failed', 'ready']);
  });

  it('enforces forward-only progression', () => {
    expect(canTransitionPipelineRun('queued', 'extracting')).toBe(true);
    expect(canTransitionPipelineRun('extracting', 'calculating')).toBe(true);
    expect(canTransitionPipelineRun('calculating', 'ready')).toBe(true);

    expect(canTransitionPipelineRun('calculating', 'extracting'), 'backward: calculating → extracting').toBe(
      false,
    );
    expect(canTransitionPipelineRun('extracting', 'queued'), 'backward: extracting → queued').toBe(false);
    expect(canTransitionPipelineRun('calculating', 'queued'), 'backward: calculating → queued').toBe(false);
    expect(canTransitionPipelineRun('queued', 'ready'), 'skip: queued → ready').toBe(false);
    expect(canTransitionPipelineRun('queued', 'calculating'), 'skip: queued → calculating').toBe(false);
    expect(canTransitionPipelineRun('extracting', 'ready'), 'skip: extracting → ready').toBe(false);
  });

  it('allows failure from any active status', () => {
    for (const status of ['queued', 'extracting', 'calculating'] as PipelineRunStatus[]) {
      expect(canTransitionPipelineRun(status, 'failed'), `${status} → failed`).toBe(true);
    }
  });

  it('refuses resurrection from terminal states', () => {
    for (const to of PIPELINE_RUN_STATUSES) {
      if (to === 'ready' || to === 'failed') continue;
      expect(canTransitionPipelineRun('ready', to), `ready → ${to}`).toBe(false);
      expect(canTransitionPipelineRun('failed', to), `failed → ${to}`).toBe(false);
    }
  });

  it('setPipelineRunStatus enforces transition table', () => {
    const src = readFileSync(join(here, '../../src/repos/pipelineRuns.ts'), 'utf8');
    expect(src, 'setPipelineRunStatus must call canTransitionPipelineRun').toMatch(
      /canTransitionPipelineRun\(run\.status/,
    );
  });
});
