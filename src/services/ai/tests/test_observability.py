import json
import logging
import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.observability import _EXTRA_KEYS, JsonLogFormatter, current_request_id, redact

_EXTRA_KEYS_SET = set(_EXTRA_KEYS)

client = TestClient(app)


def test_json_formatter_emits_one_object_with_request_id():
    record = logging.LogRecord("ai", logging.INFO, __file__, 1, "hello", None, None)
    record.http_method = "GET"
    record.status = 200
    line = JsonLogFormatter().format(record)
    parsed = json.loads(line)
    assert parsed["msg"] == "hello"
    assert parsed["level"] == "info"
    assert parsed["http_method"] == "GET"
    assert parsed["status"] == 200
    assert "request_id" in parsed


def test_response_echoes_request_id():
    res = client.get("/health", headers={"x-request-id": "req-abc-123"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "req-abc-123"


def test_request_id_is_minted_when_absent():
    res = client.get("/health")
    assert res.headers.get("x-request-id")
    # A fresh id per request.
    other = client.get("/health")
    assert res.headers["x-request-id"] != other.headers["x-request-id"]


def test_request_id_context_defaults_outside_a_request():
    assert current_request_id() == "-"


def _extra_dicts(source: str) -> list[tuple[int, str]]:
    """Every ``extra={...}`` literal in a source file, with its line number."""
    out: list[tuple[int, str]] = []
    for match in re.finditer(r"extra=\{", source):
        start = match.end() - 1
        depth = 0
        for i in range(start, len(source)):
            if source[i] == "{":
                depth += 1
            elif source[i] == "}":
                depth -= 1
                if depth == 0:
                    out.append((source[: match.start()].count("\n") + 1, source[start + 1 : i]))
                    break
    return out


def _allowlist_of(app_dir: Path) -> set[str]:
    """A service's own ``_EXTRA_KEYS``, read from its source.

    Read rather than imported because only one of the two services is on the
    path in any given test run, and taking this one's list as the answer for
    both is how the census came to be checking `engine-wrapper` against `ai`'s
    fourteen keys. The two lists are not the same: R258 added
    ``relative_error``, ``tolerance`` and ``paths`` to the engine tier alone, so
    a site there passing one of them was an offender by this test's reckoning
    and a correctly logged field by the formatter's.
    """
    source = (app_dir / "observability.py").read_text(encoding="utf-8")
    body = re.search(r"_EXTRA_KEYS\s*=\s*\((.*?)\)", source, re.S)
    assert body, f"no _EXTRA_KEYS in {app_dir}"
    return set(re.findall(r'"([^"]+)"', body.group(1)))


def test_no_call_site_logs_a_key_the_formatter_will_drop():
    """A field the allowlist does not name is discarded in silence.

    ``_EXTRA_KEYS`` is an allowlist on purpose — a caller must not be able to
    widen what reaches disk by adding a key to ``extra``. The cost of that is
    that a call site passing an unlisted key looks, from where it is written,
    exactly like one that works: no error, no warning, and a log line missing
    the one field it was written for. Four sites did precisely this with
    ``detail``, including the line that reports which finish reason truncated a
    completion and the one that reports the malformed value an operator typed
    into a limit — the whole diagnostic content of both, dropped.

    Both services share this formatter, so both trees are walked — and walked
    whole (round 267, methodology M11). ``glob("*.py")`` read the top level of
    each ``app`` and stopped: 11 files under ``ai/app/agents`` and 38 under
    ``engine-wrapper/app/engine`` were outside the population entirely, which is
    the census blind spot this estate keeps rediscovering. Neither package
    passes an ``extra`` today — the engine package holds no loggers at all and
    reports by raising — so the green above was true and would have stayed true
    through the first one that did.
    """
    offenders: list[str] = []
    scanned = 0
    for service in ("ai", "engine-wrapper"):
        app_dir = Path(__file__).resolve().parents[3] / "services" / service / "app"
        allowed = _allowlist_of(app_dir)
        for path in sorted(app_dir.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            scanned += 1
            source = path.read_text(encoding="utf-8")
            for line, body in _extra_dicts(source):
                for key in re.findall(r'"([a-z_]+)"\s*:', body):
                    if key not in allowed:
                        offenders.append(f"{service}/{path.relative_to(app_dir.parent)}:{line} {key}")
    assert offenders == []
    # Vacuity guard: the population is the whole of both trees, not one level.
    assert scanned > 60, scanned


# What a value assigned to the access-log fields is allowed to look like.
#
# ``status`` is the field an operator filters on with ``status >= 500`` and
# ``path`` is the one they group failures by; both only answer if every writer
# means the same thing by them. The expressions here are the whole set the two
# tiers use for their true meaning: an HTTP status read off a response or an
# exception, the status the access-log middleware is reporting, a literal code,
# and the URL path off the request.
_STATUS_VALUES = re.compile(r"^(?:resp\.status_code|exc\.status_code|status|[1-5]\d\d)$")
_PATH_VALUES = re.compile(r"^request\.url\.path$")


def test_no_call_site_puts_a_non_status_in_status_or_a_non_path_in_path():
    """The half the allowlist census cannot see.

    ``_EXTRA_KEYS`` polices which *names* reach the line, and the note on it
    says at length why the five original keys were widened with named
    dimensions: ``status`` held a retry attempt, a token total and a count of
    citations, so ``status >= 500`` matched none of the things it means and
    several of the things it does not; ``path`` held a model id and a provider
    name, so grouping failures by endpoint and by model was one query that
    answered neither.

    Widening the list did not move the call sites, and five in ``websearch.py``
    were still writing the old shape — including ``begin_cooldown``, which put
    the cooldown window in ``status``. The default window is 900 seconds, so on
    stock configuration every search-provider cooldown this service has ever
    taken was a ``warning`` line reading as a 5xx to the one query the field
    exists for.

    So this is the type half of the same census: a name is not enough, the value
    has to mean what the name says. Phrased as "account for every assignment"
    rather than "these known sites are fine", so the next writer to reach for
    ``status`` because it is short has to answer for it here.
    """
    offenders: list[str] = []
    checked = 0
    for service in ("ai", "engine-wrapper"):
        app_dir = Path(__file__).resolve().parents[3] / "services" / service / "app"
        for path in sorted(app_dir.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            source = path.read_text(encoding="utf-8")
            for line, body in _extra_dicts(source):
                for key, value in re.findall(r'"(status|path)"\s*:\s*([^,}\n]+)', body):
                    checked += 1
                    pattern = _STATUS_VALUES if key == "status" else _PATH_VALUES
                    if not pattern.match(value.strip()):
                        where = path.relative_to(app_dir.parent)
                        offenders.append(f"{service}/{where}:{line} {key}={value.strip()}")
    assert offenders == []
    # Vacuity guard: the access log, the rate limiter and both error handlers
    # write these fields on every tier, so nothing under a dozen means the
    # scanner has stopped finding the assignments it is meant to be judging.
    assert checked >= 12, checked


def test_the_two_services_allowlists_have_not_silently_diverged():
    """The ai tier's list must stay a subset of the engine tier's.

    Not because they must be equal — R258 gave the engine three dimensions the
    AI service has no use for — but because the *shared* formatter is copied
    between them byte for byte, and a key added to one tier's list and not the
    other is a field that logs on one service and vanishes on the other, from
    call sites that read identically.
    """
    root = Path(__file__).resolve().parents[3] / "services"
    ai = _allowlist_of(root / "ai" / "app")
    engine = _allowlist_of(root / "engine-wrapper" / "app")
    assert ai == _EXTRA_KEYS_SET
    assert ai - engine == set(), sorted(ai - engine)


def test_the_allowlist_is_still_an_allowlist():
    """Widening it with named dimensions must not have made it a passthrough."""
    record = logging.LogRecord("ai", logging.INFO, __file__, 1, "hello", None, None)
    record.prompt = "the entire document we just sent a model"
    parsed = json.loads(JsonLogFormatter().format(record))
    assert "prompt" not in parsed


def test_named_dimensions_reach_the_line():
    """The fields that were being smuggled through ``path`` and ``status``."""
    record = logging.LogRecord("ai", logging.WARNING, __file__, 1, "llm 5xx, retrying", None, None)
    record.event = "llm_retry"
    record.model = "openai/gpt-4o-mini"
    record.attempt = 2
    record.status = 503
    parsed = json.loads(JsonLogFormatter().format(record))
    # The model is its own field, so "group the failures by model" is a query
    # rather than a substring match against a field named for URL paths.
    assert parsed["model"] == "openai/gpt-4o-mini"
    assert parsed["attempt"] == 2
    # And `status` means what an access log means by it.
    assert parsed["status"] == 503


def test_a_string_dimension_is_redacted_like_the_message():
    """`detail` carries free text, which in this tier can quote an input."""
    record = logging.LogRecord(
        "ai", logging.WARNING, __file__, 1, "limit misconfigured", None, None
    )
    record.detail = "contact analyst@example.com"
    parsed = json.loads(JsonLogFormatter().format(record))
    assert parsed["detail"] == "contact [EMAIL]"


def test_a_canonical_e164_number_is_redacted():
    """The one phone shape this platform stores, and the one the rule missed.

    ``domain/phone.ts`` normalizes every accepted number to canonical E.164 on
    the way into ``users.phone`` and ``contact_submissions.phone``, so E.164 is
    what a document excerpt or a quoted-back row carries. The separated rule
    beside this one requires a separator between the groups and therefore could
    not match it: the phone net existed and could not see the platform's own
    format.
    """
    assert redact("call +15551234567 back") == "call [PHONE] back"
    assert redact("+442079460000 rang") == "[PHONE] rang"
    # The form a person types is still caught by the rule that was already here.
    assert redact("rang (415) 555-0143 twice") == "rang [PHONE] twice"


def test_a_valuations_own_figures_are_not_phone_numbers():
    """The leading ``+`` is what keeps this rule off the numbers this tier prints.

    A share count, a cent amount and an epoch are all long digit runs, and a
    timezone offset is a plus followed by digits — but it begins with a zero,
    which is not an E.164 country code.
    """
    for benign in (
        "fully diluted 12345678901 shares",
        "total 5,000,000 cents",
        "at 1756612800000",
        "stamped +0530",
        "offset +05:30",
    ):
        assert redact(benign) == benign, benign


def test_an_absurd_inbound_request_id_is_not_adopted():
    """The rule `packages/shared` states for the three Fastify services.

    Those validate the header before adopting it; these two took it verbatim,
    so a caller could name itself with 8 KB that then rode every line of a
    five-service trace. The request is still served and still correlated —
    under the id this hop would have minted anyway.
    """
    res = client.get("/health", headers={"x-request-id": "x" * 200})
    assert res.status_code == 200
    assert res.headers["x-request-id"] != "x" * 200
    assert len(res.headers["x-request-id"]) <= 128


def test_an_inbound_request_id_that_would_not_survive_a_grep_is_not_adopted():
    # An id is a value things are joined on. The formatter escapes a newline
    # rather than letting it forge a second log line, but neither a space nor a
    # control character survives the journal query a join is made of.
    for hostile in ["has space", "semi;colon", "quote\"mark"]:
        res = client.get("/health", headers={"x-request-id": hostile})
        assert res.status_code == 200
        assert res.headers["x-request-id"] != hostile


def test_an_ordinary_traced_id_is_still_adopted():
    # The whole point of adopting one at all: the caller's id, not a fresh one
    # per hop. A UUID, a ULID and a W3C trace id all pass.
    for ok in [
        "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "req-abc-123",
    ]:
        res = client.get("/health", headers={"x-request-id": ok})
        assert res.headers["x-request-id"] == ok
