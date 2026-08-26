"""Container healthcheck probe (round 158).

The image had no HEALTHCHECK at all, so a container reported healthy from the
moment uvicorn forked — an orchestrator would route to a service still starting,
and a wedged process that had stopped answering was never restarted because
nothing asked it.

What these mostly pin is the part that is easy to get wrong *and* looks right:
`urlopen` raises on a refused connection and on every non-2xx, so the naive
one-liner's `.status == 200` comparison is unreachable and the exit code that
actually marks the container unhealthy is an uncaught traceback's. Same number,
different reason, and it cannot tell "nothing is listening" from "answering
503". Both are asserted here as distinct, quiet, code-1 outcomes.
"""

from __future__ import annotations

import http.server
import threading
import urllib.error

import pytest

from app.healthcheck import probe


class _Handler(http.server.BaseHTTPRequestHandler):
    status = 200

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        self.send_response(type(self).status)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_args):  # keep the test output clean
        pass


@pytest.fixture
def server():
    """A real loopback HTTP server, so urlopen's real behaviour is exercised."""

    def _start(status: int = 200):
        _Handler.status = status
        httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        return httpd

    servers: list[http.server.HTTPServer] = []

    def factory(status: int = 200):
        httpd = _start(status)
        servers.append(httpd)
        return str(httpd.server_address[1])

    yield factory
    for httpd in servers:
        httpd.shutdown()
        httpd.server_close()


def test_exits_zero_when_health_answers_200(server):
    assert probe(port=server(200)) == 0


def test_exits_one_when_health_answers_503(server):
    """A started-but-degraded service is unhealthy, not healthy.

    This is the case the naive one-liner never actually evaluated: urlopen
    raises HTTPError here rather than returning a response, so the comparison
    against 200 is never reached.
    """
    assert probe(port=server(503)) == 1


def test_exits_one_when_health_answers_500(server):
    assert probe(port=server(500)) == 1


def test_exits_one_when_nothing_is_listening():
    # Bind and immediately release, so the port is real but refused.
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    assert probe(port=str(port)) == 1


def test_reports_a_refused_connection_quietly(capsys):
    """No traceback. The naive form printed one on every probe of a service
    that was merely still starting up, which is the normal case during boot."""
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()

    probe(port=str(port))
    err = capsys.readouterr().err
    assert "Traceback" not in err
    assert "unreachable" in err


def test_distinguishes_a_bad_status_from_an_unreachable_port(server, capsys):
    """Both exit 1, but an operator reading the health log must be able to tell
    "nothing is listening" from "listening and refusing" — they are different
    things to go and look at."""
    probe(port=server(503))
    degraded = capsys.readouterr().err

    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    probe(port=str(port))
    down = capsys.readouterr().err

    assert "answered 503" in degraded
    assert "unreachable" in down
    assert degraded != down


def test_exits_one_when_port_is_unset(monkeypatch):
    monkeypatch.delenv("PORT", raising=False)
    assert probe() == 1


def test_exits_one_when_port_is_blank(monkeypatch):
    """An empty PORT must not be pasted into the URL to form a probe of
    `http://127.0.0.1:/health`, which fails with a confusing parse error."""
    monkeypatch.setenv("PORT", "   ")
    assert probe() == 1


def test_reads_the_port_from_the_environment(server, monkeypatch):
    """Shell form in the Dockerfile resolves $PORT at run time, so an image
    started on a remapped port probes the port it actually bound."""
    monkeypatch.setenv("PORT", server(200))
    assert probe() == 0


def test_passes_an_explicit_timeout(monkeypatch):
    """urlopen defaults to the global socket timeout, which is None: a probe of
    a wedged socket would block until Docker killed it, recording no reason."""
    seen: dict[str, object] = {}

    def fake_urlopen(url, timeout=None):
        seen["timeout"] = timeout
        raise urllib.error.URLError("nope")

    monkeypatch.setattr("app.healthcheck.urllib.request.urlopen", fake_urlopen)
    assert probe(port="3999") == 1
    assert isinstance(seen["timeout"], (int, float))
    assert 0 < seen["timeout"] <= 5  # inside Docker's --timeout=5s
