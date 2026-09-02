"""The two Python units' cgroup ceiling, which five alert rules could not see.

`infra/monitoring/alerts.yml`'s memory group is five rules — `MemoryNearCgroup
Limit`, `MemoryCeilingMissing`, `CgroupMemoryReclaimForced`,
`CgroupMemoryThrottling` and `CgroupOomKill`. Every one selects an
`n409_cgroup_memory_*` series and annotates `{{ $labels.job }}`, and until now
no `job` on the Python side of the estate published any of them: R337 gave the
three Fastify services the instrument, and R361 made the AI and engine units
scrape targets without it. `infra/systemd` gives all five a `MemoryMax`, and the
two Python units have the tightest — 256M each against 384M and 512M.

So these tests assert the *names, labels and semantics* rather than the
plumbing, for the reason `test_metrics_endpoint.py` gives at the top: a rule
that matches three units out of five is worse than one that matches none,
because it looks like it is working. The names must match `cgroupMemory.ts`
exactly — nothing derives one file from the other, and `alertRulesCensus.test.ts`
reads the TypeScript registrations only.
"""

import pytest

from app.cgroup_memory import (
    CGROUP_MEMORY_EVENTS,
    read_cgroup_memory,
    register_cgroup_memory_metrics,
)
from app.metrics import MetricsRegistry

#: What a scraped unit's cgroup looks like: 256M ceiling, 192M throttle, and a
#: `memory.events` that has recorded one forced reclaim and no kill.
FILES = {
    "/proc/self/cgroup": "0::/system.slice/n409-ai.service\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.current": "134217728\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.peak": "201326592\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.max": "268435456\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.high": "201326592\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.swap.current": "0\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.swap.max": "max\n",
    "/sys/fs/cgroup/system.slice/n409-ai.service/memory.events": (
        "low 0\nhigh 3\nmax 1\noom 0\noom_kill 0\n"
    ),
}


def _reader(files):
    def read(path: str) -> str:
        if path not in files:
            raise FileNotFoundError(path)
        return files[path]

    return read


def _render(files) -> str:
    registry = MetricsRegistry()
    assert register_cgroup_memory_metrics(registry, _reader(files)) is True
    return registry.render()


def test_the_v2_line_is_the_one_with_an_empty_controller_field():
    files = dict(FILES)
    files["/proc/self/cgroup"] = (
        "12:pids:/system.slice/n409-ai.service\n"
        "0::/system.slice/n409-ai.service\n"
    )
    reading = read_cgroup_memory(_reader(files))
    assert reading is not None
    assert reading.path == "/system.slice/n409-ai.service"


def test_a_cgroup_v1_host_reports_nothing_rather_than_zeroes():
    """The whole portability story: a laptop gets no gauges, not seven zeroes."""
    files = {"/proc/self/cgroup": "12:pids:/user.slice\n11:memory:/user.slice\n"}
    assert read_cgroup_memory(_reader(files)) is None
    registry = MetricsRegistry()
    assert register_cgroup_memory_metrics(registry, _reader(files)) is False
    assert "n409_cgroup_memory_current_bytes" not in registry.render()


def test_no_proc_self_cgroup_at_all_reports_nothing():
    assert read_cgroup_memory(_reader({})) is None


def test_a_cgroup_without_memory_current_is_one_we_can_say_nothing_about():
    files = {"/proc/self/cgroup": "0::/system.slice/n409-ai.service\n"}
    assert read_cgroup_memory(_reader(files)) is None


def test_every_series_the_memory_rules_select_is_published():
    body = _render(FILES)
    for name in (
        "n409_cgroup_memory_current_bytes",
        "n409_cgroup_memory_peak_bytes",
        "n409_cgroup_memory_max_bytes",
        "n409_cgroup_memory_high_bytes",
        "n409_cgroup_memory_swap_current_bytes",
        "n409_cgroup_memory_swap_max_bytes",
        "n409_cgroup_memory_events",
    ):
        assert f"# TYPE {name} gauge" in body, name
    assert "n409_cgroup_memory_current_bytes 134217728" in body
    assert "n409_cgroup_memory_max_bytes 268435456" in body
    assert "n409_cgroup_memory_high_bytes 201326592" in body


