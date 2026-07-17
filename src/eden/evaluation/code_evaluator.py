"""F54 sandboxed code evaluators — restricted exec in subprocess-less sandbox."""

from __future__ import annotations

import ast
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

_FORBIDDEN_NAMES = frozenset(
    {
        "__import__",
        "eval",
        "exec",
        "compile",
        "open",
        "input",
        "breakpoint",
        "globals",
        "locals",
        "getattr",
        "setattr",
        "delattr",
        "vars",
        "dir",
        "help",
        "memoryview",
        "bytearray",
    }
)


def _validate_source(source: str) -> None:
    tree = ast.parse(source, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import | ast.ImportFrom):
            raise ValueError("imports not allowed in code evaluators")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in _FORBIDDEN_NAMES:
                raise ValueError(f"forbidden call: {node.func.id}")


class CodeEvaluatorRunner:
    """Run org-scoped Python evaluators in a minimal sandbox."""

    async def list_evaluators(self, org_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT id, org_id, name, entrypoint, timeout_ms, enabled, "
            "created_at, updated_at FROM code_evaluators WHERE org_id = $1 "
            "ORDER BY updated_at DESC",
            org_id,
        )
        return [dict(r) for r in rows]

    async def register(
        self,
        org_id: str,
        *,
        name: str,
        source_code: str,
        entrypoint: str = "evaluate",
        timeout_ms: int = 500,
    ) -> dict[str, Any] | None:
        _validate_source(source_code)
        client = await self._client()
        if client is None:
            return None
        eid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO code_evaluators
            (id, org_id, name, source_code, entrypoint, timeout_ms)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            """,
            eid,
            org_id,
            name,
            source_code,
            entrypoint,
            timeout_ms,
        )
        return {"id": eid, "name": name, "entrypoint": entrypoint}

    async def run(
        self, org_id: str, evaluator_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT source_code, entrypoint FROM code_evaluators "
            "WHERE org_id = $1 AND id = $2::uuid AND enabled = true",
            org_id,
            evaluator_id,
        )
        if not row:
            return None
        source = str(row["source_code"])
        entry = str(row["entrypoint"])
        try:
            _validate_source(source)
            namespace: dict[str, Any] = {}
            exec(compile(source, f"<evaluator:{evaluator_id}>", "exec"), namespace)
            fn = namespace.get(entry)
            if not callable(fn):
                return None
            raw = fn(payload)
            if isinstance(raw, dict):
                score = float(raw.get("score", 0))
                return {
                    "score": score,
                    "passed": bool(raw.get("passed", score >= 0.7)),
                    "confidence": float(raw.get("confidence", 0.9)),
                    "judge_tier": "code",
                    "cost_usd": 0.0,
                    "rationale": str(raw.get("rationale") or "code evaluator"),
                    "label": raw.get("label"),
                }
            if isinstance(raw, (int, float)):
                score = float(raw)
                return {
                    "score": score,
                    "passed": score >= 0.7,
                    "confidence": 0.9,
                    "judge_tier": "code",
                    "cost_usd": 0.0,
                    "rationale": "code evaluator numeric",
                }
        except Exception as exc:
            logger.debug("code_evaluator: run failed: %s", exc)
        return None

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
