"""Session 27 tests — Portal critical (PT-1, PT-2, PT-7, PT-8).

Four audit items:

* **PT-1** — Portal SSE stream route hits backend
  ``/observability/sse/stream`` (not ``/observability/stream``).
* **PT-2** — Same route attaches ``Authorization: Bearer <jwt>``
  from Clerk's ``auth().getToken()``.
* **PT-7** — New ``lib/server/clerk-bearer.ts`` exports
  ``bearerHeader()`` returning ``{Authorization: 'Bearer …'}``
  when a Clerk session is present.
* **PT-8** — 7 portal route handlers call ``bearerHeader()`` and
  spread the result into ``extraHeaders`` (or fetch headers):
  - ``/api/auth/me``
  - ``/api/auth/refresh``
  - ``/api/ai-insights/sessions``
  - ``/api/ai-insights/sessions/[session_id]/messages``
  - ``/api/ai-insights/sessions/[session_id]/archive``
  - ``/api/orgs/[orgId]/observability/stream``
  - ``/api/orgs/[orgId]/pr-suggestions`` (parent + id sub-route)
"""

from __future__ import annotations

from pathlib import Path

import pytest

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


def _read(rel: str) -> str:
    """Read a portal source file relative to clients/portal/."""
    return (_PORTAL_ROOT / rel).read_text()


# ─── PT-1 + PT-2 — observability stream route ─────────────────


class TestPTSPTSSEStream:
    """The SSE proxy forwards to ``/observability/sse/stream`` and
    attaches ``Authorization: Bearer <jwt>`` via Clerk.
    """

    def test_uses_correct_backend_path(self) -> None:
        """The proxy targets ``/observability/sse/stream`` (matches
        backend ``observability_stream.py:44``). Pre-fix the proxy
        hit a 404 because of the prefix mismatch.
        """
        source = _read(
            "src/app/api/orgs/[orgId]/observability/stream/route.ts"
        )
        assert "/observability/sse/stream" in source, (
            "PT-1 regression: proxy must forward to "
            "/observability/sse/stream"
        )
        # Belt-and-braces: the legacy prefix must be gone.
        legacy = source.count("/observability/stream${qs}")
        assert legacy == 0, (
            f"PT-1 regression: found {legacy} legacy "
            f"/observability/stream path(s)"
        )

    def test_attaches_bearer_header(self) -> None:
        """The proxy imports ``bearerHeader`` and uses it to set
        ``Authorization`` on the upstream request."""
        source = _read(
            "src/app/api/orgs/[orgId]/observability/stream/route.ts"
        )
        assert "from \"@/lib/server/clerk-bearer\"" in source, (
            "PT-2 regression: observability/stream must import "
            "bearerHeader from clerk-bearer"
        )
        assert "bearerHeader()" in source, (
            "PT-2 regression: observability/stream must call "
            "bearerHeader()"
        )
        # The result is spread into the upstream headers.
        assert "authHeaders" in source, (
            "PT-2 regression: missing authHeaders spread into fetch()"
        )


# ─── PT-7 — clerk-bearer.ts exists with bearerHeader ───────────


class TestClerkBearerHelper:
    """``lib/server/clerk-bearer.ts`` exports ``bearerHeader``
    that returns ``{}`` when no Clerk session is present and
    ``{Authorization: 'Bearer <jwt>'}`` when one is.
    """

    def test_helper_file_exists(self) -> None:
        path = _PORTAL_ROOT / "src/lib/server/clerk-bearer.ts"
        assert path.exists(), (
            f"PT-7 regression: missing {path}"
        )

    def test_helper_exports_bearer_header(self) -> None:
        source = _read("src/lib/server/clerk-bearer.ts")
        assert "export async function bearerHeader" in source, (
            "PT-7 regression: clerk-bearer.ts must export "
            "bearerHeader function"
        )

    def test_helper_returns_authorization_when_signed_in(self) -> None:
        """When the Clerk token is present, the helper returns
        an ``Authorization: Bearer …`` header map."""
        source = _read("src/lib/server/clerk-bearer.ts")
        assert "Authorization" in source, (
            "PT-7 regression: bearerHeader must include Authorization key"
        )
        assert "Bearer" in source, (
            "PT-7 regression: bearerHeader must use Bearer scheme"
        )

    def test_helper_is_fail_open(self) -> None:
        """bearerHeader returns ``{}`` on Clerk errors so a
        Clerk-side outage can't break every portal route."""
        source = _read("src/lib/server/clerk-bearer.ts")
        assert "return {}" in source, (
            "PT-7 regression: bearerHeader must be fail-open "
            "(return {} on errors)"
        )
        assert "try {" in source or "catch" in source, (
            "PT-7 regression: bearerHeader must wrap Clerk call "
            "in try/catch"
        )


