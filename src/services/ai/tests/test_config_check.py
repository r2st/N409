"""Startup validation of the environment (production hardening round).

Every tunable this service reads has a helper that falls back to a default when
the value will not parse. That is deliberate on a laptop and dangerous in
production, for two reasons this module's docstring sets out: the check happens
whenever the helper is first called rather than at boot, and for at least one
variable the fallback is the *less* safe reading of what the operator wrote.

These tests pin both halves: what counts as unusable, and what happens about it
in each environment.
"""

import logging

import pytest

from app.observability import _SECRET_ENV_VARS
from app.config_check import (
    SPECS,
    EnvSpec,
    InvalidConfigError,
    config_problems,
    enforce_env_valid,
    main,
    parse_env_file,
)


def env(**overrides: str) -> dict[str, str]:
    """An environment mapping, passed explicitly so nothing here touches os.environ."""
    return dict(overrides)


# ── what counts as a problem ─────────────────────────────────────────────────


def test_an_empty_environment_has_no_problems():
    # Every one of these is optional. Absence is not a misconfiguration, it is
    # the default, and a check that complained about it would fire on every
    # developer machine in the estate.
    assert config_problems(env()) == []


def test_a_variable_set_to_empty_is_read_as_unset():
    # `FOO=` in a unit file is how an operator says "use the default", and every
    # helper here already reads it that way.
    assert config_problems(env(RATE_LIMIT_RPM="", LOG_LEVEL="  ")) == []


def test_a_valid_setting_is_not_reported():
    assert (
        config_problems(
            env(
                MAX_REQUEST_BODY_BYTES="8388608",
                THREADPOOL_MAX="40",
                RATE_LIMIT_RPM="0",
                LOG_LEVEL="debug",
                APP_ENV="production",
                OPENROUTER_TOKEN_BUDGET="500000",
                RESEARCH_PROVIDER="brave",
            )
        )
        == []
    )


@pytest.mark.parametrize(
    "name,value",
    [
        ("MAX_REQUEST_BODY_BYTES", "8mb"),
        ("THREADPOOL_MAX", "forty"),
        ("RATE_LIMIT_RPM", "1_200_x"),
    ],
)
def test_a_non_numeric_value_is_reported(name, value):
    (problem,) = config_problems(env(**{name: value}))
    assert name in problem
    assert value in problem


@pytest.mark.parametrize(
    "name,value",
    [
        # Zero threads runs no sync handler at all; zero bytes refuses every
        # request carrying a body. Neither is something an operator can mean.
        ("MAX_REQUEST_BODY_BYTES", "0"),
        ("THREADPOOL_MAX", "0"),
        ("RATE_LIMIT_RPM", "-1"),
    ],
)
def test_a_number_below_its_floor_is_reported(name, value):
    (problem,) = config_problems(env(**{name: value}))
    assert name in problem
    assert "minimum" in problem


def test_log_level_must_be_one_the_logger_can_install():
    # `configure_logging` resolves the name with `getattr(logging, name,
    # logging.INFO)`, so `warn` — the spelling most logging libraries accept —
    # silently becomes INFO. It is a real typo with an invisible effect.
    (problem,) = config_problems(env(LOG_LEVEL="warn"))
    assert "LOG_LEVEL" in problem
    assert "warning" in problem  # the allowed list is quoted back

    assert config_problems(env(LOG_LEVEL="WARNING")) == []


def test_an_unrecognised_app_env_is_reported():
    # This is the one that disables other checks rather than its own: everything
    # that asks `is_production()` compares against the exact word, so `prod`
    # quietly opts the process out of its production posture — including the
    # internal-token gate, which then only warns about a missing secret.
    (problem,) = config_problems(env(APP_ENV="prod"))
    assert "APP_ENV" in problem
    assert "production" in problem


