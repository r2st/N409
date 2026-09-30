"""The degrade vocabulary this tier logs, counted on the scrape (R376, M11).

`alerts.yml` carried this as an open item since R346: "the AI and engine tiers
still expose no /metrics, so this round's neighbours in that tier —
llm_prose_fallback, xlsx_sheets_unreadable, documents_unreadable — are
structurally unalertable however well they are written". R369 made both units
scrape targets, which removed the reason and left the instruments unbuilt — the
endpoint published the RED trio, the process facts and the cgroup, so a scraper
could see that this service was *up* and nothing about what it was quietly
falling back to.

Counted at the formatter every warning-or-worse line goes through, because the
vocabulary is the contract: an event added next round is counted by
construction, and one whose level drops below WARNING stops being counted.
"""

import logging

import pytest

from app.metrics import MetricsRegistry, register_process_metrics
from app.observability import JsonLogFormatter, set_degraded_event_sink


@pytest.fixture(autouse=True)
def _clear_sink():
    yield
    set_degraded_event_sink(None)


def _record(level: int, **extra) -> logging.LogRecord:
    record = logging.LogRecord("svc", level, __file__, 1, "a line", None, None)
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def _emit(level: int, **extra) -> str:
    """Format one record the way the installed handler does."""
    return JsonLogFormatter("svc").format(_record(level, **extra))


def test_counts_a_warning_that_names_its_event():
    registry = MetricsRegistry()
    register_process_metrics(registry, "svc", 0.0)

    _emit(logging.WARNING, event="documents_unreadable", count=2, total=6)
    _emit(logging.ERROR, event="openrouter_key", detail="invalid")
    _emit(logging.WARNING, event="documents_unreadable", count=1, total=3)

    text = registry.render()
    assert 'log_degraded_events_total{event="documents_unreadable",level="warning"} 2' in text
    assert 'log_degraded_events_total{event="openrouter_key",level="error"} 1' in text
    assert "# TYPE log_degraded_events_total counter" in text


def test_leaves_the_ordinary_lines_alone():
    # `info` is the access log and the usage lines — every request on the box
    # carries one, and a counter that saw them would be a second, worse copy of
    # `http_requests_total` with an unbounded label.
    registry = MetricsRegistry()
    register_process_metrics(registry, "svc", 0.0)

    _emit(logging.INFO, event="llm_usage", tokens=100)
    _emit(logging.WARNING)  # a warning with nothing to group by
    _emit(logging.WARNING, event="")

    assert "log_degraded_events_total{" not in registry.render()


def test_the_line_itself_is_unchanged():
    # The counter is the detector and the journal is the diagnosis: everything
    # an operator reads once a rule fires still has to be on the line.
    registry = MetricsRegistry()
    register_process_metrics(registry, "svc", 0.0)

    line = _emit(logging.WARNING, event="corpus_truncated", count=3, total=9, detail="limit=15000")
    assert '"event": "corpus_truncated"' in line
    assert '"count": 3' in line and '"total": 9' in line


def test_a_broken_counter_never_costs_a_log_line():
    def explode(_event, _level):
        raise RuntimeError("the counter is broken")

    set_degraded_event_sink(explode)
    assert '"msg": "a line"' in _emit(logging.ERROR, event="unhandled_error")


def test_is_inert_before_registration():
    set_degraded_event_sink(None)
    assert '"event": "market_feed_fallback"' in _emit(logging.WARNING, event="market_feed_fallback")


def test_every_event_a_rule_selects_is_one_this_tier_logs():
    """The fifth direction `alertRulesCensus` watches, for a Python label value.

    A rule selecting `event="llm_prose_fallback"` parses, matches nothing and
    looks exactly like a healthy system if the event is ever renamed. The
    spellings live in this tier's source, so they are read from it.
    """
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parents[4]
    rules = (root / "infra/monitoring/alerts.yml").read_text()
    selected: set[str] = set()
    for match in re.finditer(r'log_degraded_events_total\{event=~?"([^"]+)"\}', rules):
        selected.update(match.group(1).split("|"))
    assert selected, "no rule reads the degrade counter"

    logged: set[str] = set()
    for path in (root / "src/services").rglob("*.py"):
        if "mutants" in path.parts or ".venv" in path.parts:
            continue
        text = path.read_text()
        logged.update(re.findall(r'"event": "([a-z_]+)"', text))
        # The second idiom, and the reason this census had a blind spot exactly
        # where it mattered most (R450). `EngineDegradedError(..., event="...")`
        # reaches the formatter through a *raise*: the type exists so that one
        # refusal is logged at all, `install_error_handlers` reads `event` off
        # `exc.__cause__` and writes the line, and no `"event": "..."` dict
        # literal appears anywhere on the path. So the tier's only
        # report-by-raising degrade read to this scan as an event nothing logs —
        # and a rule naming it read as a rule watching nothing, which is the one
        # conclusion this assertion exists to prevent somebody drawing wrongly.
        logged.update(re.findall(r'\bevent="([a-z_]+)"', text))
    assert logged, "the event scan matched nothing — this assertion would pass vacuously"
    # Non-vacuity for the second idiom specifically: it has exactly one call
    # site today, so a regex that stops matching it takes the blind spot back
    # without anything going red.
    assert "monte_carlo_conservation" in logged

    assert selected <= logged, f"rules select events nothing logs: {sorted(selected - logged)}"
