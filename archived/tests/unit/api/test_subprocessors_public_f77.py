"""F77 — `/subprocessors` is reachable without auth.

GDPR Art. 28 requires a public list of sub-processors. Auditors
and prospective customers visit this page BEFORE signing up, so
the route MUST be reachable without an ``Authorization`` header.

Pre-F77 the ``DefaultDenyAuthMiddleware`` was 401-ing every
unauthenticated request, including ``/subprocessors``. This
broke the §1.5 compliance audit because the endpoint existed
but was unreachable. F77 adds ``/subprocessors`` to the
``DEFAULT_PUBLIC_PREFIXES`` allowlist.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


class TestF77SubprocessorsPublic:
    """``/subprocessors`` MUST return 200 without any auth header."""

    def test_subprocessors_unauth_returns_200(self) -> None:
        from eden.api.app import app

        c = TestClient(app, raise_server_exceptions=False)
        r = c.get("/subprocessors")
        assert r.status_code == 200, (
            f"F77 regression: GET /subprocessors returned "
            f"{r.status_code}. The endpoint MUST be public per "
            f"GDPR Art. 28 — auditors and prospective customers "
            f"visit it before signing up. DefaultDenyAuthMiddleware "
            f"is rejecting unauthenticated requests."
        )

    def test_subprocessors_returns_list_with_last_updated(self) -> None:
        from eden.api.app import app

        c = TestClient(app, raise_server_exceptions=False)
        r = c.get("/subprocessors")
        assert r.status_code == 200
        body = r.json()
        assert "subprocessors" in body, (
            "F77 regression: /subprocessors response is missing "
            "the 'subprocessors' key. The list MUST be present."
        )
        assert isinstance(body["subprocessors"], list)
        assert len(body["subprocessors"]) >= 1, (
            "F77 regression: /subprocessors returned an empty list. "
            "There must be at least one sub-processor (Postgres, "
            "Redis, or similar)."
        )
        # Every entry has name, purpose, location.
        for entry in body["subprocessors"]:
            assert "name" in entry, f"sub-processor missing 'name': {entry}"
            assert "purpose" in entry, f"sub-processor missing 'purpose': {entry}"
        # last_updated is required by the §1.5 audit.
        assert "last_updated" in body, (
            "F77 regression: /subprocessors response is missing "
            "the 'last_updated' field. GDPR Art. 28 requires this."
        )

    def test_subprocessors_in_public_prefixes(self) -> None:
        """Pin the source-level fact that ``/subprocessors`` is in
        the public-prefix allowlist. A future refactor that
        accidentally drops it would break the §1.5 audit."""
        from eden.api.middleware import default_deny

        with open(default_deny.__file__, encoding="utf-8") as _f:
            text = _f.read()
        assert '"/subprocessors"' in text, (
            "F77 regression: '/subprocessors' is no longer in the "
            "DEFAULT_PUBLIC_PREFIXES tuple in default_deny.py. "
            "The endpoint is now 401-ing for unauthenticated "
            "requestors (auditors, prospective customers)."
        )
