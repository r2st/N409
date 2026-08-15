"""Does the venv-vs-spec drift check actually catch drift?

`tools/check_installed_deps.py` is the half of the dependency audit that looks
at the deployment rather than at PyPI, and infra/deploy.sh treats a non-zero
exit from it as fatal. Both of those make it worth testing properly: a check
that silently passes is worse than no check, because it retires the suspicion
that would otherwise have someone look.

The comparisons run against a synthetic "installed" mapping rather than this
venv, so the assertions are about the comparison logic and not about whatever
happens to be installed the day the suite runs. One test does exercise the real
CLI end to end, because the exit code is the contract deploy.sh depends on and
nothing else here would notice if it inverted.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "tools" / "check_installed_deps.py"


def load_tool():
    """Import the tool by path — it lives outside any installed package."""
    spec = importlib.util.spec_from_file_location("check_installed_deps", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = load_tool()


@pytest.fixture()
def spec_file(tmp_path: Path):
    """Writes a requirements file and returns its path."""

    def write(body: str) -> Path:
        path = tmp_path / "requirements.txt"
        path.write_text(body, encoding="utf-8")
        return path

    return write


@pytest.fixture()
def fake_installed(monkeypatch):
    """Replaces the environment lookup with a fixed mapping."""

    def install(mapping: dict[str, str | None]):
        monkeypatch.setattr(mod, "installed_version", lambda name: mapping.get(name))

    return install


# ── the failure this file was written for ────────────────────────────────────


def test_reports_an_installed_version_below_the_floor(spec_file, fake_installed):
    """The live case: prod held pypdf 6.14.2 against a >=6.15.0 floor."""
    fake_installed({"pypdf": "6.14.2"})
    problems = mod.check(spec_file("pypdf>=6.15.0\n"))
    assert len(problems) == 1
    assert "pypdf" in problems[0]
    assert "6.14.2" in problems[0]
    assert ">=6.15.0" in problems[0]


def test_compares_versions_numerically_not_lexically(spec_file, fake_installed):
    """`"6.9.0" > "6.15.0"` as strings, and that inversion is the whole risk.

    A string comparison would call this satisfied — 6.9 sorts above 6.15 — and
    the check would pass on precisely the drift it exists to find.
    """
    fake_installed({"pypdf": "6.9.0"})
    assert mod.check(spec_file("pypdf>=6.15.0\n"))

    fake_installed({"pypdf": "6.15.0"})
    assert mod.check(spec_file("pypdf>=6.15.0\n")) == []


def test_accepts_a_version_above_the_floor(spec_file, fake_installed):
    fake_installed({"fastapi": "0.139.0"})
    assert mod.check(spec_file("fastapi>=0.115\n")) == []


def test_reports_a_missing_distribution(spec_file, fake_installed):
    fake_installed({})
    problems = mod.check(spec_file("pypdf>=6.15.0\n"))
    assert len(problems) == 1
    assert "not installed" in problems[0]


def test_honours_upper_bounds_and_exclusions(spec_file, fake_installed):
    """A floor is not the only specifier a line can carry."""
    fake_installed({"numpy": "3.0.0"})
    assert mod.check(spec_file("numpy>=2.0,<3.0\n"))

    fake_installed({"numpy": "2.5.2"})
    assert mod.check(spec_file("numpy>=2.0,<3.0\n")) == []

    fake_installed({"urllib3": "2.1.0"})
    assert mod.check(spec_file("urllib3!=2.1.0\n"))


# ── parsing the spec files this repo actually has ────────────────────────────


def test_ignores_comments_blank_lines_and_includes(spec_file, fake_installed):
    """requirements-dev.txt opens with `-r requirements.txt`, which is not a package.

    Following it would audit the base file twice and, worse, report its
    requirements under the dev file's name.
    """
    fake_installed({"pytest": "9.1.1"})
    body = (
        "# a comment\n"
        "\n"
        "-r requirements.txt\n"
        "--index-url https://example.invalid/simple\n"
        "pytest>=8.3\n"
    )
    assert mod.check(spec_file(body)) == []


def test_strips_trailing_comments_but_not_url_fragments(spec_file, fake_installed):
    fake_installed({"pypdf": "6.15.0", "pytest": "9.1.1"})
    assert mod.check(spec_file("pypdf>=6.15.0  # see PYSEC-2026-3655\n")) == []

    # A `#` that does not start a token belongs to the requirement.
    requirements, unparsed = mod.parse_requirements(
        spec_file("pytest @ https://example.invalid/p.tar.gz#sha256=abc\n")
    )
    assert unparsed == []
    assert requirements[0].name == "pytest"


def test_joins_continuation_lines(spec_file, fake_installed):
    fake_installed({"numpy": "2.5.2"})
    assert mod.check(spec_file("numpy>=2.0,\\\n    <3.0\n")) == []


def test_a_bare_requirement_only_has_to_be_installed(spec_file, fake_installed):
    fake_installed({"yfinance": "1.5.2"})
    assert mod.check(spec_file("yfinance\n")) == []

    fake_installed({})
    assert mod.check(spec_file("yfinance\n"))


def test_reports_an_unparseable_line_rather_than_skipping_it(spec_file, fake_installed):
    """A line nobody can read is a line nobody is checking — say so."""
    fake_installed({})
    problems = mod.check(spec_file("this is not a requirement\n"))
    assert len(problems) == 1
    assert "could not parse" in problems[0]


def test_skips_a_requirement_whose_marker_excludes_this_environment(spec_file, fake_installed):
    """Not installed is the *correct* state for a requirement meant elsewhere."""
    fake_installed({})
    body = 'tomli>=2.0; python_version < "3.11"\n'
    assert mod.check(spec_file(body)) == []


def test_applies_a_requirement_whose_marker_includes_this_environment(spec_file, fake_installed):
    fake_installed({})
    body = 'tomli>=2.0; python_version >= "3.0"\n'
    assert mod.check(spec_file(body))


# ── the contract deploy.sh depends on ────────────────────────────────────────


def test_cli_exits_non_zero_and_names_the_package(tmp_path: Path):
    """deploy.sh reads the exit code and prints nothing itself — this is the signal."""
    path = tmp_path / "requirements.txt"
    # Something certainly installed here, at a floor it certainly cannot meet.
    path.write_text("pytest>=9999.0\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(TOOL), str(path)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "pytest" in result.stderr
    assert "9999.0" in result.stderr


def test_cli_exits_zero_when_the_spec_is_satisfied(tmp_path: Path):
    path = tmp_path / "requirements.txt"
    path.write_text("pytest>=1.0\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(TOOL), str(path)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_cli_exits_two_on_a_missing_file(tmp_path: Path):
    """Distinct from 1: "I could not check" is not "I checked and it is fine"."""
    result = subprocess.run(
        [sys.executable, str(TOOL), str(tmp_path / "nope.txt")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2


# ── the spec files in this repo ──────────────────────────────────────────────


def test_the_shipped_requirements_files_all_parse():
    """A spec line this tool cannot read is a line it is not checking.

    Cheap insurance against someone adding a form (an extras marker, a URL
    requirement) that the parser silently drops on the floor — which would look
    exactly like a passing check.
    """
    for service in ("ai", "engine-wrapper"):
        path = REPO_ROOT / "src" / "services" / service / "requirements.txt"
        requirements, unparsed = mod.parse_requirements(path)
        assert unparsed == [], f"{service}: unparseable lines {unparsed}"
        assert requirements, f"{service}: no requirements parsed"


def test_the_ai_service_requires_a_patched_pypdf():
    """Pins the fix for PYSEC-2026-3655/3656 so a later edit cannot quietly undo it.

    Both are resource-exhaustion bugs in text extraction, which `documents.py`
    runs over client-uploaded files — so the floor is load-bearing, not hygiene.
    """
    path = REPO_ROOT / "src" / "services" / "ai" / "requirements.txt"
    requirements, _ = mod.parse_requirements(path)
    pypdf = next(r for r in requirements if r.name == "pypdf")
    assert not pypdf.specifier.contains("6.14.2", prereleases=True)
    assert pypdf.specifier.contains("6.15.0", prereleases=True)
