"""F54 code evaluators — gated until a real sandbox exists.

Registration and execution are disabled by default
(``code_evaluators_exec_enabled=False``). The previous AST denylist +
in-process ``exec()`` was escape-prone and did not enforce timeout_ms.
"""

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


class CodeEvaluatorDisabledError(RuntimeError):
    """Raised when code-evaluator exec is feature-gated off."""


def _exec_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "code_evaluators_exec_enabled", False))
    except Exception:
        return False


def _require_exec_enabled() -> None:
    if not _exec_enabled():
        raise CodeEvaluatorDisabledError(
            "Code evaluators are disabled until a real sandbox ships "
            "(set EDEN_CODE_EVALUATORS_EXEC_ENABLED=true only in locked-down "
            "environments)."
        )


def _validate_source(source: str) -> None:
    tree = ast.parse(source, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import | ast.ImportFrom):
            raise ValueError("imports not allowed in code evaluators")
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in _FORBIDDEN_NAMES
        ):
            raise ValueError(f"forbidden call: {node.func.id}")
        # Attribute-call chains (e.g. __builtins__.__import__) were not
        # covered by the Name-only denylist — reject dunder attribute access
        # while the feature stays gated.
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ValueError(f"forbidden attribute access: {node.attr}")


class CodeEvaluatorRunner:
    """Run org-scoped Python evaluators (disabled by default)."""

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
        _require_exec_enabled()
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
        if not _exec_enabled():
            logger.warning(
                "code_evaluator: run blocked (code_evaluators_exec_enabled=false)"
            )
            return None
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
            # Restricted builtins — still not a real sandbox; feature
            # remains off by default.
            safe_builtins = {
                "abs": abs,
                "bool": bool,
                "dict": dict,
                "enumerate": enumerate,
                "float": float,
                "int": int,
                "len": len,
                "list": list,
                "max": max,
                "min": min,
                "range": range,
                "round": round,
                "str": str,
                "sum": sum,
                "tuple": tuple,
                "zip": zip,
            }
            namespace: dict[str, Any] = {"__builtins__": safe_builtins}
            exec(  # noqa: S102 — gated off by default; restricted builtins
                compile(source, f"<evaluator:{evaluator_id}>", "exec"),
                namespace,
            )
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
