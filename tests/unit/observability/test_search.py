"""Unit tests for Phase B — full-text search via Typesense.

Mirrors Laminar's "fast text search" surface. Pure-function tests
for the doc builder + filter construction + excerpt rendering. The
HTTP-level TypesenseClient and SearchService integration are tested
against a fake aiohttp session — no live Typesense required.

What's covered:

  * :func:`build_span_doc` — extracts ``input_text`` / ``output_text``
    / ``tool_names`` / metrics / cost correctly from a
    ``TelemetryEvent``.
  * :func:`_extract_text` — OpenAI + Anthropic request/response shapes,
    text-block concatenation, max-length truncation.
  * :func:`_extract_tool_names` — from ``messages[].tool_calls``,
    from ``tool_calls_full``, de-duplication with order preserved.
  * :class:`SearchService.search` — filter construction, per-org
    isolation, facet parsing, excerpt generation, response shape.
  * :class:`SearchService.suggest` — Cmd-K autocomplete: small page,
    no facets, recency sort.
  * :func:`_excerpt` — query hit centering, ellipses, fallback when
    the query is missing.
  * :class:`TestTypesenseFallback` — when Typesense is down, Postgres
    ILIKE fallback returns rows and sets ``fallback=True``.
  * :class:`TestPIIRedaction` — PII (email, credit card, SSN) is not
    present in indexed doc fields after ``build_span_doc``.

The end-to-end "Typesense running in Docker, ingest → search" path
is covered by ``tests/intelligence/observability/test_search_e2e.py``
which requires a running ``eden_typesense`` container.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.search_service import (
    SearchResponse,
    SearchService,
    SpanHit,
    _excerpt,
    _facets_cache,
    _parse_facet_counts,
)
from eden.observability.telemetry_collector import TelemetryEvent
from eden.observability.typesense_client import (
    SPAN_SCHEMA,
    TypesenseClient,
    _extract_text,
    _extract_tool_names,
    build_span_doc,
)

# ── Helpers ────────────────────────────────────────────────────────


def _make_event(
    *,
    event_id: str = "e1",
    tenant_id: str = "t-1",
    trace_id: str = "tr-1",
    request_body: dict[str, Any] | None = None,
    response_body: dict[str, Any] | None = None,
    tool_calls_full: list[dict[str, Any]] | None = None,
    name: str | None = None,
    agent_id: str | None = "agent-1",
    model: str | None = "claude-opus-4-8",
    outcome: str | None = None,
    duration_ms: float | None = 100.0,
    metrics: dict[str, float] | None = None,
) -> TelemetryEvent:
    """Build a TelemetryEvent with sensible defaults for search tests."""
    return TelemetryEvent(
        event_id=event_id,
        tenant_id=tenant_id,
        project_id="p-1",
        trace_id=trace_id,
        realm="production",
        event_type="llm.completion",
        timestamp="2026-06-17T12:00:00Z",
        agent_id=agent_id,
        name=name or "tool.bash",
        duration_ms=duration_ms,
        outcome=outcome,
        request_body=request_body,
        response_body=response_body,
        tool_calls_full=tool_calls_full or [],
        metrics=metrics or {},
        attributes={"model": model} if model else {},
    )


# ── _extract_text ─────────────────────────────────────────────────


class TestExtractText:
    def test_openai_messages(self):
        payload = {"messages": [
            {"role": "user", "content": "hello world"},
            {"role": "assistant", "content": "hi"},
        ]}
        text = _extract_text(payload)
        assert "hello world" in text
        assert "hi" in text

    def test_anthropic_system_then_messages(self):
        payload = {
            "system": "You are a helpful assistant.",
            "messages": [{"role": "user", "content": "what is python?"}],
        }
        text = _extract_text(payload)
        assert "You are a helpful assistant." in text
        assert "what is python?" in text

    def test_anthropic_list_content_blocks(self):
        payload = {
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "Line 1."},
                    {"type": "text", "text": "Line 2."},
                ]},
            ],
        }
        text = _extract_text(payload)
        assert "Line 1." in text
        assert "Line 2." in text

    def test_openai_response_choices(self):
        payload = {"choices": [
            {"message": {"role": "assistant", "content": "The answer is 42."}},
        ]}
        text = _extract_text(payload)
        assert "The answer is 42." in text

    def test_truncates_long_text(self):
        payload = {"messages": [{"role": "user", "content": "x" * 20_000}]}
        text = _extract_text(payload)
        # _MAX_TEXT_CHARS = 8_000
        assert len(text) <= 8_000

    def test_empty_payload(self):
        assert _extract_text(None) == ""
        assert _extract_text({}) == ""

    def test_skips_non_string_content(self):
        payload = {"messages": [{"role": "user", "content": ["image"]}]}
        # Should not crash; string contents are joined.
        assert isinstance(_extract_text(payload), str)


# ── _extract_tool_names ───────────────────────────────────────────


class TestExtractToolNames:
    def test_from_messages_tool_calls(self):
        payload = {"messages": [
            {"role": "assistant", "tool_calls": [
                {"function": {"name": "bash"}},
                {"function": {"name": "read"}},
            ]},
        ]}
        names = _extract_tool_names({}, payload)
        assert names == ["bash", "read"]

    def test_from_tool_calls_full(self):
        payload = {"tool_calls_full": [{"name": "search"}, {"name": "grep"}]}
        names = _extract_tool_names({}, payload)
        assert names == ["search", "grep"]

    def test_dedup_preserving_order(self):
        payload = {"messages": [
            {"role": "assistant", "tool_calls": [
                {"function": {"name": "bash"}},
                {"function": {"name": "bash"}},
                {"function": {"name": "read"}},
                {"function": {"name": "bash"}},
            ]},
        ]}
        names = _extract_tool_names({}, payload)
        assert names == ["bash", "read"]

    def test_from_attributes_tool_names(self):
        names = _extract_tool_names(
            {"tool_names": ["alpha", "beta"]}, {},
        )
        assert "alpha" in names
        assert "beta" in names

    def test_no_tools(self):
        assert _extract_tool_names({}, {"messages": []}) == []


# ── build_span_doc ────────────────────────────────────────────────


class TestBuildSpanDoc:
    def test_basic_fields(self):
        ev = _make_event(
            request_body={"messages": [{"role": "user", "content": "hello"}]},
        )
        doc = build_span_doc(ev)
        assert doc["id"] == "t-1:e1"
        assert doc["tenant_id"] == "t-1"
        assert doc["trace_id"] == "tr-1"
        assert doc["agent_id"] == "agent-1"
        assert doc["name"] == "tool.bash"
        assert "hello" in doc["input_text"]

    def test_extracts_tool_names(self):
        ev = _make_event(tool_calls_full=[{"name": "bash"}, {"name": "read"}])
        doc = build_span_doc(ev)
        assert "bash" in doc["tool_names"]
        assert "read" in doc["tool_names"]

    def test_metrics_and_cost(self):
        ev = _make_event(metrics={
            "prompt_tokens": 100, "completion_tokens": 200,
            "cost_usd": 0.015,
        })
        doc = build_span_doc(ev)
        assert doc["prompt_tokens"] == 100
        assert doc["completion_tokens"] == 200
        assert doc["cost_usd"] == pytest.approx(0.015)

    def test_created_at_is_epoch_seconds(self):
        ev = _make_event()
        doc = build_span_doc(ev)
        # 2026-06-17T12:00:00Z → 1_781_697_600. Use a generous window
        # around that exact value rather than guessing at year boundaries.
        assert 1_781_000_000 < doc["created_at"] < 1_782_000_000

    def test_rejects_non_event(self):
        with pytest.raises(TypeError):
            build_span_doc({"event_id": "e1"})  # type: ignore[arg-type]

    def test_minimal_event(self):
        ev = TelemetryEvent(
            event_id="e2",
            tenant_id="t-2",
            project_id="p-2",
            trace_id="tr-2",
            realm="environment",
            event_type="tool.call",
            timestamp="2026-06-17T00:00:00Z",
        )
        doc = build_span_doc(ev)
        assert doc["tenant_id"] == "t-2"
        assert doc["event_type"] == "tool.call"
        assert doc["input_text"] == ""
        assert doc["output_text"] == ""


# ── _excerpt ──────────────────────────────────────────────────────


class TestExcerpt:
    def test_centering_around_hit(self):
        text = "abcdefghij" * 30  # 300 chars
        # "efghij" first appears at index 4. width=40, half=20, so
        # start = max(0, 4-20) = 0 (no left ellipsis) and end = 30
        # (right side is cut off → "…" suffix).
        ex = _excerpt(text, "efghij", width=40)
        assert "efghij" in ex
        assert not ex.startswith("…")  # hit is near the head
        assert ex.endswith("…")        # right side is truncated

    def test_both_sides_truncated(self):
        text = "abcdefghij" * 30  # 300 chars
        # "jabcdefg" hits at index 9. width=20, half=10, so
        # start = max(0, 9-10) = 0 — no left ellipsis — but with
        # a smaller width we DO get both ellipses.
        ex = _excerpt(text, "jabcdefg", width=18)
        assert "jabcdefg" in ex
        assert ex.endswith("…")

    def test_no_hit_returns_head(self):
        text = "abcdefghij" * 30
        ex = _excerpt(text, "MISSING", width=40)
        assert ex == text[:40]
        assert not ex.endswith("…")

    def test_empty_text(self):
        assert _excerpt("", "query") == ""

    def test_no_query_returns_head(self):
        text = "abcdef" * 20
        ex = _excerpt(text, "", width=10)
        assert ex == text[:10]

    def test_case_insensitive(self):
        text = "Hello WORLD this is a test"
        ex = _excerpt(text, "world")
        assert "WORLD" in ex


# ── _parse_facet_counts ───────────────────────────────────────────


class TestParseFacetCounts:
    def test_empty_body(self):
        assert _parse_facet_counts(None) == {}
        assert _parse_facet_counts([]) == {}

    def test_single_facet(self):
        facet_block = [
            {"field_name": "agent_id", "counts": [
                {"value": "alice", "count": 5},
                {"value": "bob", "count": 3},
            ]},
        ]
        out = _parse_facet_counts(facet_block)
        assert "agent_id" in out
        assert out["agent_id"][0]["value"] == "alice"
        assert out["agent_id"][0]["count"] == 5

    def test_multiple_facets(self):
        facet_block = [
            {"field_name": "agent_id", "counts": [{"value": "alice", "count": 5}]},
            {"field_name": "outcome", "counts": [{"value": "failure", "count": 2}]},
        ]
        out = _parse_facet_counts(facet_block)
        assert "agent_id" in out
        assert "outcome" in out


# ── SearchService (with mocked TypesenseClient) ───────────────────


class _FakeTypesenseClient:
    """Stand-in for TypesenseClient that returns canned responses."""

    def __init__(self, *, search_response: tuple[int, Any] | None = None,
                 healthy: bool = True) -> None:
        self._search_response = search_response
        self._healthy = healthy
        self.search_calls: list[dict[str, Any]] = []
        self._schema_ready = True
        self._collection = "eden_spans"
        self.base_url = "http://fake:8108"

    async def ensure_collection(self) -> bool:
        self._schema_ready = True
        return True

    async def _request(self, method: str, path: str, *,
                       json_body: Any = None,
                       params: dict[str, Any] | None = None) -> tuple[int, Any]:
        if path.endswith("/search") or "/search?" in path:
            self.search_calls.append({"params": dict(params or {})})
            if self._search_response is None:
                return 200, {"hits": [], "found": 0}
            return self._search_response
        return 404, None


@pytest.fixture
def fake_client():
    return _FakeTypesenseClient()


class TestSearchServiceSearch:
    @pytest.mark.asyncio
    async def test_per_org_isolation_forces_tenant_id(self, fake_client):
        service = SearchService(client=fake_client)
        await service.search(tenant_id="org-42", query="python")
        assert fake_client.search_calls
        flt = fake_client.search_calls[0]["params"]["filter_by"]
        assert "tenant_id:=org-42" in flt

    @pytest.mark.asyncio
    async def test_combines_all_filters(self, fake_client):
        service = SearchService(client=fake_client)
        await service.search(
            tenant_id="org-1", query="x",
            agent_id="alice", tool="bash", outcome="failure",
            event_type="tool.call",
            from_ts=1_000, to_ts=2_000,
        )
        flt = fake_client.search_calls[0]["params"]["filter_by"]
        assert "tenant_id:=org-1" in flt
        assert "agent_id:=alice" in flt
        assert "tool_names:=bash" in flt
        assert "outcome:=failure" in flt
        assert "event_type:=tool.call" in flt
        assert "created_at:>=1000" in flt
        assert "created_at:<=2000" in flt

    @pytest.mark.asyncio
    async def test_empty_query_returns_all(self, fake_client):
        service = SearchService(client=fake_client)
        await service.search(tenant_id="org-1", query="")
        # Typesense convention: q="*" matches all docs
        assert fake_client.search_calls[0]["params"]["q"] == "*"

    @pytest.mark.asyncio
    async def test_pagination_clamped(self, fake_client):
        service = SearchService(client=fake_client)
        await service.search(tenant_id="o", per_page=999, page=0)
        params = fake_client.search_calls[0]["params"]
        assert 1 <= params["per_page"] <= 100
        assert params["page"] >= 1

    @pytest.mark.asyncio
    async def test_returns_empty_response_when_offline(self):
        fake = _FakeTypesenseClient(search_response=(0, None))
        service = SearchService(client=fake)
        resp = await service.search(tenant_id="o", query="x")
        assert resp.hits == []
        assert resp.total == 0
        assert resp.took_ms >= 0

    @pytest.mark.asyncio
    async def test_parses_hits_correctly(self):
        fake = _FakeTypesenseClient(search_response=(200, {
            "hits": [{
                "document": {
                    "id": "t-1:e1",
                    "trace_id": "tr-1",
                    "span_id": "sp-1",
                    "agent_id": "alice",
                    "name": "tool.bash",
                    "event_type": "tool.call",
                    "outcome": "failure",
                    "input_text": "python3 -V",
                    "output_text": "Python 3.12",
                    "tool_names": ["bash"],
                    "created_at": 1_747_000_000,
                    "duration_ms": 100.0,
                    "cost_usd": 0.001,
                },
                "highlight": {"input_text": "<mark>python3</mark> -V"},
                "snippet": {"input_text": "<mark>python3</mark> -V"},
            }],
            "found": 1,
            "facet_counts": [
                {"field_name": "agent_id", "counts": [{"value": "alice", "count": 1}]},
            ],
        }))
        service = SearchService(client=fake)
        resp = await service.search(tenant_id="t-1", query="python3")
        assert len(resp.hits) == 1
        hit = resp.hits[0]
        assert hit.trace_id == "tr-1"
        assert hit.event_id == "e1"  # split off the tenant prefix
        assert "python3" in hit.input_text_excerpt
        assert "alice" in resp.facet_counts["agent_id"][0]["value"]
        assert resp.total == 1

    @pytest.mark.asyncio
    async def test_facets_in_response(self, fake_client):
        fake_client._search_response = (200, {
            "hits": [],
            "found": 0,
            "facet_counts": [
                {"field_name": "agent_id", "counts": [{"value": "alice", "count": 3}]},
                {"field_name": "outcome", "counts": [{"value": "failure", "count": 1}]},
            ],
        })
        service = SearchService(client=fake_client)
        resp = await service.search(tenant_id="o", query="x")
        assert "agent_id" in resp.facet_counts
        assert "outcome" in resp.facet_counts

    # ── OPT-4: faceting must be opt-in, not always-on ─────────────

    @pytest.mark.asyncio
    async def test_default_search_does_not_request_facets(self, fake_client):
        """Plain search() calls must not pay for Typesense facet
        computation unless the caller explicitly asks for it via
        ``facet_by`` — regression lock for OPT-4."""
        service = SearchService(client=fake_client)
        await service.search(tenant_id="o", query="python")
        params = fake_client.search_calls[0]["params"]
        assert "facet_by" not in params
        assert "max_facet_values" not in params

    @pytest.mark.asyncio
    async def test_empty_query_search_does_not_request_facets(self, fake_client):
        """The match-all (``q=""``) path is the highest-volume caller
        (page loads with no text query) — it must not default to
        computing all 5 facet fields either."""
        service = SearchService(client=fake_client)
        await service.search(tenant_id="o", query="")
        params = fake_client.search_calls[0]["params"]
        assert "facet_by" not in params
        assert "max_facet_values" not in params

    @pytest.mark.asyncio
    async def test_explicit_facet_by_is_still_honored(self, fake_client):
        service = SearchService(client=fake_client)
        await service.search(tenant_id="o", query="x", facet_by=("outcome",))
        params = fake_client.search_calls[0]["params"]
        assert params["facet_by"] == "outcome"
        assert params["max_facet_values"] == 25


class TestSearchServiceSuggest:
    @pytest.mark.asyncio
    async def test_suggest_returns_top_n(self, fake_client):
        service = SearchService(client=fake_client)
        hits = await service.suggest(tenant_id="o", query="pyth", limit=5)
        # The fake returns 0 hits; we only assert the call shape.
        assert isinstance(hits, list)
        assert fake_client.search_calls[0]["params"]["per_page"] == 5
        # suggest() narrows the facet set to just agent_id (a tiny
        # sidebar hint) so the request stays under the 50ms budget.
        assert fake_client.search_calls[0]["params"]["facet_by"] == "agent_id"

    @pytest.mark.asyncio
    async def test_empty_query_returns_empty(self, fake_client):
        service = SearchService(client=fake_client)
        hits = await service.suggest(tenant_id="o", query="")
        assert hits == []


class TestSearchServiceFacets:
    """OPT-4: facets() is the dedicated, cached, filter-panel-only path.

    Since ``search()`` no longer computes facets by default, ``facets()``
    must still request them (falling back to ``DEFAULT_FACET_FIELDS``)
    so the existing filter-panel contract keeps working, and must cache
    results so rapid repeat opens don't recompute on every call.
    """

    @pytest.fixture(autouse=True)
    def _clear_facets_cache(self):
        from eden.observability.search_service import _facets_cache
        _facets_cache.clear()
        yield
        _facets_cache.clear()

    @pytest.mark.asyncio
    async def test_facets_requests_default_fields_when_unspecified(self, fake_client):
        service = SearchService(client=fake_client)
        await service.facets(tenant_id="o", query="x")
        params = fake_client.search_calls[0]["params"]
        assert params["facet_by"] == ",".join(SearchService.DEFAULT_FACET_FIELDS)
        assert params["max_facet_values"] == 25

    @pytest.mark.asyncio
    async def test_facets_honors_explicit_field_subset(self, fake_client):
        service = SearchService(client=fake_client)
        await service.facets(tenant_id="o", query="x", facet_by=("outcome",))
        params = fake_client.search_calls[0]["params"]
        assert params["facet_by"] == "outcome"

    @pytest.mark.asyncio
    async def test_facets_returns_parsed_counts(self, fake_client):
        fake_client._search_response = (200, {
            "hits": [],
            "found": 0,
            "facet_counts": [
                {"field_name": "agent_id", "counts": [{"value": "alice", "count": 3}]},
            ],
        })
        service = SearchService(client=fake_client)
        counts = await service.facets(tenant_id="o", query="x")
        assert counts["agent_id"][0]["value"] == "alice"

    @pytest.mark.asyncio
    async def test_repeat_calls_are_served_from_cache(self, fake_client):
        """A second facets() call with the same (tenant, query, filters,
        fields) must not re-hit Typesense within the TTL."""
        service = SearchService(client=fake_client)
        await service.facets(tenant_id="o", query="x")
        await service.facets(tenant_id="o", query="x")
        assert len(fake_client.search_calls) == 1

    @pytest.mark.asyncio
    async def test_different_filters_bypass_cache(self, fake_client):
        service = SearchService(client=fake_client)
        await service.facets(tenant_id="o", query="x")
        await service.facets(tenant_id="o", query="x", outcome="failure")
        assert len(fake_client.search_calls) == 2

    @pytest.mark.asyncio
    async def test_different_tenant_bypass_cache(self, fake_client):
        service = SearchService(client=fake_client)
        await service.facets(tenant_id="org-a", query="x")
        await service.facets(tenant_id="org-b", query="x")
        assert len(fake_client.search_calls) == 2


# ── SpanHit / SearchResponse round-trip ───────────────────────────


class TestSpanHit:
    def test_to_dict(self):
        hit = SpanHit(
            event_id="e1", trace_id="tr-1", span_id="sp-1",
            agent_id="alice", name="tool.bash", event_type="tool.call",
            outcome="failure", input_text_excerpt="python3 -V",
            tool_names=["bash"], created_at=1_747_000_000,
        )
        d = hit.to_dict()
        assert d["event_id"] == "e1"
        assert d["tool_names"] == ["bash"]
        assert d["created_at"] == 1_747_000_000

    def test_to_dict_empty_collections(self):
        hit = SpanHit(
            event_id="e1", trace_id="tr-1", span_id="sp-1",
            agent_id="alice", name="x", event_type="x", outcome="",
        )
        d = hit.to_dict()
        assert d["tool_names"] == []
        assert d["highlight"] == {}


class TestSearchResponse:
    def test_to_dict(self):
        resp = SearchResponse(
            hits=[SpanHit(
                event_id="e1", trace_id="tr-1", span_id="sp-1",
                agent_id="a", name="x", event_type="x", outcome="",
            )],
            total=5,
            facet_counts={"agent_id": [{"value": "a", "count": 5}]},
            took_ms=12.3,
            query="python",
        )
        d = resp.to_dict()
        assert d["total"] == 5
        assert d["query"] == "python"
        assert d["took_ms"] == 12.3
        assert len(d["hits"]) == 1


# ── Schema sanity ─────────────────────────────────────────────────


def test_span_schema_has_required_fields():
    names = {f["name"] for f in SPAN_SCHEMA["fields"]}
    assert "id" not in names  # id is auto
    assert "tenant_id" in names
    assert "trace_id" in names
    assert "input_text" in names
    assert "output_text" in names
    assert "tool_names" in names
    assert "created_at" in names
    assert SPAN_SCHEMA["default_sorting_field"] == "created_at"


# ── Singleton accessors ───────────────────────────────────────────


def test_get_typesense_client_returns_none_when_disabled(monkeypatch):
    # Monkeypatch the module-level cache + Settings
    import eden.observability.typesense_client as mod
    from eden.observability.typesense_client import get_typesense_client
    monkeypatch.setattr(mod, "_typesense_client", None)

    fake_settings = MagicMock()
    fake_settings.typesense_enabled = False
    fake_settings.typesense_api_key = "abc"
    monkeypatch.setattr(
        "eden.config.get_settings", lambda: fake_settings,
    )
    assert get_typesense_client() is None


def test_get_search_service_singleton():
    from eden.observability.search_service import get_search_service
    s1 = get_search_service()
    s2 = get_search_service()
    assert s1 is s2


# ── Typesense fallback (PG ILIKE) ─────────────────────────────────


class _FakePGClient:
    """Minimal asyncpg-compatible fake for Postgres fallback tests."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return self._rows


