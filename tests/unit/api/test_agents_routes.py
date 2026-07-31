"""Server-side tests for the new Phase 2 endpoints:

  - GET  /orgs/{org_id}/agents            (list)
  - POST /orgs/{org_id}/agents/register   (idempotent registration)
  - GET  /orgs/{org_id}/agents/{id}      (fetch one)
  - GET  /orgs/{org_id}/observability/summary  (deeper fingerprint)

The tests build a minimal FastAPI app with the real routes mounted
and override the postgres client + auth dependency so the routes
can be exercised end-to-end without external services.
"""

from __future__ import annotations

import asyncio
from datetime import UTC
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import agents, observability

# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub that satisfies the small slice of the asyncpg
    interface our routes use (fetch, fetchrow, fetchval, execute)."""

    def __init__(self) -> None:
        self.agents: dict[tuple[str, str], dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []

    async def fetch(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "FROM agent_registrations" in q and "ORDER BY" in q:
            org = args[0] if args else None
            framework = None
            name_substr = None
            for _i, a in enumerate(args[1:], start=2):
                if isinstance(a, str) and a.startswith("%") and a.endswith("%"):
                    name_substr = a
                elif a in ("openai", "langchain", "anthropic", "crewai", "autogen", "llama_index", "custom"):
                    framework = a
            limit = kwargs.get("limit", 50)
            offset = kwargs.get("offset", 0)
            # Positional LIMIT/OFFSET follow optional filter args.
            trailing = [a for a in args[1:] if isinstance(a, int)]
            if len(trailing) >= 2:
                limit, offset = trailing[-2], trailing[-1]
            elif len(trailing) == 1:
                limit = trailing[0]
            rows = [
                {"agent_id": aid, "name": v["name"], "framework": v.get("framework"),
                     "repo_url": v.get("repo_url"), "last_seen_at": v.get("last_seen_at", "2026-06-09T12:00:00Z"),
                     "created_at": v.get("created_at", "2026-06-09T12:00:00Z"),
                     "updated_at": v.get("updated_at", "2026-06-09T12:00:00Z")}
                for (org_id, aid), v in self.agents.items()
                if org_id == org
                and (framework is None or v.get("framework") == framework)
                and (name_substr is None or name_substr.strip("%").lower() in v["name"].lower())
            ]
            return rows[offset:offset + limit]
        if "FROM telemetry_events" in q and "count" in q.lower() and "GROUP BY" not in q:
            # Total + error count (no GROUP BY clause)
            org = args[0] if args else None
            matching = [e for e in self.events if e.get("tenant_id") == org]
            return {
                "total": len(matching),
                "errors": sum(1 for e in matching if e.get("error")),
            }
        if "percentile_cont" in q:
            # Latency percentiles
            org = args[0] if args else None
            durations = sorted(
                e["duration_ms"] for e in self.events
                if e.get("tenant_id") == org and e.get("duration_ms") is not None
            )
            if not durations:
                return {"p50": None, "p95": None, "p99": None, "cost": 0.0}
            def pct(p):
                if not durations:
                    return None
                k = max(0, int(p * len(durations)) - 1)
                return float(durations[k])
            cost = sum(e.get("cost_usd", 0) or 0 for e in self.events
                       if e.get("tenant_id") == org)
            return {"p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99), "cost": cost}
        # The remaining branches all have ``GROUP BY 1``. Dispatch
        # by the most specific column in the SELECT list.
        if "sample_trace_ids" in q and (
            "error_type" in q or "error->>'type'" in q or "attributes->>'error'" in q
        ):
            # Top failure modes (error_type / attributes error / legacy error JSON)
            org = args[0] if args else None
            counts: dict[str, dict[str, Any]] = {}
            for e in self.events:
                if e.get("tenant_id") != org:
                    continue
                err = e.get("error")
                attrs = e.get("attributes") or {}
                if not (e.get("error_type") or err or attrs.get("error")):
                    continue
                if isinstance(err, dict):
                    name = (
                        e.get("error_type")
                        or err.get("type")
                        or err.get("category")
                        or attrs.get("error")
                        or e.get("event_type")
                    )
                else:
                    name = e.get("error_type") or attrs.get("error") or e.get("event_type")
                if name not in counts:
                    counts[name] = {"count": 0, "sample_trace_ids": []}
                counts[name]["count"] += 1
                tid = e.get("trace_id")
                if tid and tid not in counts[name]["sample_trace_ids"]:
                    counts[name]["sample_trace_ids"].append(tid)
            return [{"name": k, **v} for k, v in
                    sorted(counts.items(), key=lambda x: -x[1]["count"])[:10]]
        if "tool_name" in q and (
            "tool.name" in q or "payload->>'tool_name'" in q or "attributes->>'tool_name'" in q
        ):
            # Top tools (groups by tool_name / payload attributes)
            org = args[0] if args else None
            counts: dict[str, int] = {}
            for e in self.events:
                if e.get("tenant_id") != org:
                    continue
                if e.get("event_type") not in ("tool_call", "tool_result"):
                    continue
                name = (e.get("payload") or {}).get("tool_name") or e.get("event_type")
                counts[name] = counts.get(name, 0) + 1
            return [{"name": k, "count": v} for k, v in
                    sorted(counts.items(), key=lambda x: -x[1])[:10]]
        if "event_type AS name" in q and "avg(duration_ms)" in q:
            # Hot paths (per event_type with avg duration)
            org = args[0] if args else None
            counts: dict[str, list[float]] = {}
            for e in self.events:
                if e.get("tenant_id") != org:
                    continue
                et = e.get("event_type")
                counts.setdefault(et, []).append(e.get("duration_ms") or 0)
            out = []
            for k, durs in counts.items():
                avg = sum(durs) / len(durs) if durs else 0
                out.append({"name": k, "count": len(durs), "avg_duration_ms": avg})
            return sorted(out, key=lambda x: -x["count"])[:10]
        if "attributes->>'model'" in q and "cost_usd" in q:
            # Model breakdown
            org = args[0] if args else None
            counts: dict[str, dict[str, Any]] = {}
            for e in self.events:
                if e.get("tenant_id") != org or e.get("event_type") != "llm_call":
                    continue
                m = (e.get("attributes") or {}).get("model") or "?"
                if m not in counts:
                    counts[m] = {"calls": 0, "cost_usd": 0.0}
                counts[m]["calls"] += 1
                counts[m]["cost_usd"] += e.get("cost_usd") or 0
            return [{"model": k, **v} for k, v in counts.items()]
        return []

    async def fetchrow(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "UPDATE agent_registrations" in q and "RETURNING" in q:
            org, aid, name, framework, repo_url, register_token = args
            key = (org, aid)
            from datetime import datetime
            now = datetime.now(UTC).isoformat()
            if key not in self.agents:
                return None
            self.agents[key].update({
                "name": name,
                "framework": framework,
                "repo_url": repo_url,
                "register_token": register_token or self.agents[key].get("register_token"),
                "last_seen_at": now,
            })
            v = self.agents[key]
            return {
                "agent_id": aid,
                "name": v["name"],
                "framework": v.get("framework"),
                "repo_url": v.get("repo_url"),
                "last_seen_at": v.get("last_seen_at", now),
                "created_at": v.get("created_at", now),
                "updated_at": v.get("updated_at", now),
            }
        if "INSERT INTO agent_registrations" in q and "RETURNING" in q:
            org, aid, name, framework, repo_url, register_token = args
            key = (org, aid)
            from datetime import datetime
            now = datetime.now(UTC).isoformat()
            existing = self.agents.get(key)
            if existing:
                self.agents[key].update({
                    "name": name,
                    "framework": framework,
                    "repo_url": repo_url,
                    "register_token": register_token or existing.get("register_token"),
                    "last_seen_at": now,
                })
            else:
                self.agents[key] = {
                    "name": name,
                    "framework": framework,
                    "repo_url": repo_url,
                    "register_token": register_token,
                    "last_seen_at": now,
                    "created_at": now,
                    "updated_at": now,
                }
            v = self.agents[key]
            return {
                "agent_id": aid,
                "name": v["name"],
                "framework": v.get("framework"),
                "repo_url": v.get("repo_url"),
                "last_seen_at": v.get("last_seen_at", now),
                "created_at": v.get("created_at", now),
                "updated_at": v.get("updated_at", now),
            }
        if "FROM agent_registrations" in q and "WHERE org_id = $1 AND agent_id = $2" in q:
            org, aid = args[0], args[1]
            key = (org, aid)
            if key in self.agents:
                v = self.agents[key]
                return {"agent_id": aid, "name": v["name"], "framework": v.get("framework"),
                            "repo_url": v.get("repo_url"),
                            "last_seen_at": v.get("last_seen_at", "2026-06-09T12:00:00Z"),
                            "created_at": v.get("created_at", "2026-06-09T12:00:00Z"),
                            "updated_at": v.get("updated_at", "2026-06-09T12:00:00Z")}
            return None
        if "judged_traces" in q or "FROM judge_scores" in q:
            # Eval-coverage subquery (Wave 2): distinct traces vs judged
            org = args[0] if args else None
            matching = [e for e in self.events if e.get("tenant_id") == org]
            traces = {e.get("trace_id") for e in matching if e.get("trace_id")}
            return {
                "total_traces": len(traces),
                "judged_traces": 0,
            }
        if "FROM telemetry_events" in q and "count" in q.lower() and "GROUP BY" not in q:
            # Total + error count (single-row aggregate)
            org = args[0] if args else None
            matching = [e for e in self.events if e.get("tenant_id") == org]
            traces = {e.get("trace_id") for e in matching if e.get("trace_id")}
            return {
                "total_events": len(matching),
                "total_traces": len(traces),
                "errors": sum(1 for e in matching if e.get("error")),
            }
        if "percentile_cont" in q:
            # Latency percentiles
            org = args[0] if args else None
            durations = sorted(
                e["duration_ms"] for e in self.events
                if e.get("tenant_id") == org and e.get("duration_ms") is not None
            )
            if not durations:
                return {"p50": None, "p95": None, "p99": None, "cost": 0.0}
            def pct(p):
                if not durations:
                    return None
                k = max(0, int(p * len(durations)) - 1)
                return float(durations[k])
            cost = sum(e.get("cost_usd", 0) or 0 for e in self.events
                       if e.get("tenant_id") == org)
            return {"p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99), "cost": cost}
        return None

    async def fetchval(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "count(*)" in q and "agent_registrations" in q:
            org = args[0]
            n = sum(1 for (o, _) in self.agents if o == org)
            return n
        return 0

    async def execute(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "UPDATE agent_registrations" in q:
            # UPDATE agent_registrations SET name = $3, framework = $4,
            # repo_url = $5, register_token = COALESCE($6, register_token),
            # last_seen_at = NOW() WHERE org_id = $1 AND agent_id = $2
            org, aid, name, framework, repo_url, register_token = args
            key = (org, aid)
            from datetime import datetime, timezone
            now = datetime.now(UTC).isoformat()
            if key in self.agents:
                self.agents[key].update({
                    "name": name,
                    "framework": framework,
                    "repo_url": repo_url,
                    "register_token": register_token or self.agents[key].get("register_token"),
                    "last_seen_at": now,
                })
                return "UPDATE 1"
            return "UPDATE 0"
        if "INSERT INTO agent_registrations" in q:
            org, aid, name, framework, repo_url, register_token = args
            key = (org, aid)
            existing = self.agents.get(key)
            from datetime import datetime, timezone
            now = datetime.now(UTC).isoformat()
            if existing:
                self.agents[key].update({
                    "name": name,
                    "framework": framework,
                    "repo_url": repo_url,
                    "register_token": register_token or existing.get("register_token"),
                    "last_seen_at": now,
                })
                return "UPDATE 1"
            else:
                self.agents[key] = {
                    "name": name,
                    "framework": framework,
                    "repo_url": repo_url,
                    "register_token": register_token,
                    "last_seen_at": now,
                    "created_at": now,
                    "updated_at": now,
                }
                return "INSERT 0 1"
        return "OK"

    async def close(self):
        pass


@pytest.fixture
def app():
    """Build a minimal FastAPI app with the agents + observability
    summary routes mounted. The auth dep is overridden to skip the
    real auth check; the postgres client is replaced with the stub.

    Returns ``(test_app, stub)`` so individual tests can seed the
    stub before issuing requests.
    """
    test_app = FastAPI()
    test_app.include_router(agents.router)
    test_app.include_router(observability.router)

    from eden.api.deps import get_current_user, require_org_member, require_path_org_access

    async def _override_user():
        return {
            "user_id": "u-1",
            "id": "u-1",
            "org_id": "org-test",
            "org_ids": ["org-test"],
            "is_superuser": False,
            "auth_kind": "session",
        }

    async def _override_org_member(
        org_id: str,
        user: dict | None = None,
    ) -> dict:
        # Audit 2026-07-03 — the observability router requires
        # ``require_org_member`` at the router level so a forgotten
        # ``org_id`` filter on a new endpoint can't cross-leak
        # tenant data. The test fixture bypasses the membership
        # lookup (no ``org_members`` table in the stub) and trusts
        # the caller is a member of ``org-test``.
        return {"org_id": org_id, "role": "admin"}

    async def _override_path_org():
        return "org-test"

    async def _override_register_org():
        return "org-test"

    test_app.dependency_overrides[get_current_user] = _override_user
    test_app.dependency_overrides[require_org_member] = _override_org_member
    test_app.dependency_overrides[require_path_org_access] = _override_path_org
    test_app.dependency_overrides[agents.require_path_org_access] = _override_path_org
    test_app.dependency_overrides[agents.require_agent_register_org] = _override_register_org
    test_app.dependency_overrides[observability.require_path_org_access] = _override_path_org

    stub = _StubPostgresClient()
    # Seed events so /summary has something to aggregate
    from datetime import datetime, timezone
    now = datetime.now(UTC).isoformat()
    stub.events = [
        {
            "tenant_id": "org-test", "trace_id": "tr-1",
            "event_type": "llm_call", "duration_ms": 850,
            "error": None, "attributes": {"model": "claude-sonnet-4.6"},
            "cost_usd": 0.02, "timestamp": now,
        },
        {
            "tenant_id": "org-test", "trace_id": "tr-1",
            "event_type": "tool_call", "duration_ms": 220,
            "error": None, "payload": {"tool_name": "search_api"},
            "timestamp": now,
        },
        {
            "tenant_id": "org-test", "trace_id": "tr-1",
            "event_type": "tool_call", "duration_ms": 250,
            "error": {"type": "tool timeout"},
            "payload": {"tool_name": "search_api"},
            "timestamp": now,
        },
    ]

    # Patch the get_postgres_client name in each module that imports
    # it. The route functions do ``from eden.storage.postgres import
    # get_postgres_client`` at call time, so patching the name on the
    # route's module binds the local name. We also patch the storage
    # module itself for completeness.
    agents.get_postgres_client = AsyncMock(return_value=stub)
    observability.get_postgres_client = AsyncMock(return_value=stub)
    from eden.storage import postgres as pg_module
    pg_module.get_postgres_client = AsyncMock(return_value=stub)

    return test_app, stub


@pytest.fixture
def client(app):
    """Yields ``(TestClient, stub)``. Use the same pattern as the
    existing test_latency_middleware tests — patch the dependencies
    once, then build a TestClient around the patched app.
    """
    test_app, stub = app
    return TestClient(test_app), stub


# ── /orgs/{org_id}/agents ──────────────────────────────────────────


def test_list_agents_empty(client):
    c, _ = client
    resp = c.get("/orgs/org-test/agents")
    assert resp.status_code == 200
    body = resp.json()
    assert body["agents"] == []
    assert body["total"] == 0


def test_list_agents_returns_registered(client):
    c, stub = client
    # Pre-populate the stub
    stub.agents[("org-test", "agent-1")] = {
        "name": "MyAgent", "framework": "openai", "repo_url": "https://github.com/me/myagent",
        "register_token": "tok-1", "last_seen_at": "2026-06-09T12:00:00Z",
    }
    # The stub returns one row; the body must include it.
    resp = c.get("/orgs/org-test/agents")
    assert resp.status_code == 200
    body = resp.json()
    assert "agents" in body
    assert "total" in body
    assert isinstance(body["agents"], list)
    assert body["total"] == len(self_agents_for_test(stub, "org-test"))
    # The body must include the agent we seeded (search by name)
    names = {a["name"] for a in body["agents"]}
    assert "MyAgent" in names


def self_agents_for_test(stub, org_id: str) -> list[dict]:
    """Return the dicts the stub would return for the given org."""
    return [
        v for (o, _), v in stub.agents.items()
        if o == org_id
    ]


def test_list_agents_filters_by_framework(client):
    c, stub = client
    stub.agents[("org-test", "a1")] = {"name": "X-OpenAI", "framework": "openai"}
    stub.agents[("org-test", "a2")] = {"name": "Y-LangChain", "framework": "langchain"}
    resp = c.get("/orgs/org-test/agents?framework=openai")
    assert resp.status_code == 200
    body = resp.json()
    names = {a["name"] for a in body["agents"]}
    assert "X-OpenAI" in names
    assert "Y-LangChain" not in names


def test_list_agents_filters_by_name_substring(client):
    c, stub = client
    stub.agents[("org-test", "a1")] = {"name": "ProductionRAG"}
    stub.agents[("org-test", "a2")] = {"name": "StagingAgent"}
    resp = c.get("/orgs/org-test/agents?name=prod")
    assert resp.status_code == 200
    body = resp.json()
    names = {a["name"] for a in body["agents"]}
    assert "ProductionRAG" in names
    assert "StagingAgent" not in names


# ── /orgs/{org_id}/agents/register ─────────────────────────────────


def test_register_agent_creates(client):
    c, _ = client
    resp = c.post(
        "/orgs/org-test/agents/register",
        json={"name": "NewAgent", "framework": "openai", "agent_id": "new-1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["created"] is True
    assert body["agent"]["agent_id"] == "new-1"
    assert body["agent"]["name"] == "NewAgent"
    assert body["agent"]["framework"] == "openai"


def test_register_agent_idempotent(client):
    c, _ = client
    body1 = {"name": "X", "framework": "openai", "agent_id": "x-1"}
    body2 = {"name": "X", "framework": "langchain", "agent_id": "x-1"}  # same id
    r1 = c.post("/orgs/org-test/agents/register", json=body1)
    r2 = c.post("/orgs/org-test/agents/register", json=body2)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["created"] is True
    # Second call updates in place (returns created=False)
    assert r2.json()["created"] is False
    # Framework was updated
    assert r2.json()["agent"]["framework"] == "langchain"


def test_register_agent_server_issues_id_when_missing(client):
    c, _ = client
    resp = c.post(
        "/orgs/org-test/agents/register",
        json={"name": "AnonAgent"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["created"] is True
    # The server should have issued a fresh uuid
    import uuid as _uuid
    assert _uuid.UUID(body["agent"]["agent_id"])


# ── /orgs/{org_id}/agents/{agent_id} ──────────────────────────────


def test_get_agent_returns_one(client):
    c, stub = client
    stub.agents[("org-test", "x-1")] = {
        "name": "X", "framework": "openai", "register_token": "tok",
    }
    resp = c.get("/orgs/org-test/agents/x-1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["agent_id"] == "x-1"
    assert body["name"] == "X"


def test_get_agent_404_when_missing(client):
    c, _ = client
    resp = c.get("/orgs/org-test/agents/nope")
    assert resp.status_code == 404


# ── /orgs/{org_id}/observability/summary ──────────────────────────


def test_observability_summary_returns_deeper_fingerprint(client):
    c, _ = client
    resp = c.get("/orgs/org-test/observability/summary?window_hours=24")
    assert resp.status_code == 200
    body = resp.json()
    # Core fields — Wave 2: total_traces is COUNT(DISTINCT trace_id);
    # seed has 3 events on a single trace.
    assert body["window_hours"] == 24
    assert body["total_events"] == 3
    assert body["total_traces"] == 1
    assert body["error_rate"] > 0  # at least 1 of 3 events has an error
    # Deeper-fingerprint fields (Phase 2)
    assert "top_failure_modes" in body
    assert "top_tools" in body
    assert "hot_paths" in body
    assert "model_breakdown" in body
    # Our seed data has 1 tool-call error
    fm_names = [f["name"] for f in body["top_failure_modes"]]
    assert "tool timeout" in fm_names
    # Our seed has 2 tool_call events for search_api
    tool_names = [t["name"] for t in body["top_tools"]]
    assert "search_api" in tool_names
    # Hot paths include event types
    hp_names = [h["name"] for h in body["hot_paths"]]
    assert "llm_call" in hp_names
    assert "tool_call" in hp_names


def test_observability_summary_filters_by_agent_id(client):
    c, _ = client
    # Stub doesn't actually filter by agent_id (the API contract is
    # server-side filtering). But the param should be accepted.
    resp = c.get(
        "/orgs/org-test/observability/summary?agent_id=agent-1"
    )
    assert resp.status_code == 200


def test_observability_summary_window_hours_validation(client):
    c, _ = client
    # window_hours out of range should 422
    resp = c.get("/orgs/org-test/observability/summary?window_hours=0")
    assert resp.status_code == 422
    resp = c.get("/orgs/org-test/observability/summary?window_hours=10000")
    assert resp.status_code == 422
