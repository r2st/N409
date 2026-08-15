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
                ENGINE_LIVE_UNIVERSE="off",
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


def test_the_live_universe_switch_rejects_a_word_it_would_read_as_on():
    # `live_enabled` reads anything outside its falsey set as true. So `disable`
    # — a plausible spelling of the word meant — *enables* live network
    # resolution. The default is not neutral here; it is the opposite of intent.
    (problem,) = config_problems(env(ENGINE_LIVE_UNIVERSE="disable"))
    assert "ENGINE_LIVE_UNIVERSE" in problem

    # The spellings it does understand stay silent, in both directions.
    for value in ("0", "false", "no", "off", "none", "disabled", "1", "true", "yes", "on"):
        assert config_problems(env(ENGINE_LIVE_UNIVERSE=value)) == [], value


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
