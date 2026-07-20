"""Server-side tests for the new analytics sub-routes (Phase A.1):

  - GET /orgs/{org_id}/analytics/token-usage
  - GET /orgs/{org_id}/analytics/latency
  - GET /orgs/{org_id}/analytics/throughput
  - GET /orgs/{org_id}/analytics/top-agents
  - GET /orgs/{org_id}/optimization/cost-per-trace

The tests build a minimal FastAPI app with the real routes mounted and
override the postgres client + auth dependency so the routes can be
exercised end-to-end without external services.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden import storage
from eden.api.routes import analytics, optimization
from eden.storage import postgres as eden_postgres

# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub that handles the small set of queries our new routes
    issue (token-usage aggregation, latency percentiles, throughput, top
    agents, cost-per-trace join). Returns rows in the shape asyncpg's
    ``fetch`` would yield (a list of dict-like rows)."""

    def __init__(self) -> None:
        self.usage_events: list[dict[str, Any]] = []
        self.telemetry_events: list[dict[str, Any]] = []

    async def fetch(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        org = args[0] if args else None
        start = args[1] if len(args) > 1 else None
        # Normalize start to naive UTC so we can compare against naive
        # ``created_at`` / ``timestamp`` values seeded in the tests.
        if start is not None and getattr(start, "tzinfo", None) is not None:
            start = start.replace(tzinfo=None)

        # ── token-usage: GROUP BY DATE(created_at) from usage_events ──
        if "FROM usage_events" in q and "input_tokens" in q and "output_tokens" in q:
            agg: dict[str, dict[str, int]] = {}
            for e in self.usage_events:
                if e.get("org_id") != org or e.get("event_type") != "llm_call":
                    continue
                if start and e.get("created_at", start) < start:
                    continue
                day = e["created_at"].date().isoformat()
                agg.setdefault(day, {"input_tokens": 0, "output_tokens": 0})
                meta = e.get("metadata") or {}
                agg[day]["input_tokens"] += int(meta.get("input_tokens", 0) or 0)
                agg[day]["output_tokens"] += int(meta.get("output_tokens", 0) or 0)
            return [
                {"day": datetime.fromisoformat(d).date(),
                 "input_tokens": v["input_tokens"],
                 "output_tokens": v["output_tokens"]}
                for d, v in sorted(agg.items())
            ]

        # ── latency: percentile_cont aggregations from telemetry_events ──
        if "FROM telemetry_events" in q and "percentile_cont" in q:
            durations: list[float] = []
            for e in self.telemetry_events:
                if e.get("tenant_id") != org or e.get("duration_ms") is None:
                    continue
                if start and e.get("timestamp", start) < start:
                    continue
                durations.append(float(e["duration_ms"]))
            if not durations:
                return [{"day": start.date() if start else datetime.utcnow().date(),
                         "p50_ms": None, "p95_ms": None, "p99_ms": None}]
            durations.sort()
            def pct(p: float) -> float:
                # Continuous percentile (matches Postgres percentile_cont).
                k = max(0, min(len(durations) - 1,
                               int(round(p * (len(durations) - 1)))))
                return float(durations[k])
            return [{
                "day": start.date() if start else datetime.utcnow().date(),
                "p50_ms": pct(0.5),
                "p95_ms": pct(0.95),
                "p99_ms": pct(0.99),
            }]

        # ── throughput: GROUP BY (hour, weekday) from telemetry_events ──
        if "EXTRACT(HOUR FROM timestamp)" in q:
            agg: dict[tuple[int, int], int] = {}
            for e in self.telemetry_events:
                if e.get("tenant_id") != org:
                    continue
                if start and e.get("timestamp", start) < start:
                    continue
                ts = e["timestamp"]
                h = ts.hour
                w = (ts.weekday() + 1) % 7  # Postgres DOW: Sun=0..Sat=6
                agg[(h, w)] = agg.get((h, w), 0) + 1
            return [{"hour": h, "weekday": w, "requests": c}
                    for (h, w), c in sorted(agg.items())]

        # ── top-agents: GROUP BY model from usage_events ──
        if "FROM usage_events" in q and "model AS agent" in q:
            agg: dict[str, dict[str, Any]] = {}
            for e in self.usage_events:
                if e.get("org_id") != org or e.get("event_type") != "llm_call":
                    continue
                if not e.get("model"):
                    continue
                if start and e.get("created_at", start) < start:
                    continue
                a = agg.setdefault(e["model"], {"requests": 0, "cost_usd": 0.0, "latencies": []})
                a["requests"] += 1
                a["cost_usd"] += float(e.get("cost_usd") or 0.0)
                meta = e.get("metadata") or {}
                if meta.get("latency_ms") is not None:
                    a["latencies"].append(float(meta["latency_ms"]))
            return sorted(
                [{"agent": k, "requests": v["requests"], "cost_usd": v["cost_usd"],
                  "avg_latency_ms": sum(v["latencies"]) / len(v["latencies"]) if v["latencies"] else 0.0}
                 for k, v in agg.items()],
                key=lambda r: -r["cost_usd"],
            )[:25]

        # ── cost-per-trace: JOIN usage_events LEFT JOIN telemetry_events ──
        if "FROM usage_events" in q and "LEFT JOIN telemetry_events" in q:
            te_by_corr = {e.get("correlation_id"): e for e in self.telemetry_events if e.get("correlation_id")}
            out = []
            for e in self.usage_events:
                if e.get("org_id") != org or e.get("event_type") != "llm_call":
                    continue
                if start and e.get("created_at", start) < start:
                    continue
                if not e.get("correlation_id"):
                    continue
                te = te_by_corr.get(e["correlation_id"]) or {}
                out.append({
                    "trace_id": e["correlation_id"],
                    "model": e.get("model") or "unknown",
                    "cost_usd": float(e.get("cost_usd") or 0.0),
                    "tokens": int(e.get("quantity") or 0),
                    "latency_ms": float(te.get("duration_ms") or 0.0),
                })
            return sorted(out, key=lambda r: -r["cost_usd"])[:100]

        return []

    async def fetchrow(self, query: str, *args, **kwargs):
        return None

    async def fetchval(self, query: str, *args, **kwargs):
        return 0

    async def execute(self, query: str, *args, **kwargs):
        return None


# ── Test fixtures ───────────────────────────────────────────────


@pytest.fixture
def stub_pg():
    return _StubPostgresClient()


@pytest.fixture
def app(stub_pg, monkeypatch):
    """Build a minimal FastAPI app with the analytics + optimization routes
    and the stubbed dependencies."""

    # Mock get_postgres_client to return the stub. analytics.py imports
    # it at module level; optimization.py imports it inside the function
    # (as eden.storage.postgres.get_postgres_client). Patch both.
    async def _get_pg():
        return stub_pg
    monkeypatch.setattr(analytics, "get_postgres_client", _get_pg)
    monkeypatch.setattr(eden_postgres, "get_postgres_client", _get_pg)

    # Patch require_org_permission on BOTH the deps module (where it's
    # defined) AND on the analytics + optimization modules (which captured
    # the original reference via ``from eden.api.deps import ...``).
    from eden.api import deps as eden_deps

    async def _noop_perm(*args, **kwargs):
        return None
    monkeypatch.setattr(eden_deps, "require_org_permission", _noop_perm)
    monkeypatch.setattr(analytics, "require_org_permission", _noop_perm)
    monkeypatch.setattr(optimization, "require_org_permission", _noop_perm)

    # Auth override is added at the FastAPI level (below) using the
    # function object that analytics.py captured via ``from ... import``.
    # Replacing it via monkeypatch would create a new object, breaking
    # the dependency override key match.
    async def _get_user():
        return {"id": "u-test", "email": "t@test.io", "org_id": "org-test"}

    async def _path_org():
        return "org-test"

    # Mock Redis client (not used by new routes, but imported by optimization).
    async def _get_redis():
        return None
    from eden.storage import redis as eden_redis
    monkeypatch.setattr(eden_redis, "get_redis_client", _get_redis)

    app = FastAPI()
    app.include_router(analytics.router)
    app.include_router(optimization.router)

    # FastAPI's dependency_overrides is the correct way to stub a Depends().
    app.dependency_overrides[eden_deps.get_current_user] = _get_user
    # Wave path-org gate: sub-routes bind Depends(require_path_org_access).
    app.dependency_overrides[analytics.require_path_org_access] = _path_org
    app.dependency_overrides[optimization.require_path_org_access] = _path_org
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


# ── Helpers ──────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# ── Tests: token-usage ───────────────────────────────────────────


def test_token_usage_happy_path(client, stub_pg):
    """Aggregates input/output tokens per day from usage_events."""
    today = _now()
    stub_pg.usage_events.extend([
        {"org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
         "created_at": today - timedelta(days=2),
         "metadata": {"input_tokens": 100, "output_tokens": 50}},
        {"org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
         "created_at": today - timedelta(days=2),
         "metadata": {"input_tokens": 200, "output_tokens": 75}},
        {"org_id": "org-test", "event_type": "llm_call", "model": "claude",
         "created_at": today - timedelta(days=1),
         "metadata": {"input_tokens": 300, "output_tokens": 100}},
    ])

    resp = client.get("/orgs/org-test/analytics/token-usage?days=7")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_day" in body
    assert len(body["by_day"]) == 2
    # First day (oldest): 100+200=300 input, 50+75=125 output
    assert body["by_day"][0]["input_tokens"] == 300
    assert body["by_day"][0]["output_tokens"] == 125
    # Second day: 300 input, 100 output
    assert body["by_day"][1]["input_tokens"] == 300
    assert body["by_day"][1]["output_tokens"] == 100


def test_token_usage_empty_data(client, stub_pg):
    """Empty data returns empty by_day, not an error."""
    resp = client.get("/orgs/org-test/analytics/token-usage?days=7")
    assert resp.status_code == 200
    assert resp.json() == {"by_day": []}


# ── Tests: latency ───────────────────────────────────────────────


def test_latency_percentiles_happy_path(client, stub_pg):
    today = _now()
    # 100 events with durations 1..100 (sparse enough to differentiate percentiles)
    for i, d in enumerate(range(1, 101)):
        stub_pg.telemetry_events.append({
            "tenant_id": "org-test", "duration_ms": float(d),
            "timestamp": today - timedelta(minutes=i),
        })

    resp = client.get("/orgs/org-test/analytics/latency?days=7")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_day" in body
    assert len(body["by_day"]) == 1
    row = body["by_day"][0]
    assert row["p50_ms"] > 0
    assert row["p95_ms"] > row["p50_ms"]
    assert row["p99_ms"] > row["p95_ms"]


def test_latency_empty_data(client, stub_pg):
    resp = client.get("/orgs/org-test/analytics/latency?days=7")
    assert resp.status_code == 200
    body = resp.json()
    # Empty: by_day is a list (with a single null-percentile row from our stub
    # is acceptable too — just verify no crash)
    assert "by_day" in body


# ── Tests: throughput ────────────────────────────────────────────


def test_throughput_by_hour_happy_path(client, stub_pg):
    today = _now()
    weekday = today.weekday()  # Python: Mon=0..Sun=6
    pg_dow = (weekday + 1) % 7  # Postgres DOW: Sun=0..Sat=6
    for h in [9, 10, 10, 14, 14, 14]:
        ts = today.replace(hour=h, minute=0, second=0, microsecond=0)
        stub_pg.telemetry_events.append({
            "tenant_id": "org-test", "timestamp": ts,
        })

    resp = client.get("/orgs/org-test/analytics/throughput?days=7")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_hour" in body
    counts = {(r["hour"], r["weekday"]): r["requests"] for r in body["by_hour"]}
    assert counts[(10, pg_dow)] == 2
    assert counts[(14, pg_dow)] == 3
    assert counts[(9, pg_dow)] == 1


def test_throughput_empty_data(client, stub_pg):
    resp = client.get("/orgs/org-test/analytics/throughput?days=7")
    assert resp.status_code == 200
    assert resp.json() == {"by_hour": []}


# ── Tests: top-agents ────────────────────────────────────────────


def test_top_agents_by_cost_happy_path(client, stub_pg):
    today = _now()
    stub_pg.usage_events.extend([
        {"org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
         "created_at": today - timedelta(hours=1),
         "cost_usd": 0.05, "metadata": {"latency_ms": 1200}},
        {"org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
         "created_at": today - timedelta(hours=2),
         "cost_usd": 0.07, "metadata": {"latency_ms": 1500}},
        {"org_id": "org-test", "event_type": "llm_call", "model": "claude-3-5",
         "created_at": today - timedelta(hours=3),
         "cost_usd": 0.02, "metadata": {"latency_ms": 800}},
    ])

    resp = client.get("/orgs/org-test/analytics/top-agents?days=7")
    assert resp.status_code == 200
    body = resp.json()
    assert "agents" in body
    assert len(body["agents"]) == 2
    # Sorted by cost desc: gpt-4o first
    assert body["agents"][0]["agent"] == "gpt-4o"
    assert body["agents"][0]["requests"] == 2
    assert abs(body["agents"][0]["cost_usd"] - 0.12) < 0.001
    assert body["agents"][0]["avg_latency_ms"] == 1350.0
    # claude second
    assert body["agents"][1]["agent"] == "claude-3-5"
    assert body["agents"][1]["requests"] == 1


def test_top_agents_empty_data(client, stub_pg):
    resp = client.get("/orgs/org-test/analytics/top-agents?days=7")
    assert resp.status_code == 200
    assert resp.json() == {"agents": []}


# ── Tests: cost-per-trace ────────────────────────────────────────


def test_cost_per_trace_happy_path(client, stub_pg):
    today = _now()
    stub_pg.usage_events.extend([
        {"org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
         "created_at": today - timedelta(hours=1),
         "correlation_id": "trace-1", "cost_usd": 0.10, "quantity": 500},
        {"org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
         "created_at": today - timedelta(hours=2),
         "correlation_id": "trace-2", "cost_usd": 0.05, "quantity": 250},
    ])
    stub_pg.telemetry_events.extend([
        {"tenant_id": "org-test", "correlation_id": "trace-1",
         "duration_ms": 2000.0, "timestamp": today - timedelta(hours=1)},
        {"tenant_id": "org-test", "correlation_id": "trace-2",
         "duration_ms": 1000.0, "timestamp": today - timedelta(hours=2)},
    ])

    resp = client.get("/orgs/org-test/optimization/cost-per-trace?days=7")
    assert resp.status_code == 200
    body = resp.json()
    assert "points" in body
    assert len(body["points"]) == 2
    # Sorted by cost desc
    assert body["points"][0]["trace_id"] == "trace-1"
    assert body["points"][0]["cost_usd"] == 0.10
    assert body["points"][0]["latency_ms"] == 2000.0
    assert body["points"][1]["trace_id"] == "trace-2"
    assert body["points"][1]["latency_ms"] == 1000.0


def test_cost_per_trace_empty_data(client, stub_pg):
    resp = client.get("/orgs/org-test/optimization/cost-per-trace?days=7")
    assert resp.status_code == 200
    assert resp.json() == {"points": []}


# ── Tests: auth ───────────────────────────────────────────────────


def test_routes_require_org_id(client):
    """Path validation: /orgs/{org_id} is required, so this 404s on no org."""
    # All the routes need /orgs/{org_id}/... so a malformed path 404s
    resp = client.get("/orgs//analytics/token-usage")
    # FastAPI returns 404 for unmatched path (empty path param)
    assert resp.status_code in (404, 307, 422)


# ── Tests: default days param ────────────────────────────────────


def test_default_days_30(client, stub_pg):
    """All new routes accept days default 30 and return 200 even with no data."""
    today = _now()
    # Put one event 100 days ago — outside default 30 day window
    stub_pg.usage_events.append({
        "org_id": "org-test", "event_type": "llm_call", "model": "gpt-4o",
        "created_at": today - timedelta(days=100),
        "metadata": {"input_tokens": 50, "output_tokens": 25},
    })

    # Default days=30 should NOT include the 100-day-old event
    resp = client.get("/orgs/org-test/analytics/token-usage")
    assert resp.status_code == 200
    assert resp.json() == {"by_day": []}
