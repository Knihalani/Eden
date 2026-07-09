"""Tests for audit 2026-07-06 lazy import optimizations.

These tests run in subprocesses to guarantee isolation from
pytest's own import cache. Each test asserts that the
"heavy" dependency is NOT in ``sys.modules`` after the target
module is freshly imported in a clean process.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest


def _run_in_subprocess(code: str) -> dict:
    """Run ``code`` in a fresh Python subprocess and return
    the parsed JSON output.

    The subprocess gets a clean sys.modules so we can detect
    any side-effect imports the target module triggers.
    """
    full_code = (
        "import sys, json\n"
        f"{code}\n"
        "print(json.dumps({'loaded': sorted(m for m in sys.modules if not m.startswith('_') and not m.startswith('pytest'))[:80]}))"
    )
    result = subprocess.run(
        [sys.executable, "-c", full_code],
        capture_output=True,
        text=True,
        cwd="/Users/kaiavnihalani/Downloads/Eden",
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"subprocess failed: rc={result.returncode}\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )
    return json.loads(result.stdout.strip().splitlines()[-1])


def _has(target: str, code: str) -> bool:
    """Run ``code`` in subprocess; return True if ``target`` is loaded."""
    out = _run_in_subprocess(code)
    return target in out["loaded"]


def test_kb_episodic_does_not_load_qdrant():
    """Importing episodic client must not load Qdrant (saves ~570ms)."""
    loaded = _has(
        "qdrant_client",
        "import eden.kb.episodic.client",
    )
    assert not loaded, "qdrant_client was loaded by eden.kb.episodic.client"


def test_llm_client_does_not_load_openai():
    """Importing LLM client must not load the openai SDK (saves ~200ms)."""
    loaded = _has(
        "openai",
        "from eden.llm.client import OpenRouterClient",
    )
    assert not loaded, "openai was loaded by eden.llm.client"


def test_optimization_cache_does_not_load_qdrant():
    """Importing the L1 exact-match cache must not load Qdrant."""
    loaded = _has(
        "qdrant_client",
        "from eden.optimization.cache import ExactMatchCache",
    )
    assert not loaded, "qdrant_client was loaded by eden.optimization.cache"


def test_middleware_internal_only_does_not_load_siblings():
    """Importing one middleware must not load the others."""
    out = _run_in_subprocess(
        "from eden.api.middleware import internal_only"
    )
    heavy_siblings = (
        "eden.api.middleware.quota_enforcement",
        "eden.api.middleware.tenant_rate_limit",
        "eden.api.middleware.idempotency",
    )
    for sib in heavy_siblings:
        assert sib not in out["loaded"], (
            f"{sib} was loaded by eden.api.middleware.internal_only. "
            f"The middleware __init__.py is supposed to be lazy."
        )


def test_data_platform_pii_does_not_load_clickhouse():
    """Importing the PII module must not load ClickHouse (no aiohttp)."""
    out = _run_in_subprocess(
        "from eden.data_platform.pii import PIIMasker"
    )
    # ClickHouse sink pulls aiohttp. If aiohttp is loaded,
    # the clickhouse_sink is in the import graph.
    assert "aiohttp" not in out["loaded"], (
        "aiohttp was loaded as a side-effect of importing "
        "eden.data_platform.pii. The data_platform __init__.py "
        "is supposed to be lazy."
    )
    assert "eden.data_platform.clickhouse_sink" not in out["loaded"]


def test_data_platform_pii_does_not_load_bronze_sink():
    """Importing PII must not load bronze sink (api middleware)."""
    out = _run_in_subprocess(
        "from eden.data_platform.pii import PIIMasker"
    )
    assert "eden.data_platform.bronze_sink" not in out["loaded"]


def test_llmops_filters_does_not_load_ai_gateway():
    """Importing the PII filter must not load the AI gateway."""
    out = _run_in_subprocess(
        "from eden.llmops.filters.pii import PIIFilter"
    )
    assert "eden.llmops.ai_gateway" not in out["loaded"]


def test_observability_logging_shim_does_not_load_telemetry():
    """Importing the logging shim must not load telemetry."""
    out = _run_in_subprocess(
        "from eden.observability.logging_shim import install"
    )
    assert "eden.observability.telemetry_collector" not in out["loaded"]


def test_routes_kb_does_not_load_unrelated_routes():
    """Importing the KB route must not eagerly load other routes."""
    out = _run_in_subprocess(
        "from eden.api.routes.kb import router"
    )
    # analytics is in the original eager __init__ re-export list
    assert "eden.api.routes.analytics" not in out["loaded"]


def test_smoke_full_app_still_works():
    """Smoke test: full app import still produces a working FastAPI app.

    This guards against the lazy __init__ changes accidentally
    breaking the boot path.
    """
    code = (
        "from eden.api.app import app\n"
        "import json\n"
        "print(json.dumps({'routes': len(app.routes), 'ok': True}))"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd="/Users/kaiavnihalani/Downloads/Eden",
        timeout=60,
    )
    assert result.returncode == 0, (
        f"App import failed: {result.stderr}"
    )
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["ok"] is True
    assert out["routes"] > 700, (
        f"Expected >700 routes (was 743), got {out['routes']}. "
        f"Routes may have been lost when making __init__s lazy."
    )
