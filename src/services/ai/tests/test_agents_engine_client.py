"""The market-data client's only job is to fail in one predictable way.

``comp_selection`` calls ``verify_tickers`` to check the tickers a model
proposed against real reference data, and catches exactly one exception:

    except EngineError as exc:
        engine_ok = False

Anything else that comes out of this module is not caught by anyone. The agent
crashes, and a 409A run dies because a market-data lookup — whose result is
optional by design, since the agent has a documented fallback to model-only
multiples — did not answer the way it was expected to.

So these tests are less about the happy path than about the promise in the
docstring: *raises EngineError on any transport/HTTP failure*. Each test drives
one realistic way the engine can fail to answer and asserts the module converts
it, because every conversion it misses is an outage that reads as a bug.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.agents.engine import ENGINE_TIMEOUT_S, EngineError, verify_tickers

TICKERS = ["MSFT", "CRM"]

PAYLOAD = {
    "companies": [{"ticker": "MSFT", "sic_code": "7372", "ev_revenue": 11.2}],
    "not_found": ["CRM"],
    "count": 1,
}


def transport(handler) -> httpx.Client:
    """An httpx client wired to a handler instead of a socket."""
    return httpx.Client(transport=httpx.MockTransport(handler))


def responds(status: int, *, json_body=None, text: str | None = None):
    def _handler(request: httpx.Request) -> httpx.Response:
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=json_body)

    return _handler


class TestTheHappyPath:
    def test_returns_the_engine_payload_unchanged(self) -> None:
        with transport(responds(200, json_body=PAYLOAD)) as http:
            assert verify_tickers(TICKERS, client=http) == PAYLOAD

    def test_posts_the_tickers_to_the_market_data_endpoint(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=PAYLOAD)

        with transport(handler) as http:
            verify_tickers(TICKERS, client=http)
        assert seen["url"].endswith("/engine/v1/market-data")
        assert seen["body"] == {"tickers": TICKERS}

    def test_an_empty_ticker_list_never_touches_the_network(self) -> None:
        # The agent can legitimately propose nothing; that must not become a
        # request, let alone a failed one that flips engine_ok to False.
        def explode(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError("no request should be made for an empty list")

        with transport(explode) as http:
            assert verify_tickers([], client=http) == {
                "companies": [],
                "not_found": [],
                "count": 0,
            }


class TestFailuresBecomeEngineError:
    """Every one of these reaches `except EngineError` or crashes the agent."""

    @pytest.mark.parametrize(
        "exc",
        [
            httpx.ConnectError("connection refused"),
            httpx.ConnectTimeout("timed out connecting"),
            httpx.ReadTimeout("timed out reading"),
            httpx.RemoteProtocolError("server disconnected"),
        ],
        ids=["refused", "connect-timeout", "read-timeout", "disconnected"],
    )
    def test_transport_failures_are_converted(self, exc: Exception) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise exc

        with transport(handler) as http:
            with pytest.raises(EngineError, match="market-data request failed"):
                verify_tickers(TICKERS, client=http)

    @pytest.mark.parametrize("status", [400, 404, 422, 500, 502, 503])
    def test_any_non_200_is_converted_and_names_the_status(self, status: int) -> None:
        with transport(responds(status, text="upstream said no")) as http:
            with pytest.raises(EngineError, match=f"market-data HTTP {status}"):
                verify_tickers(TICKERS, client=http)

    def test_a_200_carrying_html_is_converted_rather_than_crashing_the_agent(self) -> None:
        # The regression this module was missing. A proxy or ingress in front of
        # the engine answers with its own error page and a 200; `resp.json()`
        # then raises JSONDecodeError, which is a ValueError — neither an
        # httpx.HTTPError nor an EngineError — so it escaped the module and the
        # caller's `except EngineError` never saw it.
        body = "<html><body><h1>502 Bad Gateway</h1></body></html>"
        with transport(responds(200, text=body)) as http:
            with pytest.raises(EngineError, match="non-JSON body"):
                verify_tickers(TICKERS, client=http)

    def test_a_truncated_json_body_is_converted_too(self) -> None:
        with transport(responds(200, text='{"companies": [{"ticker": "MS')) as http:
            with pytest.raises(EngineError, match="non-JSON body"):
                verify_tickers(TICKERS, client=http)

    @pytest.mark.parametrize(
        "body", [[], ["MSFT"], "ok", 42], ids=["empty-list", "list", "string", "number"]
    )
    def test_a_valid_json_body_that_is_not_an_object_is_converted(self, body) -> None:
        # `data.setdefault` and `verified.get("companies")` both assume a dict.
        with transport(responds(200, json_body=body)) as http:
            with pytest.raises(EngineError, match="non-object body"):
                verify_tickers(TICKERS, client=http)

    def test_nothing_escapes_as_a_bare_exception(self) -> None:
        # The property the caller actually depends on, stated once directly:
        # whatever goes wrong, it is an EngineError on the way out.
        cases = [
            responds(200, text="not json"),
            responds(500, text="boom"),
            responds(200, json_body=["wrong shape"]),
        ]
        for handler in cases:
            with transport(handler) as http:
                with pytest.raises(EngineError):
                    verify_tickers(TICKERS, client=http)


class TestTheShapeTheCallerReliesOn:
    def test_missing_keys_are_defaulted_so_the_merge_cannot_keyerror(self) -> None:
        # _merge_verified reads verified.get("companies"); the engine omitting
        # either key must not turn into a different kind of failure.
        with transport(responds(200, json_body={"count": 0})) as http:
            data = verify_tickers(TICKERS, client=http)
        assert data["companies"] == []
        assert data["not_found"] == []

    def test_present_keys_are_left_alone(self) -> None:
        with transport(responds(200, json_body=PAYLOAD)) as http:
            data = verify_tickers(TICKERS, client=http)
        assert data["companies"] == PAYLOAD["companies"]
        assert data["not_found"] == ["CRM"]


class TestConfiguration:
    def test_the_engine_url_comes_from_the_environment(self, monkeypatch) -> None:
        monkeypatch.setenv("ENGINE_URL", "http://engine.internal:9999/")
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=PAYLOAD)

        with transport(handler) as http:
            verify_tickers(TICKERS, client=http)
        # The trailing slash is stripped, so the path is not doubled.
        assert seen["url"] == "http://engine.internal:9999/engine/v1/market-data"

    def test_an_unset_engine_url_falls_back_to_the_local_default(self, monkeypatch) -> None:
        monkeypatch.delenv("ENGINE_URL", raising=False)
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=PAYLOAD)

        with transport(handler) as http:
            verify_tickers(TICKERS, client=http)
        assert seen["url"] == "http://127.0.0.1:3003/engine/v1/market-data"

    def test_the_client_it_owns_carries_a_timeout(self) -> None:
        # When no client is injected the module builds its own, and that one has
        # to carry a deadline or a silent engine parks the agent indefinitely.
        assert ENGINE_TIMEOUT_S > 0

    def test_an_injected_client_is_left_open_for_its_owner(self) -> None:
        # `owns` decides who closes: closing a caller's shared client here would
        # break every later call made through it.
        http = transport(responds(200, json_body=PAYLOAD))
        verify_tickers(TICKERS, client=http)
        assert not http.is_closed
        http.close()