def test_the_ratio_MemoryNearCgroupLimit_computes_is_the_one_the_kernel_reports():
    """`current / (max > 0)`: both halves must come from the same reading."""
    reading = read_cgroup_memory(_reader(FILES))
    assert reading is not None
    assert reading.current == 134217728.0
    assert reading.max == 268435456.0
    assert reading.current / reading.max == pytest.approx(0.5)


def test_an_unlimited_ceiling_is_zero_and_not_an_absent_series():
    """`MemoryCeilingMissing` matches `max == 0 and current > 0`; a series that
    is simply missing looks exactly like a unit that is down."""
    files = dict(FILES)
    files["/sys/fs/cgroup/system.slice/n409-ai.service/memory.max"] = "max\n"
    body = _render(files)
    assert "n409_cgroup_memory_max_bytes 0" in body
    assert "n409_cgroup_memory_current_bytes 134217728" in body


def test_an_unset_MemoryHigh_is_zero_for_the_same_reason():
    files = dict(FILES)
    files["/sys/fs/cgroup/system.slice/n409-ai.service/memory.high"] = "max\n"
    assert "n409_cgroup_memory_high_bytes 0" in _render(files)


def test_events_carry_the_event_label_every_rule_selects_on():
    """`{event="max"}`, `{event="high"}` and `{event="oom_kill"}` by name."""
    body = _render(FILES)
    assert 'n409_cgroup_memory_events{event="high"} 3' in body
    assert 'n409_cgroup_memory_events{event="max"} 1' in body
    assert 'n409_cgroup_memory_events{event="oom_kill"} 0' in body
    assert 'n409_cgroup_memory_events{event="low"} 0' in body
    assert 'n409_cgroup_memory_events{event="oom"} 0' in body


def test_an_event_the_kernel_omits_reads_as_zero_rather_than_vanishing():
    """`CgroupOomKill` is a bare `> 0`; the series has to exist to be compared."""
    files = dict(FILES)
    files["/sys/fs/cgroup/system.slice/n409-ai.service/memory.events"] = "high 2\n"
    body = _render(files)
    for event in CGROUP_MEMORY_EVENTS:
        assert f'n409_cgroup_memory_events{{event="{event}"}}' in body, event
    assert 'n409_cgroup_memory_events{event="oom_kill"} 0' in body


def test_a_missing_events_file_still_publishes_the_family():
    files = {k: v for k, v in FILES.items() if not k.endswith("memory.events")}
    reading = read_cgroup_memory(_reader(files))
    assert reading is not None and reading.events == {}
    assert 'n409_cgroup_memory_events{event="max"} 0' in _render(files)


def test_an_unparseable_line_in_events_is_skipped_and_the_rest_survive():
    files = dict(FILES)
    files["/sys/fs/cgroup/system.slice/n409-ai.service/memory.events"] = (
        "high notanumber\nmax 4\n\noom_kill\n"
    )
    body = _render(files)
    assert 'n409_cgroup_memory_events{event="max"} 4' in body
    assert 'n409_cgroup_memory_events{event="high"} 0' in body


def test_a_file_that_disappears_after_registration_reads_as_zero():
    """Losing the whole memory family to a rearranged cgroup is a worse answer
    than a zero, and `MetricCollectFailing` is for a broken collector rather
    than one whose subject went away."""
    live = dict(FILES)
    registry = MetricsRegistry()
    assert register_cgroup_memory_metrics(registry, _reader(live)) is True
    live.clear()
    body = registry.render()
    assert "n409_cgroup_memory_current_bytes 0" in body
    assert "n409_metric_collect_failures_total" not in body


def test_the_gauges_are_re_read_per_scrape_rather_than_frozen_at_registration():
    live = dict(FILES)
    registry = MetricsRegistry()
    assert register_cgroup_memory_metrics(registry, _reader(live)) is True
    assert "n409_cgroup_memory_current_bytes 134217728" in registry.render()
    live["/sys/fs/cgroup/system.slice/n409-ai.service/memory.current"] = "200000000\n"
    assert "n409_cgroup_memory_current_bytes 200000000" in registry.render()