def test_the_token_budget_rejects_a_value_that_would_read_as_unlimited():
    # `_TokenBudget._cap` answers an unparseable value with 0, and reads 0 as
    # "no ceiling". So the one variable whose entire purpose is to bound spend
    # against a paid key, mistyped, removes the bound — and logs nothing.
    (problem,) = config_problems(env(OPENROUTER_TOKEN_BUDGET="500k"))
    assert "OPENROUTER_TOKEN_BUDGET" in problem
    assert "unlimited" in problem  # the effect is spelled out in the complaint

    # 0 is a legitimate way to ask for unlimited; it is only the typo that is not.
    assert config_problems(env(OPENROUTER_TOKEN_BUDGET="0")) == []


def test_require_key_rejects_on_because_the_reader_does_not_accept_it():
    # The truthy set is `{1, true, yes}`. `on` is not in it, so an operator who
    # writes `on` gets the opposite of the crash-on-missing-key they asked for.
    (problem,) = config_problems(env(AI_REQUIRE_OPENROUTER_KEY="on"))
    assert "AI_REQUIRE_OPENROUTER_KEY" in problem

    for value in ("1", "true", "yes", "0", "false", "no"):
        assert config_problems(env(AI_REQUIRE_OPENROUTER_KEY=value)) == [], value


def test_an_unknown_research_provider_is_reported():
    # `configured_provider` warns and falls back to DuckDuckGo, so the installation
    # that configured Brave for a compliance reason silently searches elsewhere.
    (problem,) = config_problems(env(RESEARCH_PROVIDER="bing"))
    assert "RESEARCH_PROVIDER" in problem
    assert "duckduckgo" in problem  # the allowed list is quoted back


def test_the_anonymisation_switch_rejects_an_unrecognised_token():
    # Its reader is a truthy set, so anything it does not recognise reads as
    # "do not enforce" — the gate between client data and a third-party model,
    # off, because of a spelling.
    (problem,) = config_problems(env(ANONYMIZE_ENFORCE="enforce"))
    assert "ANONYMIZE_ENFORCE" in problem


def test_every_problem_is_reported_not_only_the_first():
    # An operator who has to redeploy once per typo to discover the next one is
    # being made to bisect their own unit file.
    problems = config_problems(env(THREADPOOL_MAX="0", LOG_LEVEL="warn", RATE_LIMIT_RPM="lots"))
    assert len(problems) == 3


def test_a_problem_names_the_variable_the_value_and_the_effect():
    (problem,) = config_problems(env(RATE_LIMIT_RPM="lots"))
    assert "RATE_LIMIT_RPM" in problem  # which knob
    assert "lots" in problem  # what was found
    assert "per-caller request ceiling" in problem  # why it matters


# ── what happens about it ────────────────────────────────────────────────────


def test_production_refuses_to_start():
    # A crash-looping unit is noticed; a box quietly serving on defaults its
    # operator did not choose is not. Same line internal_auth already draws.
    with pytest.raises(InvalidConfigError) as excinfo:
        enforce_env_valid(env(APP_ENV="production", THREADPOOL_MAX="0"))
    assert "THREADPOOL_MAX" in str(excinfo.value)
    assert "Refusing to start" in str(excinfo.value)


def test_a_developer_machine_warns_and_keeps_running(caplog):
    # The documented laptop behaviour is preserved exactly: one warning, and the
    # default. Nothing here stops a service whose other settings are fine.
    with caplog.at_level(logging.WARNING, logger="config_check"):
        problems = enforce_env_valid(env(THREADPOOL_MAX="0"))
    assert len(problems) == 1
    assert "THREADPOOL_MAX" in caplog.text


def test_a_valid_production_environment_starts_silently(caplog):
    with caplog.at_level(logging.WARNING, logger="config_check"):
        assert enforce_env_valid(env(APP_ENV="production", THREADPOOL_MAX="40")) == []
    assert caplog.text == ""


def test_production_reports_every_problem_in_one_boot():
    # Fixing these one redeploy at a time is the failure mode being avoided.
    with pytest.raises(InvalidConfigError) as excinfo:
        enforce_env_valid(env(APP_ENV="production", THREADPOOL_MAX="0", LOG_LEVEL="warn"))
    message = str(excinfo.value)
    assert "THREADPOOL_MAX" in message and "LOG_LEVEL" in message


# ── the specs themselves ─────────────────────────────────────────────────────