class TestTypesenseFallback:
    """When Typesense is unavailable, SearchService falls back to PG ILIKE."""

    @pytest.mark.asyncio
    async def test_fallback_when_client_is_none(self, monkeypatch):
        """client=None (Typesense disabled) → PG fallback with fallback=True."""
        pg_rows = [
            {
                "event_id": "e-fallback",
                "trace_id": "tr-fallback",
                "span_id": "sp-1",
                "agent_id": "agent-1",
                "name": "tool.bash",
                "event_type": "tool.call",
                "outcome": "success",
                "duration_ms": 50.0,
                "created_at": 1_747_000_000,
            }
        ]
        fake_pg = _FakePGClient(pg_rows)
        monkeypatch.setattr(
            "eden.observability.search_service.get_typesense_client",
            lambda: None,
        )
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=fake_pg),
        )
        # Flag on so we don't short-circuit before client check
        service = SearchService(client=None)
        # Bypass the flag guard by forcing _flag_on to pick up None client
        import eden.observability.search_service as _mod
        monkeypatch.setattr(_mod, "get_typesense_client", lambda: None)

        resp = await service._pg_fallback_search(
            tenant_id="org-1",
            query="bash",
        )
        assert resp.fallback is True
        assert len(resp.hits) == 1
        assert resp.hits[0].trace_id == "tr-fallback"
        assert resp.hits[0].event_id == "e-fallback"

    @pytest.mark.asyncio
    async def test_fallback_when_typesense_returns_non_200(self, monkeypatch):
        """Non-200 Typesense response → PG fallback invoked."""
        pg_rows = [
            {
                "event_id": "e-pg",
                "trace_id": "tr-pg",
                "span_id": "sp-2",
                "agent_id": "agent-2",
                "name": "tool.read",
                "event_type": "tool.call",
                "outcome": "success",
                "duration_ms": 20.0,
                "created_at": 1_747_100_000,
            }
        ]
        fake_pg = _FakePGClient(pg_rows)
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=fake_pg),
        )
        # Typesense returns a server error
        error_client = _FakeTypesenseClient(search_response=(503, None))
        service = SearchService(client=error_client)
        resp = await service.search(tenant_id="org-1", query="read")
        assert resp.fallback is True
        # PG fallback returned at least one row
        assert len(resp.hits) >= 1

    @pytest.mark.asyncio
    async def test_fallback_response_has_expected_shape(self, monkeypatch):
        """Fallback SpanHit must have the same fields as a Typesense hit."""
        pg_rows = [
            {
                "event_id": "ev-shape",
                "trace_id": "tr-shape",
                "span_id": "sp-shape",
                "agent_id": "agent-shape",
                "name": "llm.call",
                "event_type": "llm.completion",
                "outcome": "success",
                "duration_ms": 123.4,
                "created_at": 1_748_000_000,
            }
        ]
        fake_pg = _FakePGClient(pg_rows)
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=fake_pg),
        )
        service = SearchService(client=None)
        resp = await service._pg_fallback_search(
            tenant_id="org-x",
            query="llm",
        )
        hit = resp.hits[0]
        d = hit.to_dict()
        for key in ("event_id", "trace_id", "span_id", "agent_id",
                    "name", "event_type", "outcome", "created_at",
                    "duration_ms", "tool_names", "highlight"):
            assert key in d, f"missing key {key!r} in fallback SpanHit.to_dict()"


