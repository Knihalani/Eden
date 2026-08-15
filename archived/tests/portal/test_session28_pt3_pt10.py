"""Session 28 tests — Portal critical (PT-3, PT-4, PT-5, PT-6, PT-10).

Five audit items:

* **PT-3** — ``agents/[id]/upload/route.ts`` reads ``orgId`` from
  the query string (``?org_id=...``), not the literal ``{orgId}``
  in the URL template.
* **PT-4** — Sibling routes do the same: ``test-runs``, ``sim-runs``,
  ``test-runs/[run_id]``, ``sim-runs/[run_id]``.
* **PT-5** — Catch-all proxy branches on Content-Type:
  multipart/octet-stream → ``request.formData()`` (preserves the
  multipart boundary); SSE → pipes ``response.body`` through a
  ``ReadableStream`` (no buffering).
* **PT-6** — ``forwardToBackend`` only sets
  ``Content-Type: application/json`` when the body is a plain JSON
  string. Multipart bodies carry their own boundary (fetch() sets
  it when the body is FormData); streamed bodies don't need it.
* **PT-10** — The unconditional ``AbortSignal.timeout(25_000)`` is
  only applied to NON-streaming requests. SSE streams run forever
  (the frontend EventSource tears down on unmount).
"""

from __future__ import annotations

from pathlib import Path

import pytest

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


def _read(rel: str) -> str:
    return (_PORTAL_ROOT / rel).read_text()


# ─── PT-3 + PT-4 — agents routes pull orgId from query ─────────


_AGENT_ROUTES = [
    "src/app/api/agents/[id]/upload/route.ts",
    "src/app/api/agents/[id]/test-runs/route.ts",
    "src/app/api/agents/[id]/sim-runs/route.ts",
    "src/app/api/agents/[id]/test-runs/[run_id]/route.ts",
    "src/app/api/agents/[id]/sim-runs/[run_id]/route.ts",
]


class TestAgentRoutesOrgIdQuery:
    """All 5 agents/ routes now pull ``orgId`` from the query param
    and template it into the URL — no more literal ``{orgId}``.
    """

    @pytest.mark.parametrize("rel", _AGENT_ROUTES)
    def test_no_literal_orgid(self, rel: str) -> None:
        # Strip line comments before the grep — the audit-fix
        # comments mention ``{orgId}`` in prose.
        source = "\n".join(
            line for line in _read(rel).splitlines()
            if not line.lstrip().startswith("//")
        )
        assert "{orgId}" not in source, (
            f"PT-3/PT-4 regression: {rel} still has literal ``{{orgId}}`` "
            f"in the URL template"
        )

    @pytest.mark.parametrize("rel", _AGENT_ROUTES)
    def test_reads_orgid_from_query(self, rel: str) -> None:
        source = _read(rel)
        assert (
            "searchParams.get(\"org_id\")" in source
            or "searchParams.get('org_id')" in source
        ), (
            f"PT-3/PT-4 regression: {rel} must read org_id from query"
        )

    @pytest.mark.parametrize("rel", _AGENT_ROUTES)
    def test_templates_orgid_into_url(self, rel: str) -> None:
        """The pulled orgId must actually be used in the URL
        template (encodeURIComponent + the literal substring
        ``${encodeURIComponent(orgId)}``)."""
        source = _read(rel)
        assert "${encodeURIComponent(orgId)}" in source, (
            f"PT-3/PT-4 regression: {rel} must template orgId into "
            f"the upstream URL (encodeURIComponent)"
        )

    @pytest.mark.parametrize("rel", _AGENT_ROUTES)
    def test_orgid_missing_returns_400(self, rel: str) -> None:
        """Each route surfaces a 400 with a clear ``Missing org_id``
        detail when the caller forgets the query param — better
        than silently 404'ing the backend.
        """
        source = _read(rel)
        assert "Missing org_id" in source, (
            f"PT-3/PT-4 regression: {rel} must return 400 on missing "
            f"org_id query parameter"
        )


# ─── PT-5 + PT-6 + PT-10 — proxy branching & timeout ──────────


class TestProxyBranching:
    """The catch-all proxy branches on inbound Content-Type and the
    requested Accept so multipart uploads keep their boundary and
    SSE streams pipe through a ReadableStream.
    """

    def test_proxy_branches_on_content_type(self) -> None:
        """PT-5 fix: the proxy reads ``content-type`` and uses
        ``request.formData()`` for multipart bodies (preserves
        boundary)."""
        source = _read("src/app/api/proxy/[...path]/route.ts")
        assert "content-type" in source.lower(), (
            "PT-5 regression: proxy must read inbound Content-Type"
        )
        # Multipart body preservation
        assert "multipart/form-data" in source, (
            "PT-5 regression: proxy must branch on multipart/form-data"
        )
        assert "request.formData()" in source, (
            "PT-5 regression: proxy must call request.formData() for multipart"
        )

    def test_proxy_detects_sse(self) -> None:
        """PT-5 fix: the proxy detects Accept: text/event-stream
        and pipes ``response.body`` through a ReadableStream
        (no buffering)."""
        source = _read("src/app/api/proxy/[...path]/route.ts")
        assert "text/event-stream" in source, (
            "PT-5 regression: proxy must detect SSE via "
            "Accept: text/event-stream"
        )
        # SSE piping path
        assert "upstream.body" in source, (
            "PT-5 regression: SSE branch must pass response.body through"
        )


class TestProxyConditionalContentType:
    """PT-6: ``forwardToBackend`` only sets the JSON Content-Type
    when the body is actually JSON. Multipart / streamed bodies
    don't need it (fetch sets multipart boundary automatically;
    raw streams have no Content-Type).
    """

    def test_proxy_conditional_content_type(self) -> None:
        source = _read("src/lib/proxy.ts")
        # ``isStream`` / ``isForm`` booleans are how we branch.
        assert "isStream" in source or "instanceof ReadableStream" in source, (
            "PT-6 regression: proxy must branch on body type "
            "(ReadableStream / FormData / JSON)"
        )
        # The legacy unconditional "Content-Type": "application/json"
        # must be guarded.
        # Look for the assignment block — it must be inside the
        # ``if (!isStream && !isForm)`` guard.
        guarded = 'if (!isStream && !isForm)' in source
        assert guarded, (
            "PT-6 regression: Content-Type default must be guarded by "
            "an isStream/isForm check"
        )


class TestProxyConditionalTimeout:
    """PT-10: the 25s AbortSignal.timeout must NOT be applied to
    streaming requests (SSE) — they'd die at 25s.
    """

    def test_timeout_only_for_non_stream(self) -> None:
        source = _read("src/lib/proxy.ts")
        assert "AbortSignal.timeout(25_000)" in source, (
            "PT-10 regression: 25s timeout must still exist for "
            "non-streaming requests"
        )
        # The timeout must be gated by the streaming branch.
        # The exact pattern in my fix: ``if (!isStream) { fetchInit.signal = ... }``
        assert (
            "if (!isStream)" in source
            and "fetchInit.signal" in source
        ) or (
            # Alternate: signal set conditionally inside the block
            "isStream && fetchInit.signal" in source
            or "stream ? AbortSignal" in source
        ), (
            "PT-10 regression: the 25s timeout must be conditional "
            "on isStream (applied only to non-streaming requests)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
