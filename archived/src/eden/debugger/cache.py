"""F03 — Prefix-cache service for debugger LLM calls.

Provides:
  * ``llm_input_hash`` — deterministic SHA-256 hash of the non-system
    messages in a chat history.  System messages are excluded so that
    prompt-engineering experiments on the system prompt still hit the
    cache for identical user/assistant turns.
  * ``PrefixCacheService`` — upsert / get / get_prefix_for_trace over
    the ``debugger_llm_cache`` table.

Design notes
────────────
* Content-addressed: the PK includes ``input_hash`` so two traces
  that produce identical LLM inputs share a single cache row.
* System-excluded hash: excludes ``role == "system"`` from the hash so
  prompt variations don't bust the prefix cache for unchanged
  user/assistant context.
* Fail-open: all public methods swallow exceptions and return a safe
  default so callers on the hot ingest path never break.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


# ── Hash ──────────────────────────────────────────────────────────


def llm_input_hash(messages: list[dict[str, Any]]) -> str:
    """Return a stable SHA-256 hex digest of *messages*, excluding system role.

    Only ``role`` != ``"system"`` messages contribute to the digest so
    that system-prompt changes (prompt engineering experiments) do NOT
    invalidate the prefix cache for otherwise identical conversations.

    Args:
        messages: List of ``{"role": ..., "content": ...}`` dicts.

    Returns:
        64-character lowercase hex string.
    """
    filtered = [m for m in messages if m.get("role") != "system"]
    canonical = json.dumps(filtered, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


# ── Service ───────────────────────────────────────────────────────


class PrefixCacheService:
    """CRUD over ``debugger_llm_cache``.

    Args:
        pg: asyncpg connection / pool (or any object with
            ``execute`` / ``fetch`` / ``fetchrow`` methods matching
            the asyncpg contract).
    """

    def __init__(self, pg: Any) -> None:
        self._pg = pg

    async def upsert(
        self,
        *,
        org_id: str,
        trace_id: str,
        step_number: int,
        input_hash: str,
        response: dict[str, Any],
        model: str | None = None,
    ) -> bool:
        """Insert-or-ignore a cache row.  Returns True on success."""
        try:
            await self._pg.execute(
                """
                INSERT INTO debugger_llm_cache
                    (org_id, source_trace_id, step_number, input_hash, response, model)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                ON CONFLICT (org_id, source_trace_id, step_number, input_hash)
                    DO NOTHING
                """,
                org_id,
                trace_id,
                step_number,
                input_hash,
                json.dumps(response, default=str),
                model,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.debug("PrefixCacheService.upsert failed: %s", exc)
            return False

    async def get(
        self,
        *,
        org_id: str,
        trace_id: str,
        step_number: int,
        input_hash: str,
    ) -> dict[str, Any] | None:
        """Return the cached response for an exact (org, trace, step, hash) key."""
        try:
            row = await self._pg.fetchrow(
                """
                SELECT response
                FROM debugger_llm_cache
                WHERE org_id = $1
                  AND source_trace_id = $2
                  AND step_number = $3
                  AND input_hash = $4
                """,
                org_id,
                trace_id,
                step_number,
                input_hash,
            )
            if row is None:
                return None
            resp = row["response"]
            if isinstance(resp, str):
                resp = json.loads(resp)
            return resp
        except Exception as exc:  # noqa: BLE001
            logger.debug("PrefixCacheService.get failed: %s", exc)
            return None

    async def get_prefix_for_trace(
        self,
        *,
        org_id: str,
        trace_id: str,
    ) -> list[dict[str, Any]]:
        """Return all cache rows for a trace, ordered by step_number asc.

        Each element is a dict with keys:
            step_number, input_hash, response, model, created_at
        """
        try:
            rows = await self._pg.fetch(
                """
                SELECT step_number, input_hash, response, model, created_at
                FROM debugger_llm_cache
                WHERE org_id = $1
                  AND source_trace_id = $2
                ORDER BY step_number ASC
                """,
                org_id,
                trace_id,
            )
            out: list[dict[str, Any]] = []
            for row in rows:
                resp = row["response"]
                if isinstance(resp, str):
                    resp = json.loads(resp)
                out.append({
                    "step_number": row["step_number"],
                    "input_hash": row["input_hash"],
                    "response": resp,
                    "model": row["model"],
                    "created_at": str(row["created_at"]),
                })
            return out
        except Exception as exc:  # noqa: BLE001
            logger.debug("PrefixCacheService.get_prefix_for_trace failed: %s", exc)
            return []


# ── Microbenchmarks (F03 stretch acceptance) ─────────────────────


def microbench_llm_input_hash(
    *,
    iterations: int = 10_000,
    messages: list[dict[str, Any]] | None = None,
) -> dict[str, float]:
    """Measure hot-path ``llm_input_hash`` latency (target p99 < 1 ms).

    Returns p50/p95/p99 in milliseconds plus iteration count.
    """
    payload = messages or [
        {"role": "user", "content": "step question"},
        {"role": "assistant", "content": "step answer"},
    ]
    samples: list[float] = []
    for _ in range(max(1, iterations)):
        t0 = time.perf_counter()
        llm_input_hash(payload)
        samples.append(time.perf_counter() - t0)
    samples.sort()

    def _pct(p: float) -> float:
        idx = min(len(samples) - 1, int(p * len(samples)))
        return samples[idx] * 1000.0

    return {
        "p50_ms": _pct(0.50),
        "p95_ms": _pct(0.95),
        "p99_ms": _pct(0.99),
        "iterations": float(len(samples)),
    }


def microbench_backfill_throughput(
    *,
    trace_count: int = 100,
    steps_per_trace: int = 8,
    messages: list[dict[str, Any]] | None = None,
) -> dict[str, float]:
    """Estimate checkpoint hash throughput for backfill (target ≥1k traces/hr).

    Simulates the CPU work per trace step (hash only — DB upsert is async).
    Extrapolates ``traces_per_hour`` from the measured window.
    """
    payload = messages or [
        {"role": "user", "content": "backfill prompt"},
        {"role": "assistant", "content": "backfill response"},
    ]
    traces = max(1, trace_count)
    steps = max(1, steps_per_trace)
    t0 = time.perf_counter()
    for _ in range(traces):
        for _step in range(steps):
            llm_input_hash(payload)
    elapsed = max(time.perf_counter() - t0, 1e-9)
    traces_per_hour = traces / elapsed * 3600.0
    return {
        "traces_per_hour": traces_per_hour,
        "elapsed_s": elapsed,
        "trace_count": float(traces),
        "steps_per_trace": float(steps),
    }


def microbench_prefix_replay(
    *,
    prefix_steps: int = 20,
    iterations: int = 200,
) -> dict[str, float]:
    """Simulate cached-prefix replay CPU work (F01 target p95 < 2s).

    Measures in-memory hash + JSON canonicalization per prefix step —
    the dominant CPU cost before gateway tail execution.
    """
    messages = [
        {"role": "user", "content": "prefix step prompt"},
        {"role": "assistant", "content": "prefix step response"},
    ]
    samples: list[float] = []
    steps = max(1, prefix_steps)
    reps = max(1, iterations)
    for _ in range(reps):
        t0 = time.perf_counter()
        for _step in range(steps):
            llm_input_hash(messages)
            json.dumps(messages, sort_keys=True, separators=(",", ":"))
        samples.append(time.perf_counter() - t0)
    samples.sort()

    def _pct(p: float) -> float:
        idx = min(len(samples) - 1, int(p * len(samples)))
        return samples[idx] * 1000.0

    return {
        "p50_ms": _pct(0.50),
        "p95_ms": _pct(0.95),
        "p99_ms": _pct(0.99),
        "prefix_steps": float(steps),
        "iterations": float(reps),
    }


__all__ = [
    "llm_input_hash",
    "PrefixCacheService",
    "microbench_llm_input_hash",
    "microbench_backfill_throughput",
    "microbench_prefix_replay",
]
