"""Build provenance: which commit is actually running.

The Python half of ``src/packages/shared/src/build.ts``, and the same argument.
``dist/`` is gitignored and the deploy builds on the server, so "what is live"
is not answerable from outside the box — you have to SSH in and read
``git rev-parse HEAD``, which tells you what was *fetched*, not what the
service is *running*. A restart that silently did not take, or a venv that
failed to update, looks identical to a good deploy.

The three Node services have reported this on ``/health`` since issue #4, and
``infra/deploy.sh`` verifies the two it can reach that way. The two FastAPI
services reported nothing, so they were the two the deploy restarted and never
checked. This closes that: same field names, same resolution order, so one
``curl .../health`` answers the same question of any service in the estate.

Resolution order, most explicit first:

  1. ``BUILD_SHA`` — an environment variable, for containers and CI.
  2. ``BUILD_SHA_FILE`` — an explicit path to the file the deploy wrote.
  3. ``<repo root>/BUILD_SHA``, walked up from this module. The units set a
     per-service ``WorkingDirectory``, so a relative path would not resolve.

Anything unreadable or malformed yields ``unknown`` rather than raising:
``/health`` must never be the thing that takes a service down.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import NamedTuple

#: A SHA-1 commit id, full or abbreviated — matching the TS side's SHA_RE.
_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$", re.IGNORECASE)

#: How much of the file to read. The deploy writes one line; the cap means a
#: mistyped path pointing at something huge is still cheap.
_MAX_BYTES = 200


class BuildInfo(NamedTuple):
    #: Full commit SHA, or 'unknown' when no provenance was recorded.
    sha: str
    #: Where the SHA came from — for diagnosing a deploy that reports 'unknown'.
    source: str  # 'env' | 'file' | 'unknown'


UNKNOWN_BUILD = BuildInfo("unknown", "unknown")


def _default_build_sha_path() -> Path | None:
    """``<repo root>/BUILD_SHA``, four levels up from ``<service>/app``."""
    try:
        return Path(__file__).resolve().parents[4] / "BUILD_SHA"
    except (IndexError, OSError):  # pragma: no cover — depends on install depth
        return None


def _read_sha(path: str | Path) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read(_MAX_BYTES)
    except OSError:
        return None
    first = raw.strip().split()
    if first and _SHA_RE.match(first[0]):
        return first[0].lower()
    return None


def read_build_info(env: dict[str, str] | None = None) -> BuildInfo:
    """Resolve provenance from the environment and disk. Never raises."""
    environ = os.environ if env is None else env

    from_env = (environ.get("BUILD_SHA") or "").strip()
    if _SHA_RE.match(from_env):
        return BuildInfo(from_env.lower(), "env")

    candidates: list[str | Path] = []
    from_file = (environ.get("BUILD_SHA_FILE") or "").strip()
    if from_file:
        candidates.append(from_file)
    default = _default_build_sha_path()
    if default is not None:
        candidates.append(default)

    for candidate in candidates:
        sha = _read_sha(candidate)
        if sha is not None:
            return BuildInfo(sha, "file")
    return UNKNOWN_BUILD


_cached: BuildInfo | None = None


def build_info() -> BuildInfo:
    """Memoised for the process lifetime.

    The running build cannot change without a restart, and ``/health`` is
    polled by uptime checks — it must not touch the disk on every request.
    """
    global _cached
    if _cached is None:
        _cached = read_build_info()
    return _cached


def reset_build_info_cache() -> None:
    """Test seam — drops the memoised value."""
    global _cached
    _cached = None
