"""Build provenance on /health (issue #4, Python half).

The three Node services have reported which commit is live since issue #4, and
`infra/deploy.sh` verifies a restart by reading that field back. The two FastAPI
services reported nothing, so they were precisely the two the deploy restarted
and never checked — a unit that failed to pick up the new venv looked exactly
like one that had.

These pin the resolution order and, more importantly, the rule that makes it
safe to put on a liveness probe: nothing here may raise.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.build_info import (
    UNKNOWN_BUILD,
    build_info,
    read_build_info,
    reset_build_info_cache,
)
from app.main import app

SHA = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture(autouse=True)
def _clear_cache():
    reset_build_info_cache()
    yield
    reset_build_info_cache()


def test_env_wins_over_everything(tmp_path):
    other = tmp_path / "BUILD_SHA"
    other.write_text("f" * 40)
    info = read_build_info({"BUILD_SHA": SHA, "BUILD_SHA_FILE": str(other)})
    assert info == (SHA, "env")


def test_env_sha_is_lowercased():
    assert read_build_info({"BUILD_SHA": SHA.upper()}).sha == SHA


def test_abbreviated_sha_is_accepted():
    assert read_build_info({"BUILD_SHA": "abc1234"}) == ("abc1234", "env")


@pytest.mark.parametrize(
    "value",
    ["", "   ", "not-a-sha", "abc123", "z" * 40, "0" * 41],
    ids=["empty", "blank", "words", "too-short", "non-hex", "too-long"],
)
def test_a_malformed_env_value_falls_through_rather_than_being_reported(value, tmp_path):
    """Reporting junk would be worse than reporting nothing: the deploy compares
    this field against a real SHA, and a match on garbage is a false green."""
    written = tmp_path / "BUILD_SHA"
    written.write_text(SHA)
    info = read_build_info({"BUILD_SHA": value, "BUILD_SHA_FILE": str(written)})
    assert info == (SHA, "file")


def test_file_is_read_when_env_is_unset(tmp_path):
    written = tmp_path / "BUILD_SHA"
    written.write_text(f"{SHA}\n")
    assert read_build_info({"BUILD_SHA_FILE": str(written)}) == (SHA, "file")


def test_only_the_first_token_of_the_file_is_used(tmp_path):
    # `git rev-parse HEAD` writes one line, but a hand-edited file may carry a
    # trailing comment or a ref name.
    written = tmp_path / "BUILD_SHA"
    written.write_text(f"{SHA} refs/heads/main\n")
    assert read_build_info({"BUILD_SHA_FILE": str(written)}).sha == SHA


def test_a_huge_file_is_not_read_whole(tmp_path):
    # A mistyped BUILD_SHA_FILE pointing at a large file must stay cheap. The
    # SHA is inside the cap, so it is still found.
    written = tmp_path / "BUILD_SHA"
    written.write_text(f"{SHA}\n" + "x" * 5_000_000)
    assert read_build_info({"BUILD_SHA_FILE": str(written)}).sha == SHA


def test_a_missing_file_is_unknown_rather_than_an_error(tmp_path):
    missing = tmp_path / "nope" / "BUILD_SHA"
    # No default file either — parents[4] is not guaranteed to hold one in a
    # deployed layout, and the point is that neither path raises.
    info = read_build_info({"BUILD_SHA_FILE": str(missing), "HOME": str(tmp_path)})
    assert info.source in {"file", "unknown"}


def test_a_directory_where_a_file_was_expected_is_not_an_error(tmp_path):
    (tmp_path / "BUILD_SHA").mkdir()
    # OSError from open() on a directory must be swallowed: /health cannot be
    # the thing that takes the service down.
    info = read_build_info({"BUILD_SHA_FILE": str(tmp_path / "BUILD_SHA")})
    assert info.source in {"file", "unknown"}


def test_undecodable_bytes_do_not_raise(tmp_path):
    written = tmp_path / "BUILD_SHA"
    written.write_bytes(b"\xff\xfe\x00 not a sha")
    assert read_build_info({"BUILD_SHA_FILE": str(written)}).source in {"file", "unknown"}


def test_unknown_build_is_reported_not_omitted():
    assert UNKNOWN_BUILD == ("unknown", "unknown")


def test_build_info_is_memoised(monkeypatch):
    monkeypatch.setenv("BUILD_SHA", SHA)
    first = build_info()
    monkeypatch.setenv("BUILD_SHA", "f" * 40)
    assert build_info() is first, "the running build cannot change without a restart"


def test_health_reports_the_build(monkeypatch):
    monkeypatch.setenv("BUILD_SHA", SHA)
    reset_build_info_cache()
    body = TestClient(app).get("/health").json()
    assert body["build_sha"] == SHA
    assert body["build_sha_source"] == "env"


def test_ready_reports_the_build_too(monkeypatch):
    # The deploy waits on /ready and on /health; both answering the same
    # question means either one can verify a restart.
    monkeypatch.setenv("BUILD_SHA", SHA)
    reset_build_info_cache()
    assert TestClient(app).get("/ready").json()["build_sha"] == SHA


def test_health_still_answers_when_no_provenance_was_recorded(monkeypatch, tmp_path):
    monkeypatch.delenv("BUILD_SHA", raising=False)
    monkeypatch.setenv("BUILD_SHA_FILE", str(tmp_path / "absent"))
    monkeypatch.setattr("app.build_info._default_build_sha_path", lambda: None)
    reset_build_info_cache()
    res = TestClient(app).get("/health")
    assert res.status_code == 200
    assert res.json()["build_sha"] == "unknown"
    assert res.json()["build_sha_source"] == "unknown"
