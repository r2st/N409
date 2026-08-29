"""Startup validation of the environment this service reads.

Every tunable here is read by a helper that falls back to a default when the
value will not parse — `limits.max_body_bytes`, `ratelimit.limit_per_minute`,
`observability.configure_logging`, `engine.market_universe.live_enabled`. That
fallback is deliberate and documented, and for a developer's laptop it is
right: one typo should not stop a service whose other twenty settings are fine.

What it does not do is tell anyone. Two things follow from that, and this module
exists for both.

The first is *when*. Each helper validates at the moment it is first called, and
those moments are scattered across the process lifetime — the body cap at
import, the threadpool inside `lifespan`, the universe switch on the first
resolution that wants the network, which may be hours in. A deploy that fat-
fingered a variable is not wrong at boot; it is wrong later, on whichever
request first reaches the helper. So the value is checked here, once, at start,
where the answer is a boot log rather than a surprise.

The second is *which way* the fallback points. `OPENROUTER_TOKEN_BUDGET` is the
example that matters: it is the ceiling on tokens this process will ever spend
against a paid key, and `_TokenBudget._cap` answers a value it cannot parse with
`0` — which that same code reads as *unlimited*. So the one variable whose whole
purpose is to bound spend, mistyped, removes the bound and logs nothing.
`AI_REQUIRE_OPENROUTER_KEY=on` is the same shape in miniature: the truthy set is
`{1, true, yes}`, so `on` is read as false and the crash-on-missing-key the
operator asked for is silently not armed. A setting whose typo lands on the less
safe side is one worth refusing.

Refusing, though, only where refusing is the safer answer. This follows
`internal_auth.enforce_token_configured` exactly: raise when `APP_ENV=production`,
warn everywhere else. A crash-looping unit is noticed; a production box quietly
running on defaults its operator did not choose is not. On a laptop the old
behaviour is unchanged — a warning, and the default.

Nothing here reads a value the service does not already read, and nothing here
changes what a *valid* setting does. Absence is still a valid configuration:
these are all optional, and an unset variable is not a problem, it is the
default. Only a variable that was set to something unusable is reported.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

_log = logging.getLogger("config_check")

APP_ENV_VAR = "APP_ENV"

#: Levels `configure_logging` can actually install. It resolves the name with
#: `getattr(logging, name, logging.INFO)`, so `LOG_LEVEL=warn` — the spelling
#: every other logging library in the world accepts — silently becomes INFO.
_LOG_LEVELS = frozenset({"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"})

#: Environments this estate deploys as. Unknown values are reported but can only
#: ever warn: `is_production()` compares against "production", so an unrecognised
#: `APP_ENV` is by definition not production. That is the point of checking it —
#: `APP_ENV=prod` disables the production posture of every check that asks,
#: including the internal-token gate, and says nothing while it does.
_APP_ENVS = frozenset({"development", "test", "staging", "production"})


class InvalidConfigError(RuntimeError):
    """Raised at startup when production is configured with unusable values."""


@dataclass(frozen=True)
class EnvSpec:
    """One environment variable, and what makes a value usable."""

    name: str
    #: What the setting controls, phrased to finish "…, so the service ".
    effect: str
    kind: str  # 'int' | 'float' | 'choice' | 'bool'
    minimum: float | None = None
    #: Accepted values for 'choice', or the true/false tokens for 'bool'.
    choices: frozenset[str] = frozenset()
    true_tokens: frozenset[str] = frozenset()
    false_tokens: frozenset[str] = frozenset()

    def problem(self, raw: str) -> str | None:
        """The complaint about `raw`, or None when it is usable."""
        value = raw.strip()
        # A variable set to empty is read as unset by every helper here, which
        # is a legitimate way to say "use the default" in a unit file.
        if not value:
            return None

        if self.kind in ("int", "float"):
            try:
                number = int(value) if self.kind == "int" else float(value)
            except ValueError:
                want = "an integer" if self.kind == "int" else "a number"
                return f"{self.name}={value!r} is not {want}"
            if self.minimum is not None and number < self.minimum:
                return f"{self.name}={value!r} is below the minimum of {self.minimum:g}"
            return None

        if self.kind == "choice":
            if value.lower() not in self.choices:
                allowed = ", ".join(sorted(self.choices))
                return f"{self.name}={value!r} is not one of: {allowed}"
            return None

        if self.kind == "bool":
            if value.lower() not in (self.true_tokens | self.false_tokens):
                allowed = ", ".join(sorted(self.true_tokens | self.false_tokens))
                return f"{self.name}={value!r} is not a recognised on/off value ({allowed})"
            return None

        raise AssertionError(f"unknown spec kind {self.kind!r}")  # pragma: no cover


#: Every tunable this service reads from the environment.
#:
#: Secrets are absent on purpose. `INTERNAL_SERVICE_TOKEN` is the one that
#: matters and it has its own check in `internal_auth`; more to the point, a
#: complaint here quotes the offending value, which is exactly what must not
#: happen to a credential.
SPECS: tuple[EnvSpec, ...] = (
    EnvSpec(
        name="MAX_REQUEST_BODY_BYTES",
        effect="caps the request body this service will buffer",
        kind="int",
        minimum=1,
    ),
    EnvSpec(
        name="THREADPOOL_MAX",
        effect="sizes the pool every CPU-bound compute runs in",
        kind="int",
        minimum=1,
    ),
    EnvSpec(
        name="RATE_LIMIT_RPM",
        effect="is the per-caller request ceiling (0 disables it)",
        kind="int",
        minimum=0,
    ),
    EnvSpec(
        name="LOG_LEVEL",
        effect="sets the log verbosity",
        kind="choice",
        choices=frozenset(level.lower() for level in _LOG_LEVELS),
    ),
    EnvSpec(
        name=APP_ENV_VAR,
        effect="decides whether this process takes its production posture",
        kind="choice",
        choices=_APP_ENVS,
    ),
    # ── OpenRouter: the paid dependency, and the budgets that bound it ────────
    EnvSpec(
        name="OPENROUTER_MAX_TOKENS",
        effect="caps the output tokens asked of the model per call",
        kind="int",
        minimum=1,
    ),
    EnvSpec(
        name="OPENROUTER_TOKEN_BUDGET",
        effect="is the process-lifetime token ceiling, and an unusable value reads as unlimited",
        kind="int",
        minimum=0,
    ),
    EnvSpec(
        name="OPENROUTER_CALL_BUDGET_S",
        effect="is the wall-clock ceiling for one model call (0 disables it)",
        kind="float",
        minimum=0,
    ),
    EnvSpec(
        name="AI_REQUIRE_OPENROUTER_KEY",
        effect="decides whether a missing key fails the boot instead of degrading",
        kind="bool",
        # Deliberately narrow, because the reader is: `in {"1", "true", "yes"}`.
        # `on` is not in it, and an operator who writes `on` gets the opposite of
        # what they asked for — so `on` has to be reported, not accepted.
        true_tokens=frozenset({"1", "true", "yes"}),
        false_tokens=frozenset({"0", "false", "no"}),
    ),
    # ── Research: which index answers, and how long it may take ──────────────
    EnvSpec(
        name="RESEARCH_PROVIDER",
        effect="selects the search backend",
        kind="choice",
        choices=frozenset({"brave", "serper", "tavily", "searxng", "duckduckgo", "wikipedia"}),
    ),
    EnvSpec(
        name="RESEARCH_PROVIDER_CHAIN",
        effect="decides whether a failed backend falls through to the next",
        kind="bool",
        true_tokens=frozenset({"1", "true", "yes", "on"}),
        false_tokens=frozenset({"0", "false", "no", "off"}),
    ),
    EnvSpec(
        name="RESEARCH_MAX_RESULTS",
        effect="caps the results taken from one search",
        kind="int",
        minimum=1,
    ),
    EnvSpec(
        name="RESEARCH_CALL_BUDGET_S",
        effect="is the wall-clock ceiling for one search",
        kind="float",
        minimum=0,
    ),
    EnvSpec(
        name="RESEARCH_PROVIDER_COOLDOWN_S",
        effect="is how long a backend that refused us is left alone",
        kind="float",
        minimum=0,
    ),
    # ── Anonymisation: the gate between client data and a third-party model ──
    EnvSpec(
        name="ANONYMIZE_ENFORCE",
        effect="decides whether identifiers must be stripped before a model sees them",
        kind="bool",
        true_tokens=frozenset({"1", "true", "yes", "on"}),
        false_tokens=frozenset({"0", "false", "no", "off"}),
    ),
)


def is_production(environ: Mapping[str, str] | None = None) -> bool:
    """True when this process believes it is serving production traffic."""
    env = os.environ if environ is None else environ
    return env.get(APP_ENV_VAR, "").lower() == "production"


def config_problems(
    environ: Mapping[str, str] | None = None,
    specs: tuple[EnvSpec, ...] = SPECS,
) -> list[str]:
    """Every unusable setting, in declaration order.

    All of them, not the first: an operator who has to redeploy once per typo
    to discover the next one is being made to bisect their own unit file.
    """
    env = os.environ if environ is None else environ
    problems: list[str] = []
    for spec in specs:
        raw = env.get(spec.name)
        if raw is None:
            continue
        complaint = spec.problem(raw)
        if complaint is not None:
            problems.append(f"{complaint} — {spec.name} {spec.effect}")
    return problems


def enforce_env_valid(
    environ: Mapping[str, str] | None = None,
    specs: tuple[EnvSpec, ...] = SPECS,
) -> list[str]:
    """Check the environment at boot; raise in production, warn elsewhere.

    Returns the problems found so a caller (and the tests) can see them without
    reading the log.
    """
    problems = config_problems(environ, specs)
    if not problems:
        return problems

    detail = "; ".join(problems)
    if is_production(environ):
        raise InvalidConfigError(
            f"Refusing to start: {len(problems)} invalid setting(s) in the environment — {detail}. "
            "Each would otherwise be silently replaced by its default, which is not what was configured."
        )
    _log.warning(
        "invalid configuration, falling back to defaults for %d setting(s): %s",
        len(problems),
        detail,
        extra={"event": "config_invalid", "count": len(problems)},
    )
    return problems


# ── deploy-time preflight ────────────────────────────────────────────────────
#
# The same specs, run against the host's env file *before* anything is
# restarted. `infra/deploy.sh` already does this for the Node units via
# `preflight-cli.js`, on the reasoning that a bad setting should cost a failed
# deploy with the previous release still serving, rather than a crash-looping
# unit and an outage. The Python pair sat outside that check because
# `preflight.ts` cannot import this module — Node cannot read Python — and
# transcribing the specs into TypeScript would leave two lists to keep in step.
#
# Running this module as a script is the way out: the deploy calls the real
# specs, in the interpreter that will enforce them, so there is nothing to drift.
#
# Unlike `enforce_env_valid`, APP_ENV is not consulted. Anything unusable is a
# failure here whatever the file says the environment is — the deploy is aimed at
# production by construction, and the point of the check is to answer "no" while
# that is still cheap.


def parse_env_file(text: str) -> dict[str, str]:
    """The KEY=VALUE pairs from a systemd EnvironmentFile.

    Deliberately small: this reads the same file `preflight-cli.js` reads and
    only needs to recover values well enough to judge them. Comments, blank
    lines and a leading `export` are skipped, and one layer of matching quotes is
    stripped — which is the shape everything in this estate's `.env` takes.
    """
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        name, sep, raw = stripped.partition("=")
        if not sep:
            continue
        name = name.strip()
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
            raw = raw[1:-1]
        values[name] = raw
    return values


def main(argv: list[str] | None = None) -> int:
    """`python -m app.config_check --env-file PATH` — 0 clean, 1 with faults."""
    import argparse

    parser = argparse.ArgumentParser(description="Validate a deployed environment file.")
    parser.add_argument("--env-file", required=True, help="path to the EnvironmentFile the units read")
    args = parser.parse_args(argv)

    try:
        with open(args.env_file, encoding="utf8") as handle:
            text = handle.read()
    except OSError as err:
        print(f"cannot read {args.env_file}: {err}")
        return 1

    problems = config_problems(parse_env_file(text))
    if problems:
        print(f"{len(problems)} invalid setting(s) in {args.env_file}:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"checked {len(SPECS)} settings in {args.env_file}: no faults")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
