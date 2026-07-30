import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build provenance: which commit is actually running.
 *
 * `dist/` is gitignored and the deploy builds on the server, so "what is live"
 * was previously unanswerable from outside the box — you had to SSH in and read
 * `git rev-parse HEAD`, which tells you what was *fetched*, not what was
 * *built*. A skipped or half-finished build looked identical to a good one. The
 * deploy now writes the SHA it built to a file, and /health reports it, so a
 * stale deploy is visible from the outside.
 */

export interface BuildInfo {
  /** Full commit SHA, or 'unknown' when no provenance was recorded. */
  sha: string;
  /** Where the SHA came from — for diagnosing a deploy that reports 'unknown'. */
  source: 'env' | 'file' | 'unknown';
}

export const UNKNOWN_BUILD: BuildInfo = { sha: 'unknown', source: 'unknown' };

/** A SHA-1 commit id, full or abbreviated. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Resolution order, most explicit first:
 *
 *  1. `BUILD_SHA` — an environment variable, for containers and CI.
 *  2. `BUILD_SHA_FILE` — an explicit path to the file the deploy wrote.
 *  3. `<repo root>/BUILD_SHA`, derived from this module's own location. The
 *     units set `WorkingDirectory` per service, so a relative path would not
 *     resolve; this walks up from the installed package instead.
 *
 * Anything unreadable or malformed yields 'unknown' rather than throwing —
 * /health must not be the thing that takes a service down.
 */
export function readBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  opts: { defaultFile?: string } = {},
): BuildInfo {
  const fromEnv = env.BUILD_SHA?.trim();
  if (fromEnv && SHA_RE.test(fromEnv)) return { sha: fromEnv.toLowerCase(), source: 'env' };

  const candidates = [env.BUILD_SHA_FILE?.trim(), opts.defaultFile ?? defaultBuildShaPath()];
  for (const file of candidates) {
    if (!file) continue;
    try {
      // The deploy writes `git rev-parse HEAD`, so the file is one line. Cap the
      // read so a wrong path at a huge file cannot be a problem.
      const raw = readFileSync(file, 'utf8').slice(0, 200).trim().split(/\s+/)[0] ?? '';
      if (SHA_RE.test(raw)) return { sha: raw.toLowerCase(), source: 'file' };
    } catch {
      // Missing or unreadable: fall through to the next candidate.
    }
  }
  return UNKNOWN_BUILD;
}

/** `<repo root>/BUILD_SHA`, four levels up from `src/packages/shared/dist`. */
function defaultBuildShaPath(): string | undefined {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', 'BUILD_SHA');
  } catch {
    return undefined;
  }
}

let cached: BuildInfo | undefined;

/**
 * Memoised for the process lifetime: the running build cannot change without a
 * restart, and /health is polled by uptime checks — it must not touch the disk
 * on every request.
 */
export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo();
  return cached;
}

/** Test seam — drops the memoised value. */
export function resetBuildInfoCache(): void {
  cached = undefined;
}