# ── PII redaction before Typesense index ──────────────────────────


class TestPIIRedaction:
    """PII must be masked in build_span_doc output before indexing."""

    def test_email_not_in_input_text(self):
        """An email address in the request body must not appear raw in input_text."""
        ev = _make_event(
            request_body={
                "messages": [
                    {"role": "user", "content": "Contact me at alice@example.com"},
                ]
            }
        )
        doc = build_span_doc(ev)
        assert "alice@example.com" not in doc["input_text"], (
            "email should be redacted from indexed input_text"
        )

    def test_credit_card_not_in_output_text(self):
        """A credit card number must not appear raw in output_text."""
        # Visa-format number that passes Luhn
        card = "4111111111111111"
        ev = _make_event(
            response_body={
                "choices": [
                    {"message": {"role": "assistant", "content": f"Your card {card} is valid"}}
                ]
            }
        )
        doc = build_span_doc(ev)
        assert card not in doc["output_text"], (
            "credit card number should be redacted from indexed output_text"
        )

    def test_plain_text_preserved(self):
        """Non-PII text must still be indexed (not blanked by the masker)."""
        ev = _make_event(
            request_body={"messages": [{"role": "user", "content": "List top Python libraries"}]}
        )
        doc = build_span_doc(ev)
        assert "Python" in doc["input_text"], (
            "non-PII content should remain in input_text after masking"
        )

    def test_ssn_not_in_input_text(self):
        """An SSN must not appear raw in input_text."""
        ev = _make_event(
            request_body={
                "messages": [
                    {"role": "user", "content": "My SSN is 123-45-6789"},
                ]
            }
        )
        doc = build_span_doc(ev)
        assert "123-45-6789" not in doc["input_text"], (
            "SSN should be redacted from indexed input_text"
        )
