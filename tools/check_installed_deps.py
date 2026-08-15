"""Does this venv actually contain what requirements.txt asks for?

CI already runs `pip-audit -r src/services/*/requirements.txt`, and that check
passes while production is vulnerable. Both statements were true of pypdf on
2026-08-15: the deployed venv held 6.14.2, which carries PYSEC-2026-3655 and
PYSEC-2026-3656, and CI was green.

The reason is that `pip-audit -r` audits a *resolve of the spec*, not an
install. Every line in both requirements files is a floor (`pypdf>=5.1`), so
the resolve picks the newest release on PyPI, audits that, and reports on a set
of versions which exists nowhere — least of all on the host. A floor-only spec
makes CI's dependency audit structurally unable to see the deployment: it is
auditing what a fresh install *would* get, and the deployment is never a fresh
install.

It is never a fresh install because `infra/deploy.sh` reinstalls a service's
venv only when its `requirements.txt` changed in the commit range being
deployed — a deliberate optimisation, since the usual deploy has no reason to
pay for a pip resolve. The consequence is that the installed set is a fossil of
whatever PyPI served the last time somebody edited that file, and it drifts
further from the spec with every release the world publishes. Nothing measured
that drift, so nothing could report it.

So this asks the only question the other two do not: *what is installed here,
right now, and does the spec still admit it?* It is deliberately not a
vulnerability scanner — it needs no network, no advisory database, and no
opinion about which versions are dangerous. It compares two facts already on
the host. That makes it safe to run on every deploy, before anything restarts,
which is what turns "prod drifted below the floor" from something discovered by
an advisory into something discovered by the deploy that would have shipped it.

Usage:

    .venv/bin/python tools/check_installed_deps.py path/to/requirements.txt

Run with the *interpreter that owns the venv* — it reads that interpreter's
installed distributions, so running it with the wrong python cheerfully audits
the wrong environment.
"""

from __future__ import annotations

import sys
from importlib import metadata
from pathlib import Path

# `packaging` is not declared in either requirements.txt, but it is present in
# both venvs as a transitive of pytest/pip and is the only correct way to
# compare a PEP 440 version against a PEP 508 specifier. String comparison is
# not a substitute: "6.9.0" > "6.15.0" lexicographically, which inverts the
# exact comparison this file exists to get right.
try:
    from packaging.markers import UndefinedEnvironmentName
    from packaging.requirements import InvalidRequirement, Requirement
except ModuleNotFoundError:  # pragma: no cover - venv without packaging
    print(
        "check_installed_deps: `packaging` is not installed in this environment, "
        "so requirement specifiers cannot be compared. Install it or skip this check.",
        file=sys.stderr,
    )
    raise SystemExit(2)


def parse_requirements(path: Path) -> tuple[list[Requirement], list[str]]:
    """The requirements in `path`, and the lines that were not requirements.

    Continuation lines (`\\`) are joined, comments and blanks dropped, and
    `-r`/`-c`/`--flag` lines skipped rather than followed: each service's file
    is audited on its own, and a dev-only include (`requirements-dev.txt` starts
    with `-r requirements.txt`) would otherwise be audited twice under two
    different names.
    """
    requirements: list[Requirement] = []
    unparsed: list[str] = []

    raw = path.read_text(encoding="utf-8")
    joined: list[str] = []
    buffer = ""
    for line in raw.splitlines():
        stripped = line.strip()
        if buffer:
            stripped = buffer + stripped
            buffer = ""
        if stripped.endswith("\\"):
            buffer = stripped[:-1].strip() + " "
            continue
        joined.append(stripped)

    for line in joined:
        # Strip trailing comments, but only when the `#` starts a token — a URL
        # fragment (`...#egg=name`) is part of the requirement, not a comment.
        if " #" in line:
            line = line.split(" #", 1)[0].strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-") or line.startswith("--"):
            continue
        try:
            requirements.append(Requirement(line))
        except InvalidRequirement:
            unparsed.append(line)

    return requirements, unparsed


def installed_version(name: str) -> str | None:
    """The installed version of `name`, or None if it is absent.

    `metadata.version` normalises the lookup name itself, so `pytest-cov` and
    `pytest_cov` both resolve — which matters because requirements files and
    dist metadata disagree about separators more often than not.
    """
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def check(path: Path) -> list[str]:
    """Every way `path` and the current environment disagree, as prose."""
    requirements, unparsed = parse_requirements(path)
    problems: list[str] = []

    for line in unparsed:
        problems.append(f"{path.name}: could not parse requirement {line!r}")

    for req in requirements:
        # A marker that excludes this environment (`; python_version < "3.9"`)
        # means the requirement is not meant to be installed here, so a missing
        # distribution is correct rather than a fault.
        if req.marker is not None:
            try:
                if not req.marker.evaluate():
                    continue
            except UndefinedEnvironmentName:
                # A marker naming a variable this environment does not define
                # cannot be evaluated either way. Report it rather than guess:
                # guessing "applies" invents a failure, guessing "skip" hides a
                # real requirement.
                problems.append(f"{req.name}: marker {req.marker} could not be evaluated here")
                continue

        version = installed_version(req.name)
        if version is None:
            problems.append(f"{req.name}: required by {path.name} but not installed")
            continue

        # Specifier-less lines (a bare `numpy`) admit anything, so being
        # installed at all is the whole test.
        if not req.specifier:
            continue

        # prereleases=True so an installed release candidate is judged by the
        # specifier rather than silently excluded by packaging's default, which
        # would report a satisfied requirement as unsatisfied.
        if not req.specifier.contains(version, prereleases=True):
            problems.append(
                f"{req.name}: installed {version} does not satisfy {req.name}{req.specifier} "
                f"from {path.name}"
            )

    return problems


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    problems: list[str] = []
    for arg in argv[1:]:
        path = Path(arg)
        if not path.is_file():
            print(f"check_installed_deps: no such file: {path}", file=sys.stderr)
            return 2
        problems.extend(check(path))

    if problems:
        print("Installed packages do not match the requirements spec:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nThe venv has drifted from the spec (deploy.sh reinstalls only when "
            "requirements.txt changes). Run `.venv/bin/pip install -r <file>` on the host.",
            file=sys.stderr,
        )
        return 1

    print(f"installed packages satisfy {', '.join(argv[1:])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