def test_no_spec_covers_a_secret():
    # A complaint quotes the offending value, which is exactly what must not
    # happen to a credential. The secrets have their own handling:
    # INTERNAL_SERVICE_TOKEN is checked by internal_auth, which never echoes it,
    # and observability redacts both of these out of any line that carries them.
    #
    # Asserted against that module's own list rather than a copy, so a secret
    # added there is covered here without anyone remembering to.
    for spec in SPECS:
        assert spec.name not in _SECRET_ENV_VARS, spec.name
        # Names that are credentials by construction, whether or not anything
        # redacts them yet. `OPENROUTER_MAX_TOKENS` is deliberately not one:
        # substring matching on "TOKEN" or "KEY" reads a token *count* as a
        # token, which is how this test first failed.
        assert not spec.name.endswith(("_API_KEY", "_SECRET", "_SECRET_KEY", "_PASSWORD")), spec.name


def test_every_spec_is_well_formed():
    for spec in SPECS:
        assert spec.kind in ("int", "float", "choice", "bool"), spec.name
        assert spec.effect and not spec.effect.endswith("."), spec.name
        if spec.kind == "choice":
            assert spec.choices, spec.name
        if spec.kind == "bool":
            # Overlapping sets would make a token mean both things at once.
            assert spec.true_tokens and spec.false_tokens, spec.name
            assert not (spec.true_tokens & spec.false_tokens), spec.name


def test_an_unknown_kind_is_a_programming_error():
    with pytest.raises(AssertionError):
        EnvSpec(name="X", effect="does nothing", kind="nonsense").problem("v")


# ── the deploy-time preflight ────────────────────────────────────────────────


def test_env_file_parsing_handles_the_shapes_a_unit_file_takes():
    parsed = parse_env_file(
        "\n".join(
            [
                "# a comment",
                "",
                "RATE_LIMIT_RPM=600",
                'LOG_LEVEL="debug"',
                "THREADPOOL_MAX='8'",
                "export APP_ENV=production",
                "  MAX_REQUEST_BODY_BYTES = 1024  ",
                "NOT_AN_ASSIGNMENT",
            ]
        )
    )
    assert parsed["RATE_LIMIT_RPM"] == "600"
    assert parsed["LOG_LEVEL"] == "debug"  # quotes stripped
    assert parsed["THREADPOOL_MAX"] == "8"
    assert parsed["APP_ENV"] == "production"  # `export ` stripped
    assert parsed["MAX_REQUEST_BODY_BYTES"] == "1024"
    assert "NOT_AN_ASSIGNMENT" not in parsed


def test_the_cli_passes_a_clean_env_file(tmp_path, capsys):
    path = tmp_path / ".env"
    path.write_text("LOG_LEVEL=info\nRATE_LIMIT_RPM=600\n", encoding="utf8")
    assert main(["--env-file", str(path)]) == 0
    assert "no faults" in capsys.readouterr().out


def test_the_cli_fails_a_bad_env_file_and_names_every_fault(tmp_path, capsys):
    path = tmp_path / ".env"
    path.write_text("LOG_LEVEL=warn\nTHREADPOOL_MAX=0\n", encoding="utf8")
    assert main(["--env-file", str(path)]) == 1
    out = capsys.readouterr().out
    assert "LOG_LEVEL" in out and "THREADPOOL_MAX" in out


def test_the_cli_judges_values_whatever_app_env_says(tmp_path):
    # Unlike enforce_env_valid, the deploy check does not consult APP_ENV: the
    # deploy is aimed at production by construction, and a fault should cost a
    # failed deploy with the old release still serving.
    path = tmp_path / ".env"
    path.write_text("APP_ENV=development\nTHREADPOOL_MAX=0\n", encoding="utf8")
    assert main(["--env-file", str(path)]) == 1


def test_the_cli_reports_a_missing_file_rather_than_passing_it(tmp_path, capsys):
    # A check that silently passes when it cannot find the file is worse than no
    # check: the deploy would read it as "configuration validated".
    assert main(["--env-file", str(tmp_path / "absent")]) == 1
    assert "cannot read" in capsys.readouterr().out
