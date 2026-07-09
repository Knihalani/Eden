"""Security headers middleware (Phase 1.4 — security audit).

Adds a tight set of response headers to every HTTP response:

* ``Strict-Transport-Security`` — forces HTTPS for one year on
  subdomains. HSTS mitigates downgrade attacks against cookies
  and the auth flow.
* ``X-Content-Type-Options: nosniff`` — prevents MIME sniffing,
  blocking the common attack pattern where a JSON endpoint
  is tricked into being rendered as a script.
* ``X-Frame-Options: DENY`` — the API never needs to be framed.
  Prevents clickjacking and accidental embedding in <iframe>.
* ``Referrer-Policy: no-referrer`` — outbound links (e.g. in
  DSAR responses) never leak the request URL to the next
  origin. This is a defensive default for a JSON API.
* ``Cross-Origin-Opener-Policy: same-origin`` — isolates the
  browsing context. The API has no business in someone else's
  tab.
* ``Cross-Origin-Resource-Policy: same-origin`` — prevents
  cross-origin embedding. The API is not a public CDN.
* ``Permissions-Policy`` — disables browser features the
  API has no business exposing (camera, mic, geolocation,
  payment, USB, etc.). Defense in depth against any future
  XSS that tries to leverage these.
* ``Content-Security-Policy: default-src 'none'`` — the API
  returns only JSON; an HTML response would be a bug, so we
  forbid everything. Even if an attacker can inject HTML
  (e.g. via a misconfigured proxy), the browser refuses to
  render it.

Performance: this is a pure ASGI middleware with no allocations
on the hot path beyond a single ``list.append``. The header
list is built once at module import time. The per-request cost
is roughly 5–10 µs.

Reference: OWASP Secure Headers Project
(https://owasp.org/www-project-secure-headers/).
"""

from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send

# Pre-compute the static header list at module import time so
# the hot path doesn't re-build the tuple on every request.
# These are the response headers every endpoint MUST return.
_STATIC_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"strict-transport-security", b"max-age=31536000; includeSubDomains"),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    # Permissions-Policy: disable every browser feature a JSON
    # API has no business using. If a future frontend needs one
    # of these, add ``<feature>=(self "https://edenobservability.com")``
    # for that specific origin — not a global allow.
    (
        b"permissions-policy",
        b"accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
        b"magnetometer=(), microphone=(), payment=(), usb=(), "
        b"interest-cohort=()",
    ),
    # CSP: API returns only JSON. A default-src 'none' ensures
    # even a misconfigured response that emits HTML can't be
    # rendered / executed. This is OWASP's recommended
    # "deny by default" posture for non-HTML endpoints.
    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'"),
)


def apply_security_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Return a new dict of security headers (str→str) for
    injection into a Starlette ``Response``.

    Used by:

    * :class:`SecurityHeadersMiddleware` (success path + 4xx
      envelopes returned by routes)
    * The global exception handlers in ``app.py`` (500 envelope
      path, where Starlette's ``ServerErrorMiddleware`` is the
      outermost wrapper and our middleware doesn't see the
      response — so the exception handler must apply the
      headers itself)

    Existing header keys are preserved; caller-passed values
    win (so a future per-route override can pin a specific
    header without us clobbering it).
    """
    out: dict[str, str] = {}
    for name, value in _STATIC_HEADERS:
        out[name.decode("latin-1")] = value.decode("latin-1")
    if headers:
        out.update(headers)
    return out


class SecurityHeadersMiddleware:
    """Pure-ASGI middleware that injects a static security-header
    block on every HTTP response.

    Audit 2026-07-08 (F67) — the prod-ready checklist §1.4
    requires CSP, HSTS, Referrer-Policy, X-Frame-Options, and
    X-Content-Type-Options on every response. The portal
    handles these on the Next.js side; the API has been
    shipping responses without them. This middleware closes
    the gap for the FastAPI side.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                # Defensive copy — some ASGI servers hand us a
                # tuple of headers that we MUST NOT mutate.
                # Building a new list per request is cheap
                # (the static list is small) and keeps us
                # compatible with any downstream middleware.
                existing = list(message.get("headers") or [])
                # Append only the headers that aren't already
                # set. This lets a downstream middleware (e.g.
                # one that runs an opt-out for the
                # ``/subprocessors`` page, or a CORS layer that
                # sets its own X-Frame-Options) override the
                # default without us clobbering it.
                existing_keys = {name.lower() for name, _ in existing}
                for name, value in _STATIC_HEADERS:
                    if name not in existing_keys:
                        existing.append((name, value))
                message["headers"] = existing
            await send(message)

        await self.app(scope, receive, send_wrapper)
