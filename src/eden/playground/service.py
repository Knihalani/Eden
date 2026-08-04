"""U03/F49 playground CRUD + run orchestration (Postgres + memory fallback)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.playground.diff import char_diff, grade_outputs
from eden.playground.llm_handler import make_playground_handler
from eden.playground.scorers import aggregate_score, run_scorers
from eden.playground.span_seed import extract_span_seed, fetch_span_step
from eden.prompts.registry import (
    Playground,
    PromptTemplate,
)

logger = logging.getLogger(__name__)

# Progress callback for run streaming: awaited with each event dict.
RunEventCallback = Callable[[dict[str, Any]], Awaitable[None]]

# Optional injected span fetcher (unit tests / alternate stores).
SpanFetcher = Callable[..., Awaitable[dict[str, Any] | None]]

_MAX_ROWS = 50
_DEFAULT_CONCURRENCY = 5


@dataclass
class PlaygroundRecord:
    id: str
    org_id: str
    name: str
    config: dict[str, Any] = field(default_factory=dict)
    created_by: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "config": dict(self.config),
            "created_by": self.created_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class PlaygroundService:
    """Org-scoped playgrounds with write-through Postgres (memory fallback)."""

    def __init__(
        self,
        pg: Any | None = None,
        *,
        memory_only: bool = False,
        span_fetcher: SpanFetcher | None = None,
    ) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._span_fetcher = span_fetcher
        self._memory: dict[str, PlaygroundRecord] = {}
        self._runs: dict[str, list[dict[str, Any]]] = {}

    async def _client(self) -> Any | None:
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def list(self, org_id: str, *, limit: int = 50) -> list[PlaygroundRecord]:
        limit = max(1, min(int(limit), 100))
        client = await self._client()
        if client is None:
            return [p for p in self._memory.values() if p.org_id == org_id][:limit]
        rows = await client.fetch(
            """
            SELECT id, org_id, name, config, created_by, created_at, updated_at
            FROM playgrounds WHERE org_id = $1
            ORDER BY updated_at DESC LIMIT $2
            """,
            org_id,
            limit,
        )
        return [_row_to_pg(dict(r)) for r in rows]

    async def get(self, org_id: str, playground_id: str) -> PlaygroundRecord | None:
        client = await self._client()
        if client is None:
            rec = self._memory.get(playground_id)
            return rec if rec and rec.org_id == org_id else None
        row = await client.fetchrow(
            """
            SELECT id, org_id, name, config, created_by, created_at, updated_at
            FROM playgrounds WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            playground_id,
        )
        return _row_to_pg(dict(row)) if row else None

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        config: dict[str, Any] | None = None,
        created_by: str | None = None,
    ) -> PlaygroundRecord:
        pid = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        cfg = config or _default_config()
        client = await self._client()
        if client is None:
            rec = PlaygroundRecord(
                id=pid,
                org_id=org_id,
                name=name,
                config=cfg,
                created_by=created_by,
                created_at=now,
                updated_at=now,
            )
            self._memory[pid] = rec
            return rec
        row = await client.fetchrow(
            """
            INSERT INTO playgrounds (id, org_id, name, config, created_by)
            VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
            RETURNING id, org_id, name, config, created_by, created_at, updated_at
            """,
            pid,
            org_id,
            name,
            json.dumps(cfg),
            created_by,
        )
        return _row_to_pg(dict(row))

    async def update(
        self,
        org_id: str,
        playground_id: str,
        *,
        name: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> PlaygroundRecord | None:
        existing = await self.get(org_id, playground_id)
        if existing is None:
            return None
        new_name = name if name is not None else existing.name
        new_cfg = config if config is not None else existing.config
        now = datetime.now(UTC).isoformat()
        client = await self._client()
        if client is None:
            existing.name = new_name
            existing.config = new_cfg
            existing.updated_at = now
            return existing
        row = await client.fetchrow(
            """
            UPDATE playgrounds
            SET name = $3, config = $4::jsonb, updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            RETURNING id, org_id, name, config, created_by, created_at, updated_at
            """,
            org_id,
            playground_id,
            new_name,
            json.dumps(new_cfg),
        )
        return _row_to_pg(dict(row)) if row else None

    async def _load_span_seed(
        self, org_id: str, *, trace_id: str, span_id: str | None
    ) -> dict[str, Any] | None:
        """Load + extract the stored request for a span (None when absent)."""
        step: dict[str, Any] | None = None
        if self._span_fetcher is not None:
            step = await self._span_fetcher(
                org_id=org_id, trace_id=trace_id, span_id=span_id
            )
        elif not self._memory_only:
            try:
                step = await fetch_span_step(
                    org_id=org_id, trace_id=trace_id, span_id=span_id
                )
            except Exception as exc:
                logger.warning("from_span: span fetch failed: %s", exc)
                step = None
        if not step:
            return None
        return extract_span_seed(step)

    async def from_span(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        created_by: str | None = None,
    ) -> PlaygroundRecord:
        """Seed a playground from a span's stored request.

        Hydrates messages/model/params/tools server-side from
        ``telemetry_events`` (span-level row first, then the trace's
        first ``agent.step`` / ``llm_call``). Client-supplied
        ``messages`` / ``model`` / ``tools`` are only a fallback when
        nothing usable is stored; when neither side has usable prompt
        content a ``ValueError`` is raised.
        """
        seed = await self._load_span_seed(
            org_id, trace_id=trace_id, span_id=span_id
        )
        if seed is not None:
            seed_messages = list(seed.get("messages") or [])
            seed_model = seed.get("model")
            seed_tools = list(seed.get("tools") or []) or list(tools or [])
            seed_params = dict(seed.get("params") or {})
        else:
            seed_messages = list(messages or [])
            seed_model = None
            seed_tools = list(tools or [])
            seed_params = {}
        system_text, user_text = _split_messages(seed_messages)
        if not user_text and not system_text:
            raise ValueError("no usable prompt content for span")
        cfg = _default_config()
        cfg["source"] = {"trace_id": trace_id, "span_id": span_id}
        if seed_params:
            cfg["params"] = seed_params
        task_model = str(seed_model or model or "t1")
        cfg["tasks"] = [
            {
                "id": "task_a",
                "label": "From span",
                "system": system_text,
                "user": user_text or "{{user}}",
                "model": task_model,
                "tools": seed_tools,
            },
            {
                "id": "task_b",
                "label": "Variant",
                "system": system_text,
                "user": user_text or "{{user}}",
                "model": "t2",
                "tools": seed_tools,
            },
        ]
        name = f"From span {span_id or trace_id[:8]}"
        return await self.create(org_id, name=name, config=cfg, created_by=created_by)

    async def run(
        self,
        org_id: str,
        playground_id: str,
        *,
        params: dict[str, Any] | None = None,
        dataset_rows: list[dict[str, Any]] | None = None,
        on_event: RunEventCallback | None = None,
    ) -> dict[str, Any]:
        """Run the task × row matrix with bounded concurrency.

        Cells run concurrently under an ``asyncio.Semaphore`` sized by
        the config field ``concurrency`` (clamped 1..10, default 5).
        Optional ``on_event`` is awaited with progress dicts:
        ``{"type": "start", ...}`` → one ``{"type": "cell", ...}`` per
        task × row → ``{"type": "done", "run_id", "totals"}``. A cell
        failure is recorded on that cell only; cancellation persists the
        partial run with status ``"cancelled"`` and re-raises.
        """
        rec = await self.get(org_id, playground_id)
        if rec is None:
            raise ValueError("playground not found")
        params = params or {}
        tasks = list(rec.config.get("tasks") or [])
        if not tasks:
            tasks = [_default_task()]
        rows = list(
            dataset_rows or [{"id": "adhoc", "input": params.get("user", "")}]
        )[:_MAX_ROWS]
        global_scorers = list(rec.config.get("scorers") or [])
        concurrency = _clamp_concurrency(rec.config.get("concurrency"))
        runner = Playground(make_playground_handler(org_id))
        run_id = str(uuid.uuid4())
        started = time.perf_counter()

        async def _emit(event: dict[str, Any]) -> None:
            if on_event is None:
                return
            try:
                await on_event(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("playground run event callback failed: %s", exc)

        row_ctx: list[tuple[int, str, dict[str, Any], str | None]] = []
        for row_index, row in enumerate(rows):
            row_id = str(row.get("id") or uuid.uuid4())
            expected_raw = row.get("expected_output", params.get("expected"))
            expected = None if expected_raw is None else str(expected_raw)
            row_params = {
                **params,
                "user": str(row.get("input") or params.get("user") or ""),
                "expected": expected or "",
            }
            row_ctx.append((row_index, row_id, row_params, expected))

        cells: dict[tuple[int, int], dict[str, Any]] = {}
        totals = {
            "cost_usd": 0.0,
            "cells": len(tasks) * len(row_ctx),
            "errors": 0,
        }
        sem = asyncio.Semaphore(concurrency)

        async def _run_cell(
            task_index: int,
            task: dict[str, Any],
            row_index: int,
            row_params: dict[str, Any],
            expected: str | None,
        ) -> None:
            task_id = str(task.get("id") or f"task_{task_index}")
            async with sem:
                template = PromptTemplate(
                    name=str(task.get("label") or task.get("id") or "task"),
                    system=str(task.get("system") or ""),
                    user=str(task.get("user") or "{{user}}"),
                    tools=list(task.get("tools") or []),
                    required_params=["user"]
                    if "{{user}}" in str(task.get("user") or "{{user}}")
                    else [],
                    optional_params=["expected"],
                    model=str(task.get("model") or "t1"),
                )
                try:
                    result = await runner.run(template, dict(row_params))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # Provider/cell failure — record it, let siblings run.
                    cells[(task_index, row_index)] = {
                        "task_id": task.get("id"),
                        "error": str(exc),
                        "response": "",
                        "cost_usd": 0.0,
                    }
                    totals["errors"] += 1
                    await _emit(
                        {
                            "type": "cell",
                            "task_id": task_id,
                            "row_index": row_index,
                            "status": "error",
                            "error": str(exc),
                        }
                    )
                    return
                cost = float(result.cost_usd or 0.0)
                totals["cost_usd"] += cost
                specs = list(task.get("scorers") or global_scorers)
                scores = run_scorers(
                    specs, output=result.response, expected=expected
                )
                cells[(task_index, row_index)] = {
                    "task_id": task.get("id"),
                    "label": task.get("label"),
                    "model": result.model,
                    "response": result.response,
                    "latency_ms": result.latency_ms,
                    "cost_usd": cost,
                    "scores": scores,
                }
                await _emit(
                    {
                        "type": "cell",
                        "task_id": task_id,
                        "row_index": row_index,
                        "status": "ok",
                        "output": result.response,
                        "score": aggregate_score(scores),
                        "scores": scores,
                        "latency_ms": result.latency_ms,
                        "cost_usd": cost,
                    }
                )

        await _emit(
            {
                "type": "start",
                "run_id": run_id,
                "playground_id": playground_id,
                "cells": totals["cells"],
            }
        )
        futures = [
            asyncio.ensure_future(
                _run_cell(task_index, task, row_index, row_params, expected)
            )
            for row_index, _row_id, row_params, expected in row_ctx
            for task_index, task in enumerate(tasks)
        ]
        try:
            await asyncio.gather(*futures)
        except asyncio.CancelledError:
            for fut in futures:
                fut.cancel()
            payload = _build_run_payload(
                run_id, playground_id, "cancelled", row_ctx, tasks, cells, totals
            )
            try:
                await self._persist_run(
                    org_id, playground_id, run_id, payload, totals["cost_usd"]
                )
            except Exception as exc:
                logger.warning("cancelled run persist failed: %s", exc)
            _record_run_metrics(started, totals["cost_usd"])
            raise
        payload = _build_run_payload(
            run_id, playground_id, "completed", row_ctx, tasks, cells, totals
        )
        await self._persist_run(
            org_id, playground_id, run_id, payload, totals["cost_usd"]
        )
        _record_run_metrics(started, totals["cost_usd"])
        await _emit(
            {
                "type": "done",
                "run_id": run_id,
                "totals": {
                    "cost_usd": round(totals["cost_usd"], 6),
                    "cells": totals["cells"],
                    "errors": totals["errors"],
                },
            }
        )
        return payload

    async def promote_experiment(
        self,
        org_id: str,
        playground_id: str,
        *,
        name: str | None = None,
        dataset_id: str | None = None,
    ) -> dict[str, Any]:
        rec = await self.get(org_id, playground_id)
        if rec is None:
            raise ValueError("playground not found")
        ds_id = dataset_id or rec.config.get("dataset_id")
        if not ds_id:
            raise ValueError("dataset_id required to promote")
        from eden.experiments.offline_runner import OfflineExperimentRunner

        exp_name = name or f"From playground {rec.name}"
        runner = OfflineExperimentRunner()
        exp = await runner.create(
            org_id,
            name=exp_name,
            dataset_id=str(ds_id),
            config={
                "source_playground_id": playground_id,
                "tasks": rec.config.get("tasks") or [],
                "scorers": rec.config.get("scorers") or [],
            },
        )
        return {"experiment": exp.to_dict()}

    async def _persist_run(
        self,
        org_id: str,
        playground_id: str,
        run_id: str,
        payload: dict[str, Any],
        cost_usd: float,
    ) -> None:
        client = await self._client()
        if client is None:
            self._runs.setdefault(playground_id, []).append(payload)
            return
        try:
            await client.execute(
                """
                INSERT INTO playground_runs
                    (id, playground_id, org_id, status, results, cost_usd)
                VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
                """,
                run_id,
                playground_id,
                org_id,
                str(payload.get("status") or "completed"),
                json.dumps(payload),
                cost_usd,
            )
        except Exception as exc:
            logger.warning("playground_run persist failed: %s", exc)
            self._runs.setdefault(playground_id, []).append(payload)


def _clamp_concurrency(raw: Any) -> int:
    """Clamp the config ``concurrency`` field to 1..10 (default 5)."""
    try:
        value = int(raw) if raw is not None else _DEFAULT_CONCURRENCY
    except (TypeError, ValueError):
        value = _DEFAULT_CONCURRENCY
    return max(1, min(value, 10))


def _split_messages(messages: list[dict[str, Any]]) -> tuple[str, str]:
    """Return ``(system_text, user_text)`` from a chat messages array."""
    system_text = ""
    user_text = ""
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "")
        content = m.get("content")
        if isinstance(content, list):
            content = "\n".join(
                str(block.get("text") or "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        content = str(content or "")
        if role == "system" and not system_text:
            system_text = content
        elif role in ("user", "human") and not user_text and content:
            user_text = content
    return system_text, user_text


def _grade_score(cell: dict[str, Any]) -> float:
    """Aggregate cell score for comparison grading (neutral 0.5 fallback).

    The neutral fallback is grading-only plumbing for
    :func:`grade_outputs`; recorded scores themselves are never
    fabricated (see :mod:`eden.playground.scorers`).
    """
    agg = aggregate_score(cell.get("scores") or [])
    return 0.5 if agg is None else float(agg)


def _build_run_payload(
    run_id: str,
    playground_id: str,
    status: str,
    row_ctx: list[tuple[int, str, dict[str, Any], str | None]],
    tasks: list[dict[str, Any]],
    cells: dict[tuple[int, int], dict[str, Any]],
    totals: dict[str, Any],
) -> dict[str, Any]:
    """Assemble the run payload matrix from completed cells (row order)."""
    matrix: list[dict[str, Any]] = []
    for row_index, row_id, row_params, _expected in row_ctx:
        task_results = [
            cells[(task_index, row_index)]
            for task_index in range(len(tasks))
            if (task_index, row_index) in cells
        ]
        grade = "tie"
        delta = 0.0
        diff: dict[str, Any] | None = None
        if len(task_results) >= 2:
            a = task_results[0]
            b = task_results[1]
            grade, delta = grade_outputs(
                str(a.get("response") or ""),
                str(b.get("response") or ""),
                control_score=_grade_score(a),
                treatment_score=_grade_score(b),
                control_cost=float(a.get("cost_usd") or 0),
                treatment_cost=float(b.get("cost_usd") or 0),
            )
            diff = char_diff(
                str(a.get("response") or ""), str(b.get("response") or "")
            )
        matrix.append(
            {
                "row_id": row_id,
                "input": row_params.get("user"),
                "tasks": task_results,
                "grade": grade,
                "score_delta": delta,
                "diff": diff,
            }
        )
    return {
        "run_id": run_id,
        "playground_id": playground_id,
        "status": status,
        "matrix": matrix,
        "cost_usd": round(float(totals.get("cost_usd") or 0.0), 6),
        "task_count": len(tasks),
        "row_count": len(matrix),
        "error_count": int(totals.get("errors") or 0),
        "created_at": datetime.now(UTC).isoformat(),
    }


def _record_run_metrics(started: float, cost_usd: float) -> None:
    """Record run duration + spend into the shared metrics registry."""
    try:
        from eden.observability.playground_metrics import (
            record_playground_cost_usd,
            record_playground_run_seconds,
        )

        record_playground_run_seconds(time.perf_counter() - started)
        record_playground_cost_usd(cost_usd)
    except Exception as exc:
        logger.debug("playground metrics record failed: %s", exc)


def _default_task() -> dict[str, Any]:
    return {
        "id": "task_a",
        "label": "Default",
        "system": "",
        "user": "{{user}}",
        "model": "t1",
        "tools": [],
    }


def _default_config() -> dict[str, Any]:
    return {
        "tasks": [
            _default_task(),
            {
                "id": "task_b",
                "label": "Compare",
                "system": "",
                "user": "{{user}}",
                "model": "t2",
                "tools": [],
            },
        ],
        "scorers": [{"name": "exact_match"}],
        "dataset_id": None,
        "params": {},
    }


def _row_to_pg(row: dict[str, Any]) -> PlaygroundRecord:
    cfg = row.get("config") or {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    created = row.get("created_at")
    updated = row.get("updated_at")
    return PlaygroundRecord(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        config=dict(cfg),
        created_by=row.get("created_by"),
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created or ""),
        updated_at=updated.isoformat() if hasattr(updated, "isoformat") else str(updated or ""),
    )


__all__ = ["PlaygroundRecord", "PlaygroundService"]