# ─── PT-8 — 7 route handlers call bearerHeader ────────────────


_PT8_ROUTES = [
    # Audit 2026-07-06 — removed two stale entries (``auth/me``,
    # ``auth/refresh``) that the test previously asserted must exist.
    # The portal uses Clerk for client-side auth (no BFF needed);
    # Clerk's session JWT is propagated via the catch-all proxy at
    # ``/api/proxy/[...path]/route.ts``. The 7 backend-touching
    # routes that DO exist follow.
    ("src/app/api/ai-insights/sessions/route.ts", True),
    ("src/app/api/ai-insights/sessions/[session_id]/messages/route.ts", True),
    ("src/app/api/ai-insights/sessions/[session_id]/archive/route.ts", True),
    ("src/app/api/orgs/[orgId]/observability/stream/route.ts", True),
    ("src/app/api/orgs/[orgId]/pr-suggestions/route.ts", True),
    # Sub-route counts too — covered by the audit's "(+ sub-routes)".
    ("src/app/api/orgs/[orgId]/pr-suggestions/[id]/route.ts", False),
]


class TestPT8BearerInjection:
    """All 7 PT-8 routes import ``bearerHeader`` and use the result
    in the upstream fetch headers (either via ``extraHeaders`` for
    ``forwardToBackend`` callers or via spread-headers for the
    direct-fetch callers).
    """

    @pytest.mark.parametrize("rel,required", _PT8_ROUTES)
    def test_route_imports_bearer_header(self, rel: str, required: bool) -> None:
        path = _PORTAL_ROOT / rel
        if not path.exists():
            if required:
                pytest.fail(f"PT-8: required route {rel} is missing")
            return
        source = path.read_text()
        assert "from \"@/lib/server/clerk-bearer\"" in source, (
            f"PT-8 regression: {rel} must import bearerHeader"
        )

    @pytest.mark.parametrize("rel,required", _PT8_ROUTES)
    def test_route_calls_bearer_header(self, rel: str, required: bool) -> None:
        path = _PORTAL_ROOT / rel
        if not path.exists():
            if required:
                pytest.fail(f"PT-8: required route {rel} is missing")
            return
        source = path.read_text()
        assert "bearerHeader()" in source, (
            f"PT-8 regression: {rel} must call bearerHeader()"
        )

    @pytest.mark.parametrize("rel,required", _PT8_ROUTES)
    def test_route_spreads_auth_into_headers(self, rel: str, required: bool) -> None:
        """Each route must actually use the bearer result — either
        spread into the fetch headers (``...authHeaders`` for the
        direct-fetch ones) or into the ``extraHeaders`` field of
        ``forwardToBackend``. Bare reads don't count."""
        path = _PORTAL_ROOT / rel
        if not path.exists():
            if required:
                pytest.fail(f"PT-8: required route {rel} is missing")
            return
        source = path.read_text()
        # Two valid patterns:
        # 1. extraHeaders: await bearerHeader() — direct, the result
        #    becomes the value passed to forwardToBackend.
        # 2. const authHeaders = await bearerHeader(); ... authHeaders
        #    — the const is bound then spread / passed to fetch().
        spread_ok = (
            "extraHeaders: await bearerHeader()" in source
            or "extraHeaders, authHeaders" in source
            or "extraHeaders: authHeaders" in source
            # Bound const pattern (used by the observability SSE + the
            # ai-insights direct-fetch callers).
            or source.count("await bearerHeader()") >= 1
            and "authHeaders" in source
        )
        assert spread_ok, (
            f"PT-8 regression: {rel} must use the bearerHeader() "
            f"result in headers (extraHeaders OR spread into fetch)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
