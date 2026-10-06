"""Silent fallback in env_float / env_int (R390, methodology M5).

Both helpers silently fell back to their default when the environment carried
a value they could not parse or one below the minimum, with no log line
anywhere saying so. An operator who set ``LLM_BUDGET_CEILING=16MB`` in a unit
file got the default cap and nothing disagreed with them.
"""

import logging

from app.llm_http import env_float, env_int


def test_env_float_logs_on_unparseable_value(monkeypatch, caplog):
    monkeypatch.setenv("TEST_FLOAT", "not-a-number")
    with caplog.at_level(logging.WARNING):
        result = env_float("TEST_FLOAT", 1.0)
    assert result == 1.0
    assert any("not a valid float" in r.message for r in caplog.records)


def test_env_float_logs_on_below_minimum(monkeypatch, caplog):
    monkeypatch.setenv("TEST_FLOAT", "-5.0")
    with caplog.at_level(logging.WARNING):
        result = env_float("TEST_FLOAT", 1.0, minimum=0.0)
    assert result == 1.0
    assert any("below the minimum" in r.message for r in caplog.records)


def test_env_float_returns_valid_value_without_warning(monkeypatch, caplog):
    monkeypatch.setenv("TEST_FLOAT", "3.14")
    with caplog.at_level(logging.WARNING):
        result = env_float("TEST_FLOAT", 1.0)
    assert result == 3.14
    assert not any("TEST_FLOAT" in r.message for r in caplog.records)


def test_env_int_logs_on_unparseable_value(monkeypatch, caplog):
    monkeypatch.setenv("TEST_INT", "sixteen")
    with caplog.at_level(logging.WARNING):
        result = env_int("TEST_INT", 10)
    assert result == 10
    assert any("not a valid integer" in r.message for r in caplog.records)


def test_env_int_logs_on_below_minimum(monkeypatch, caplog):
    monkeypatch.setenv("TEST_INT", "0")
    with caplog.at_level(logging.WARNING):
        result = env_int("TEST_INT", 10, minimum=1)
    assert result == 10
    assert any("below the minimum" in r.message for r in caplog.records)


def test_env_int_returns_valid_value_without_warning(monkeypatch, caplog):
    monkeypatch.setenv("TEST_INT", "42")
    with caplog.at_level(logging.WARNING):
        result = env_int("TEST_INT", 10)
    assert result == 42
    assert not any("TEST_INT" in r.message for r in caplog.records)
