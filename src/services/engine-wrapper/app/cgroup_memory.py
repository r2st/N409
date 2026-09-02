"""The memory ceiling this unit runs under, read from the kernel and exported.

The twin of ``@n409/shared``'s ``cgroupMemory.ts``, for the reason the twin
``config_check.py`` files give: the argument is identical on both sides of the
wire and the fix has to be made in both or the estate stays half-instrumented.

## Why this file exists

R99 gave all five units a ``MemoryMax`` and a ``MemoryHigh``. R337 exported the
cgroup's view of that from the three Fastify services, and ``alerts.yml`` grew
five rules over it — ``MemoryNearCgroupLimit``, ``MemoryCeilingMissing``,
``CgroupMemoryReclaimForced``, ``CgroupMemoryThrottling`` and ``CgroupOomKill``.
R361 made the AI (:3002) and engine (:3003) units scrape targets, and the
scrape note says what that bought: "every rule in the availability and http
groups below covers all five units". The memory group was not in that sentence
and nothing since has put it there. All five rules select
``n409_cgroup_memory_*``, all five annotate ``{{ $labels.job }}``, and the two
jobs they cannot match are the two with the *tightest* ceilings on a 3.8 GB box
— 256M each, against the valuation tier's 384M and the report tier's 512M.

The failure ``CgroupMemoryReclaimForced`` was written for is, in that rule's own
words, "a report render or a workbook import allocates hard inside one request"
— an allocation spike inside a single request, seen between two fifteen-second
scrapes, which the instantaneous ratio in ``MemoryNearCgroupLimit`` is
structurally unable to catch. Both Python tiers do exactly that shape of work:
the AI tier parses uploaded workbooks (R367 found one being materialised whole
to read its first four hundred rows) and the engine tier runs simulations over
pandas frames. These are the units that rule describes, and they were the two it
could not see.

## What the kernel will and will not tell you

Unchanged from the TS file, and worth restating because the semantics decide
the alert expressions:

* ``memory.events`` counts moments, not levels. ``high`` is throttling at
  ``MemoryHigh``, ``max`` is an allocation that forced reclaim at ``MemoryMax``,
  ``oom_kill`` is a process the cgroup's own OOM handler killed. The first two
  tick long before anything dies and are the part you can act on.
* Those counters reset whenever the unit restarts, because systemd destroys and
  recreates the cgroup — and a restart is exactly what follows a kill. A unit
  killed at its ceiling comes back reporting ``oom_kill 0``; the durable record
  is the journal. What is exported here is the *approach*.
* ``max`` in a limit file is the kernel's spelling of unlimited, and it is
  reported as ``0`` rather than omitted. A ceiling of zero is impossible, so the
  value is unambiguous, and it makes "this unit has no limit" something
  ``MemoryCeilingMissing`` can match instead of an absent series that looks
  identical to a unit that is down.

## Portability

Best-effort and silent when it cannot work. A developer machine has no
``/sys/fs/cgroup``, and a cgroup v1 host has different files in a different
place; both produce no gauges at all rather than seven that read zero. A metric
reading zero because a file is missing is worse than an absent one, because only
one of the two is obviously not an answer.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol

#: The events worth exporting. The kernel emits more; these mean something here.
CGROUP_MEMORY_EVENTS: tuple[str, ...] = ("low", "high", "max", "oom", "oom_kill")

_V2_LINE = re.compile(r"^0::(.*)$")


@dataclass(frozen=True)
class CgroupMemory:
    """A reading of the calling process's own cgroup. All values in bytes."""

    #: As ``/proc/self/cgroup`` gives it, e.g. ``/system.slice/n409-ai.service``.
    path: str
    current: float | None
    #: High-water mark since the cgroup was created — i.e. since this unit started.
    peak: float | None
    #: ``None`` when the limit is ``max``, the kernel's spelling of unlimited.
    max: float | None
    high: float | None
    swap_current: float | None
    swap_max: float | None
    #: ``memory.events`` counters. Reset on restart — see the module docstring.
    events: Mapping[str, float] = field(default_factory=dict)


def _parse_limit(text: str) -> float | None:
    """``max`` is unlimited; anything else is a decimal byte count."""
    trimmed = text.strip()
    if trimmed in ("max", ""):
        return None
    try:
        return float(trimmed)
    except ValueError:
        return None


