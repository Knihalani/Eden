"""End-to-end request hot-path benchmark.

Simulates a typical authenticated GET request to a lightweight
endpoint and measures the wall-clock time spent in:
  - middleware chain (correlation_id, latency, internal_only,
    default_deny, rls_org_context, tenant_rate_limit, gzip)
  - route handler dispatch (FastAPI's Depends resolution)
  - the route handler itself (just returns a JSON dict)

Run with: ``python bench/request_path.py [--n N]``
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from unittest.mock import AsyncMock, MagicMock, patch

from starlette.testclient import TestClient


def _build_client():
    """Build a TestClient with all the external dependencies mocked.

    We patch:
      - get_current_user → a fake authenticated user dict
      - get_postgres_client → a stub
      - get_redis_client → a stub
      - jwt decode → a valid payload
    so the middleware + auth chain can run end-to-end without
    real DB / Redis / Clerk.
    """
    from eden.api.app import app
    from eden.api import deps as deps_mod
    from eden.api.utils import clerk_auth as clerk_mod

    # Mock user / org identity
    fake_user = {
        "sub": "user-test-1234",
        "org_id": "00000000-0000-0000-0000-000000000001",
        "role": "owner",
    }

    # Patch the auth resolvers
    deps_mod.get_current_user = AsyncMock(return_value=fake_user)
    deps_mod.get_current_org = AsyncMock(return_value=fake_user["org_id"])
    deps_mod.get_current_org_member = AsyncMock(return_value=fake_user)
    deps_mod._resolve_token_payload = AsyncMock(return_value=fake_user)
    clerk_mod.verify_clerk_token = AsyncMock(return_value=fake_user)

    # Patch DB / Redis
    from eden.storage import postgres as pg_mod
    pg_mod.get_postgres_client = AsyncMock(return_value=MagicMock())
    from eden.storage import redis as redis_mod
    redis_mod.get_redis_client = AsyncMock(return_value=MagicMock())

    return TestClient(app, raise_server_exceptions=False), app


def _hit_health(client: TestClient) -> tuple[int, float]:
    """Hit /health and return (status_code, elapsed_ms)."""
    t0 = time.perf_counter()
    r = client.get("/health")
    elapsed = (time.perf_counter() - t0) * 1000
    return r.status_code, elapsed


def _hit_docs(client: TestClient) -> tuple[int, float]:
    """Hit /docs (also public, exercises the docs JSON)."""
    t0 = time.perf_counter()
    r = client.get("/docs")
    elapsed = (time.perf_counter() - t0) * 1000
    return r.status_code, elapsed


def run(n: int = 200) -> dict:
    """Drive the real ASGI app end to end and return the measurements.

    Split out of ``main`` so ``bench.run_all`` can collect the result rather
    than scrape stdout. Requests go through the actual FastAPI app and its
    full middleware stack — nothing here is simulated.
    """
    args = argparse.Namespace(n=n)
    client, _ = _build_client()

    # Warm up: 20 requests to populate the import cache and any
    # lazy initialisation.
    for _ in range(20):
        _hit_health(client)
        _hit_docs(client)

    health_times: list[float] = []
    docs_times: list[float] = []
    statuses: dict[str, set[int]] = {"health": set(), "docs": set()}

    for _ in range(args.n):
        s, t = _hit_health(client)
        health_times.append(t)
        statuses["health"].add(s)
        s, t = _hit_docs(client)
        docs_times.append(t)
        statuses["docs"].add(s)

    def percentiles(values: list[float]) -> dict:
        s = sorted(values)
        n = len(s)
        return {
            "p50_ms": round(s[n // 2], 3),
            "p95_ms": round(s[int(n * 0.95)], 3),
            "p99_ms": round(s[int(n * 0.99)], 3),
            "mean_ms": round(statistics.fmean(s), 3),
            "max_ms": round(s[-1], 3),
        }

    results = {
        "n": args.n,
        "health": {**percentiles(health_times), "statuses": sorted(statuses["health"])},
        "docs": {**percentiles(docs_times), "statuses": sorted(statuses["docs"])},
    }
    return results


def main():
    parser = argparse.ArgumentParser(description="End-to-end request bench")
    parser.add_argument("--n", type=int, default=200)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    results = run(n=args.n)
    if args.json:
        print(json.dumps(results, indent=2))
        return

    print(f"{'endpoint':<12} {'p50_ms':>10} {'p95_ms':>10} {'p99_ms':>10} {'mean_ms':>10} {'max_ms':>10}")
    print("-" * 70)
    for name in ("health", "docs"):
        r = results[name]
        print(
            f"{name:<12} "
            f"{r['p50_ms']:>10.3f} "
            f"{r['p95_ms']:>10.3f} "
            f"{r['p99_ms']:>10.3f} "
            f"{r['mean_ms']:>10.3f} "
            f"{r['max_ms']:>10.3f} "
            f"statuses={r['statuses']}"
        )


if __name__ == "__main__":
    main()
