"""
Container healthcheck probe.

Run as `python -m app.healthcheck`: exits 0 when the service answers /health
with 200, and 1 for every other outcome. Docker's HEALTHCHECK reads the exit
code and nothing else, so the whole contract is that code.

This is a module rather than a `python -c` one-liner because the obvious
one-liner is wrong in two ways that both read as working:

  python -c "... sys.exit(0 if urlopen(url).status == 200 else 1)"

`urlopen` raises rather than returns on a refused connection *and* on every
non-2xx response, so the `.status == 200` comparison is dead code — the only
paths that reach it are the ones that were already going to pass. What makes
the container show unhealthy is the uncaught exception's exit code, which is
also 1, so the bug is invisible: it prints a traceback into the health log on
every probe of a service that is merely still starting up, and it would report
exactly the same for a service answering 503 as for one that is not listening.
Those are different operational facts.

It also passes an explicit timeout. `urlopen` defaults to the global socket
timeout, which is None — a probe against a wedged socket blocks forever, and
the only thing that stops it is Docker's own `--timeout`, which kills the
process without ever recording *why*.
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request

# Under Docker's default `--timeout=5s`; the probe should lose on its own terms
# and print a reason, not be killed by the supervisor with nothing in the log.
TIMEOUT_S = 4.0


def probe(port: str | None = None, timeout: float = TIMEOUT_S) -> int:
    """Returns the exit code: 0 if /health answered 200, 1 otherwise."""
    # 127.0.0.1 is correct under both the image default (HOST=127.0.0.1) and the
    # compose override (HOST=0.0.0.0) — binding all interfaces includes loopback.
    port = port or os.environ.get("PORT") or ""
    if not port.strip():
        print("healthcheck: PORT is unset", file=sys.stderr)
        return 1
    url = f"http://127.0.0.1:{port.strip()}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            status = response.status
    except urllib.error.HTTPError as err:
        # The service is listening and said no. Worth distinguishing in the log
        # from "nothing is listening" — a 503 here is a started-but-degraded
        # service, which is a different thing to go and look at.
        print(f"healthcheck: {url} answered {err.code}", file=sys.stderr)
        return 1
    except Exception as err:  # URLError, socket timeout, anything else
        print(f"healthcheck: {url} unreachable: {err}", file=sys.stderr)
        return 1
    if status != 200:
        print(f"healthcheck: {url} answered {status}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised via probe()
    sys.exit(probe())