def read_cgroup_memory(
    read_file: Callable[[str], str] | None = None,
    root: str = "/sys/fs/cgroup",
) -> CgroupMemory | None:
    """Read this process's cgroup memory state, or ``None`` off cgroup v2.

    The v2 line in ``/proc/self/cgroup`` is the one with an empty controller
    field — ``0::/system.slice/n409-ai.service``. A host running v1, or the
    hybrid layout, has no such line, and returning ``None`` for it is the whole
    of this module's portability story.

    ``read_file`` is injectable so the tests need neither ``/sys`` nor Linux.
    """

    def _default_read(path: str) -> str:
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    read = _default_read if read_file is None else read_file

    try:
        self_cgroup = read("/proc/self/cgroup")
    except Exception:
        return None

    v2: str | None = None
    for line in self_cgroup.split("\n"):
        matched = _V2_LINE.match(line.strip())
        if matched is not None:
            v2 = matched.group(1)
            break
    if v2 is None:
        return None

    # A file that is missing reads as ``None`` rather than as zero, and a cgroup
    # with no ``memory.current`` at all is not one this can say anything about —
    # so that one absence is what decides there is nothing to report.
    def _file(name: str) -> str | None:
        try:
            return read(f"{root}{v2}/{name}")
        except Exception:
            return None

    current_text = _file("memory.current")
    if current_text is None:
        return None

    events: dict[str, float] = {}
    events_text = _file("memory.events")
    if events_text is not None:
        for line in events_text.split("\n"):
            parts = line.strip().split()
            if len(parts) < 2:
                continue
            try:
                events[parts[0]] = float(parts[1])
            except ValueError:
                continue

    def _size(name: str) -> float | None:
        text = _file(name)
        return None if text is None else _parse_limit(text)

    return CgroupMemory(
        path=v2,
        current=_parse_limit(current_text),
        peak=_size("memory.peak"),
        max=_size("memory.max"),
        high=_size("memory.high"),
        swap_current=_size("memory.swap.current"),
        swap_max=_size("memory.swap.max"),
        events=events,
    )


class GaugeSink(Protocol):
    """The slice of ``MetricsRegistry`` this needs, so ``metrics`` need not import it."""

    def gauge(self, name: str, help_text: str, collect, label_names=()): ...


def register_cgroup_memory_metrics(
    registry: GaugeSink,
    read_file: Callable[[str], str] | None = None,
    root: str = "/sys/fs/cgroup",
) -> bool:
    """Register the cgroup gauges, if this process is in a cgroup v2 at all.

    The probe runs once, at registration, and decides whether the gauges exist;
    the reads themselves happen per scrape. That split is the TS file's and is
    deliberate in both directions. Deciding once means a developer machine gets
    no gauges rather than seven that always read zero. Reading per scrape means
    the numbers are current — these are kernel pseudo-files, a handful of bytes
    each, served without touching a disk, so ``Gauge``'s "cheap and synchronous"
    contract holds.

    A file that disappears between registration and a scrape reads as zero
    rather than raising. ``MetricsRegistry.render`` would survive it — a
    throwing collect is dropped and counted into
    ``n409_metric_collect_failures_total`` — but losing the whole memory family
    to a rearranged cgroup is a worse answer than a zero, and
    ``MetricCollectFailing`` is for a collector that is broken rather than one
    whose subject went away.
    """
    if read_cgroup_memory(read_file, root) is None:
        return False

    def _field(pick: Callable[[CgroupMemory], float | None]) -> Callable[[], float]:
        def _read() -> float:
            reading = read_cgroup_memory(read_file, root)
            if reading is None:
                return 0.0
            value = pick(reading)
            return 0.0 if value is None else value

        return _read

    registry.gauge(
        "n409_cgroup_memory_current_bytes",
        "Memory charged to this unit's cgroup, including page cache",
        _field(lambda m: m.current),
    )
    registry.gauge(
        "n409_cgroup_memory_peak_bytes",
        "High-water mark since this unit last started",
        _field(lambda m: m.peak),
    )
    # Reported as 0 when the limit is `max` — see the module docstring for why
    # that is not a measurement dressed as one.
    registry.gauge(
        "n409_cgroup_memory_max_bytes",
        "MemoryMax for this unit, or 0 when unlimited",
        _field(lambda m: m.max),
    )
    registry.gauge(
        "n409_cgroup_memory_high_bytes",
        "MemoryHigh throttling threshold for this unit, or 0 when unset",
        _field(lambda m: m.high),
    )
    registry.gauge(
        "n409_cgroup_memory_swap_current_bytes",
        "Swap charged to this unit's cgroup",
        _field(lambda m: m.swap_current),
    )
    registry.gauge(
        "n409_cgroup_memory_swap_max_bytes",
        "MemorySwapMax for this unit, or 0 when unlimited",
        _field(lambda m: m.swap_max),
    )

    def _events():
        reading = read_cgroup_memory(read_file, root)
        if reading is None:
            return ()
        return tuple(
            (float(reading.events.get(event, 0.0)), {"event": event})
            for event in CGROUP_MEMORY_EVENTS
        )

    registry.gauge(
        "n409_cgroup_memory_events",
        "cgroup memory.events counters; reset whenever the unit restarts",
        _events,
        ("event",),
    )
    return True
