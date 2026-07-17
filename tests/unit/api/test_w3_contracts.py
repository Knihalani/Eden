"""Wave 3 — contract expansions: wave6 + ai-insights session shape + OpenAPI denylist."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

ROOT = Path(__file__).resolve().parents[3]
PORTAL_API = ROOT / "clients" / "portal" / "src" / "lib" / "api.ts"


def test_wave6_api_paths_subset_of_backend() -> None:
    """Every wave6Api path template must exist on wave6_online.router."""
    from eden.api.routes import wave6_online

    src = PORTAL_API.read_text(encoding="utf-8")
    block = src.split("const wave6Api")[1].split("(api as unknown")[0]
    # Collect `/orgs/${orgId}/...` path literals from the client block.
    client_paths = set(
        re.findall(r"`/orgs/\$\{orgId\}(/[^`$]+)`", block),
    )
    # Normalize encodeURIComponent(...) segments → {name}
    normalized: set[str] = set()
    for p in client_paths:
        p2 = re.sub(r"\$\{encodeURIComponent\((\w+)\)\}", r"{\1}", p)
        p2 = re.sub(r"\$\{(\w+)\}", r"{\1}", p2)
        # Drop query strings
        p2 = p2.split("?")[0]
        # Map camelCase path vars to snake where backend uses {rule_id} etc.
        p2 = p2.replace("{traceId}", "{trace_id}")
        p2 = p2.replace("{spanId}", "{span_id}")
        p2 = p2.replace("{ruleId}", "{rule_id}")
        p2 = p2.replace("{name}", "{name}")
        normalized.add(f"/orgs/{{org_id}}{p2}")

    backend = {
        r.path for r in wave6_online.router.routes if isinstance(r, APIRoute)
    }
    missing = sorted(p for p in normalized if p not in backend)
    assert not missing, f"wave6Api paths missing on backend: {missing}"
    # Required expansions for Wave 3
    for required in (
        "patchScoringRule",
        "rewindScoringRule",
        "listSpanScores",
        "listAutomations",
        "exportSqlToQueue",
        "promoteToShadowGuardrail",
    ):
        assert required in block, f"wave6Api missing {required}"


def test_ai_insights_session_shape_locked() -> None:
    """Portal ai-insights session list shape matches backend keys."""
    src = PORTAL_API.read_text(encoding="utf-8")
    assert "listAiInsightsSessions" in src or "ai-insights/sessions" in src
    # Backend contract keys
    from eden.api.routes import ai_insights

    # Ensure list endpoint exists
    paths = {r.path for r in ai_insights.router.routes if isinstance(r, APIRoute)}
    assert any("ai-insights/sessions" in p for p in paths)
    # Client expects these fields on session rows
    for key in ("session_id", "title", "created_at", "updated_at"):
        assert key in src, f"api.ts missing ai-insights session key {key}"


def test_openapi_public_strips_internal() -> None:
    from eden.api.openapi_public import (
        _INTERNAL_EXACT_PATHS,
        _INTERNAL_PATH_PREFIXES,
        _INTERNAL_TAGS,
        build_public_openapi_spec,
    )

    full = {
        "openapi": "3.1.0",
        "info": {"title": "Eden", "version": "0"},
        "paths": {
            "/health": {"get": {"tags": ["internal-health"], "responses": {}}},
            "/metrics": {"get": {"tags": ["internal-health"], "responses": {}}},
            "/clerk/webhook": {"post": {"tags": ["clerk-webhooks"], "responses": {}}},
            "/orgs/{org_id}/traces": {
                "get": {"tags": ["traces"], "responses": {"200": {"description": "ok"}}},
            },
            "/v1/internal/debug": {
                "get": {"tags": ["internal-health"], "responses": {}},
            },
        },
        "tags": [
            {"name": "traces"},
            {"name": "internal-health"},
            {"name": "clerk-webhooks"},
            {"name": "scim"},
        ],
    }
    public = build_public_openapi_spec(full)
    paths = public.get("paths") or {}
    assert "/orgs/{org_id}/traces" in paths
    assert "/health" not in paths
    assert "/metrics" not in paths
    assert "/clerk/webhook" not in paths
    assert "/v1/internal/debug" not in paths
    tag_names = {t["name"] for t in public.get("tags") or []}
    assert "internal-health" not in tag_names
    assert "scim" not in tag_names
    # Constants still documented
    assert "/metrics" in _INTERNAL_PATH_PREFIXES or any(
        "/metrics".startswith(p) or p == "/metrics" for p in _INTERNAL_PATH_PREFIXES
    )
    assert "/health" in _INTERNAL_EXACT_PATHS
    assert "scim" in _INTERNAL_TAGS


def test_f12_proof_status_documented() -> None:
    doc = (ROOT / "docs/ops/F12-STAGING-10M-SPAN-SEARCH.md").read_text(encoding="utf-8")
    assert "BLOCKED" in doc
    assert "10M" in doc or "10_000_000" in doc
    # Scaled-down contract CI must exist; must not pretend to be the 10M gate.
    wf = ROOT / ".github/workflows/f12-span-search-contract.yml"
    assert wf.is_file()
    body = wf.read_text(encoding="utf-8")
    assert "10000" in body or "10k" in body.lower() or "--n=10000" in body
    assert "NOT" in body or "not" in body  # honesty about 10M


def test_f85_clerk_gap_documented_in_tracker() -> None:
    tracker = (ROOT / "docs/specs/SOTA-WAVE-TRACKER.md").read_text(encoding="utf-8")
    assert "W3" in tracker
    assert "Clerk" in tracker or "secrets" in tracker.lower()
    assert "F85" in tracker
