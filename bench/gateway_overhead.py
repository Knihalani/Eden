"""Measure Eden /gateway/v1 chat-completions overhead with a zero-latency upstream.

Isolates Eden's own work (auth override, PII resolve, learn-filter pass,
response shaping, telemetry schedule) by stubbing the OpenAI client so
``chat.completions.create`` returns immediately.

Run::

    PYTHONPATH=src .venv/bin/python bench/gateway_overhead.py [--n 200]

Budget (F39 / marketing): total gateway overhead p95 < 5ms (excl. provider).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

# Direct-run bootstrap: ``python bench/gateway_overhead.py`` puts
# ``bench/`` on sys.path, not the repo root — add the root so the
# ``bench`` package resolves at all.
_REPO_ROOT = str(Path(__file__).resolve().parents[1])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Resolve ``eden`` to the app package, not the ``sdk/python/eden`` stub.
# Importing ``bench.common`` runs its ``sys.path`` fixup (see its module
# docstring). Without this, ``import eden.api.app`` in ``_build`` crashes
# with ``ModuleNotFoundError`` when the bench is run directly.
import bench.common  # noqa: F401, E402  (side-effect: sys.path fixup)


def _pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=100, method="inclusive")[int(p) - 1]


class _StubUsage:
    def __init__(self) -> None:
        self.prompt_tokens = 12
        self.completion_tokens = 7
        self.total_tokens = 19


class _StubMessage:
    def __init__(self) -> None:
        self.role = "assistant"
        self.content = "ok"
        self.refusal = None
        self.tool_calls = None
        self.function_call = None
        self.audio = None


class _StubChoice:
    def __init__(self) -> None:
        self.index = 0
        self.message = _StubMessage()
        self.finish_reason = "stop"
        self.logprobs = None


class _StubChatResponse:
    """Minimal stand-in for openai.types.chat.ChatCompletion."""

    def __init__(self) -> None:
        self.id = "chatcmpl-bench"
        self.object = "chat.completion"
        self.created = int(time.time())
        self.model = "openai/gpt-4o-mini"
        self.choices = [_StubChoice()]
        self.usage = _StubUsage()
        self.system_fingerprint = "fp_bench"


def _stub_chat_response() -> _StubChatResponse:
    return _StubChatResponse()


def _build() -> tuple[Any, Any]:
    """Wire TestClient + gateway stubs the same way integration tests do."""
    from fastapi.testclient import TestClient

    import eden.config as config_mod
    from eden.api.app import app
    from eden.api.deps import get_gateway_auth
    from eden.api.routes import gateway as gateway_module
    from eden.config import Settings
    from eden.observability import telemetry_collector as tc_module

    # Clear lru_cache on the real get_settings before we replace it.
    if hasattr(config_mod.get_settings, "cache_clear"):
        config_mod.get_settings.cache_clear()

    blank = Settings(
        openrouter_api_key="",
        openrouter_base_url="https://openrouter.ai/api/v1",
        minimax_api_key="",
        minimax_base_url="https://api.openai.com/v1",
        use_minimax=False,
        rate_limit_enabled=False,
        quota_enabled=False,
        redis_url="",
    )

    fake_auth = {
        "org_id": "00000000-0000-0000-0000-0000000000b1",
        "user_id": None,
        "api_key_id": "key-bench",
        "auth_method": "api_key",
    }
    app.dependency_overrides[get_gateway_auth] = lambda: fake_auth

    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    collector.ingest = AsyncMock(return_value=True)

    async def _get_collector():
        return collector

    # Patch modules after import so request path sees stubs.
    gateway_module._settings = lambda: blank  # type: ignore[method-assign]
    gateway_module.get_telemetry_collector = _get_collector  # type: ignore[attr-defined]
    tc_module.get_telemetry_collector = _get_collector  # type: ignore[attr-defined]
    config_mod.get_settings = lambda: blank  # type: ignore[assignment]

    # Middleware imports get_settings at call time via eden.config / local imports.
    from eden.api.middleware import quota_enforcement as qe
    from eden.api.middleware import tenant_rate_limit as trl

    trl.get_settings = lambda: blank  # type: ignore[attr-defined]
    qe.get_settings = lambda: blank  # type: ignore[attr-defined]

    # Bypass tenant PII policy lookup (would hit Postgres/cache).
    async def _no_tenant_policy(_org_id: str):
        return None

    import eden.llmops.policy_cache as policy_cache

    policy_cache.get_policy_for_tenant = _no_tenant_policy  # type: ignore[assignment]

    # In-memory redis for exact-cache path.
    store: dict[str, str] = {}

    class _FakeRedis:
        async def get(self, key: str):
            return store.get(key)

        async def set(self, key: str, value: str, ex: int | None = None):
            store[key] = value

    import eden.llmops.gateway_optimizations as go

    go.get_redis_client = AsyncMock(return_value=_FakeRedis())  # type: ignore[assignment]
    go._coalescer = None

    stub_client = MagicMock()
    stub_client.chat = MagicMock()
    stub_client.chat.completions = MagicMock()
    stub_client.chat.completions.create = AsyncMock(return_value=_stub_chat_response())
    gateway_module._async_client = stub_client
    gateway_module._gateway = None

    # Cost stamping may consult CostResolver / Postgres — keep it off the clock.
    async def _noop_stamp(**_kwargs: Any) -> None:
        return None

    gateway_module._stamp_gateway_cost_usd = _noop_stamp  # type: ignore[assignment]

    # Don't schedule real telemetry tasks during the bench.
    def _noop_telemetry_bg(**_kwargs: Any) -> None:
        return None

    gateway_module._emit_gateway_telemetry_bg = _noop_telemetry_bg  # type: ignore[assignment]

    client = TestClient(app, raise_server_exceptions=False)
    client.cookies.set("authorization", "test-token-for-default-deny")
    return client, app


def run(
    *,
    n: int = 200,
    warmup: int = 20,
    pii_bypass: bool = True,
) -> dict[str, Any]:
    client, app = _build()
    from eden.api.deps import get_gateway_auth

    payload: dict[str, Any] = {
        "model": "openai/gpt-4o-mini",
        "messages": [{"role": "user", "content": "hello"}],
    }
    headers = {
        "X-Eden-Exact-Cache": "false",
        "X-Eden-Coalesce": "false",
    }
    if pii_bypass:
        payload["pii_filter_enabled"] = False
        headers["X-PII-Bypass"] = "true"

    def one() -> tuple[int, float]:
        t0 = time.perf_counter()
        r = client.post("/gateway/v1/chat/completions", json=payload, headers=headers)
        return r.status_code, (time.perf_counter() - t0) * 1000.0

    # Warmup: imports, middleware, filter install.
    for _ in range(warmup):
        code, _ = one()
        if code != 200:
            # Still collect a sample for diagnosis.
            break

    samples: list[float] = []
    codes: dict[int, int] = {}
    last_body = ""
    for _ in range(n):
        code, ms = one()
        codes[code] = codes.get(code, 0) + 1
        if code == 200:
            samples.append(ms)
        elif not last_body:
            err = client.post(
                "/gateway/v1/chat/completions", json=payload, headers=headers
            )
            last_body = err.text[:500]

    if not samples:
        raise RuntimeError(f"no successful gateway responses; statuses={codes} body={last_body}")

    samples.sort()
    result = {
        "name": "gateway_chat_completions_overhead",
        "n": n,
        "ok_n": len(samples),
        "warmup": warmup,
        "status_counts": codes,
        "p50_ms": round(_pct(samples, 50), 4),
        "p95_ms": round(_pct(samples, 95), 4),
        "p99_ms": round(_pct(samples, 99), 4),
        "mean_ms": round(statistics.fmean(samples), 4),
        "min_ms": round(min(samples), 4),
        "max_ms": round(max(samples), 4),
        "budget_p95_ms": 5.0,
        "meets_budget_p95": _pct(samples, 95) < 5.0,
        "pii_bypass": pii_bypass,
        "note": (
            "Local TestClient + stubbed upstream (0ms provider). "
            "Percentiles computed on HTTP 200 only. "
            "Includes ASGI/TestClient overhead; excludes real network/model."
        ),
    }
    if last_body:
        result["first_error_body"] = last_body

    app.dependency_overrides.pop(get_gateway_auth, None)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument(
        "--pii",
        choices=("bypass", "on"),
        default="bypass",
        help="bypass = X-PII-Bypass (baseline); on = run default PII resolve/redact path",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = run(n=args.n, warmup=args.warmup, pii_bypass=(args.pii == "bypass"))
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("== gateway overhead (stubbed upstream) ==")
        print(
            f"n={result['n']} ok={result['ok_n']} warmup={result['warmup']} "
            f"pii={args.pii} statuses={result['status_counts']}"
        )
        print(
            f"p50={result['p50_ms']:.4f}ms  "
            f"p95={result['p95_ms']:.4f}ms  "
            f"p99={result['p99_ms']:.4f}ms  "
            f"mean={result['mean_ms']:.4f}ms  "
            f"min={result['min_ms']:.4f}ms  "
            f"max={result['max_ms']:.4f}ms"
        )
        verdict = "PASS" if result["meets_budget_p95"] else "FAIL"
        print(f"budget: p95 < {result['budget_p95_ms']}ms → {verdict}")
        print(result["note"])
        if "first_error_body" in result:
            print("error sample:", result["first_error_body"])
    return 0 if result.get("meets_budget_p95") and result["status_counts"].get(200) else 1


if __name__ == "__main__":
    sys.exit(main())
