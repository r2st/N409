"""Response security headers for the FastAPI services (audit B-1, round 74).

The two Fastify services have carried `@fastify/helmet` since the B-1 audit;
the Python pair carried nothing. That asymmetry is easy to wave away — both
bind loopback and sit behind a shared-secret gate — but it is exactly backwards
for the two headers that matter most here:

* ``X-Content-Type-Options: nosniff``. Every route on these services answers
  ``application/json``, and several of them echo caller-supplied strings inside
  it (a 422's ``detail``, a pipeline's ``model``, the engine's validation
  issues). A browser that sniffs such a body as HTML runs it as the service's
  origin. Loopback binding does not help: ``127.0.0.1:3002`` *is* an origin a
  browser on the box will happily fetch, and an operator with the tunnel open
  is the realistic reader.

* ``Content-Security-Policy: default-src 'none'``. These responses load no
  resources at all, so the policy costs nothing and turns any successful sniff
  into an inert document.

The remaining three are defence-in-depth for the same reachable-by-browser
case, and are the same values the Fastify services already send, so a response
that crosses the estate does not change its posture at the hop.

The doc UIs are the one exception. ``/docs`` and ``/redoc`` are HTML pages that
pull Swagger UI and ReDoc from jsDelivr; ``default-src 'none'`` would leave an
operator staring at a blank page and — worse — teach them that the header is
the thing to turn off. They get a policy sized to what they actually load.
"""

from __future__ import annotations

from starlette.datastructures import MutableHeaders

from .asgi import ASGIApp, Receive, Scope, Send

# Sent on every response. `frame-ancestors` duplicates X-Frame-Options on
# purpose: the modern directive is the one browsers honour, the legacy header
# is what a scanner looks for, and they are cheap enough to carry both.
API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

# FastAPI's bundled doc UIs load their JS/CSS from jsDelivr and (ReDoc) a font
# from Google, and Swagger UI injects style attributes. Pinned to those hosts
# rather than dropped, so the pages work and nothing else may load.
_DOCS_CSP = (
    "default-src 'none'; "
    "script-src 'self' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; "
    "img-src 'self' data: https://fastapi.tiangolo.com https://cdn.jsdelivr.net; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'none'"
)

_DOC_PATHS = frozenset({"/docs", "/redoc", "/docs/oauth2-redirect"})

# 180 days, matching the Fastify services. Inert over plaintext — a browser
# ignores HSTS on an http:// response — and correct the moment anything in
# front of these services terminates TLS.
_HSTS = "max-age=15552000; includeSubDomains"

# Every feature this estate never uses from an API response, denied outright.
_PERMISSIONS_POLICY = (
    "accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(), "
    "clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), "
    "fullscreen=(), geolocation=(), gyroscope=(), idle-detection=(), local-fonts=(), "
    "magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), "
    "publickey-credentials-create=(), publickey-credentials-get=(), "
    "screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()"
)


def headers_for(path: str) -> dict[str, str]:
    """The security headers a response on `path` should carry."""
    return {
        "content-security-policy": _DOCS_CSP if path in _DOC_PATHS else API_CSP,
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "strict-transport-security": _HSTS,
        "permissions-policy": _PERMISSIONS_POLICY,
        # These services are not a browser-reachable resource for anyone, so
        # refuse the cross-origin embed that CORP governs. Matches the
        # valuation service's `crossOriginResourcePolicy: same-site`.
        "cross-origin-resource-policy": "same-site",
    }


def make_security_headers_middleware():
    """Middleware stamping {@link headers_for} onto every response.

    Registered outermost (added last) so it also covers the responses the
    layers below return without reaching a route — the 401 from the token gate,
    the 413 from the body cap, the 429 from the rate limiter, and the 500
    envelope. Those are the responses most likely to carry a caller-influenced
    string, so they are the last ones that should go out bare.

    Existing headers are not overwritten: a route that has deliberately set its
    own policy keeps it.
    """

    def factory(app: ASGIApp) -> ASGIApp:
        async def security_headers_middleware(scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            stamped = headers_for(scope["path"])

            async def send_wrapper(message: dict) -> None:
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    for name, value in stamped.items():
                        if name not in headers:
                            headers[name] = value
                await send(message)

            await app(scope, receive, send_wrapper)

        return security_headers_middleware

    return factory
