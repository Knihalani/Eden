"""F56 CI-eval run history + baseline resolution.

Reads/writes the ``regression_eval_runs`` table (base columns created in
migration 101, ``metadata`` JSONB added in migration 141). The regression
runner (``regression_runner.py``) owns the base INSERT; this store only
*enriches* the row's ``metadata`` with CI context + the tri-state
breakdown the base columns never captured, and serves paginated history.

Kept separate from ``regression_runner.py`` on purpose: that module is
owned elsewhere, so we consume its ``RegressionRunResult`` shape and never
mutate its persistence path.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _skip_policy() -> str:
    try:
        from eden.config import get_settings

        policy = get_settings().regression_gate_skip_policy
    except Exception:
        return "allow"
    return policy if policy in ("allow", "block") else "allow"


def _row_ok(passed: int, failed: int, skipped: int, errors: int) -> bool:
    """Gate verdict mirroring RegressionRunResult.ok (fail closed)."""
    if failed > 0 or errors > 0:
        return False
    if skipped > 0 and _skip_policy() == "block":
        return False
    return True


class CIEvalHistoryStore:
    """Persistence-adjacent reads for the CI-eval surface."""

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only

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

    async def enrich(
        self,
        run_id: str,
        *,
        skipped: int,
        errors: int,
        cases: list[dict[str, Any]],
        ref: str | None = None,
        commit_sha: str | None = None,
        pr_number: int | None = None,
        changed_files: list[str] | None = None,
    ) -> None:
        """Fold the tri-state breakdown + CI context into metadata JSONB.

        No-op when the DB is unavailable (memory-only test runs); the base
        row, if any, was already written by the regression runner.
        """
        client = await self._client()
        if client is None:
            return
        metadata = {
            "skipped": skipped,
            "errors": errors,
            "cases": cases,
            "ref": ref,
            "commit_sha": commit_sha,
            "pr_number": pr_number,
            "changed_files": changed_files or [],
        }
        try:
            await client.execute(
                """
                UPDATE regression_eval_runs
                SET metadata = $2::jsonb
                WHERE id = $1::uuid
                """,
                run_id,
                json.dumps(metadata),
            )
        except Exception as exc:  # pragma: no cover - best-effort enrich
            logger.warning("ci-eval metadata enrich failed: %s", exc)

    @staticmethod
    def _shape_row(row: dict[str, Any], *, detail: bool) -> dict[str, Any]:
        meta = row.get("metadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        passed = int(row.get("passed") or 0)
        failed = int(row.get("failed") or 0)
        skipped = int(meta.get("skipped") or 0)
        errors = int(meta.get("errors") or 0)
        created = row.get("created_at")
        created_iso = created.isoformat() if hasattr(created, "isoformat") else created
        out: dict[str, Any] = {
            "id": str(row.get("id")),
            "org_id": row.get("org_id"),
            "agent_id": row.get("agent_id"),
            "change_id": row.get("change_id"),
            "ref": meta.get("ref"),
            "commit_sha": meta.get("commit_sha"),
            "pr_number": meta.get("pr_number"),
            "counts": {
                "passed": passed,
                "failed": failed,
                "skipped": skipped,
                "errors": errors,
                "total": passed + failed + skipped + errors,
            },
            "ok": _row_ok(passed, failed, skipped, errors),
            "status": row.get("status"),
            "created_at": created_iso,
        }
        if detail:
            failures = row.get("failures") or []
            if isinstance(failures, str):
                try:
                    failures = json.loads(failures)
                except Exception:
                    failures = []
            out["failures"] = failures
            out["cases"] = meta.get("cases") or []
            out["changed_files"] = meta.get("changed_files") or []
        return out

    async def list_runs(
        self, org_id: str, *, limit: int = 20, offset: int = 0
    ) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"runs": [], "limit": limit, "offset": offset, "total": 0}
        limit = max(1, min(int(limit), 100))
        offset = max(0, int(offset))
        rows = await client.fetch(
            """
            SELECT id, org_id, agent_id, change_id, passed, failed,
                   status, created_at, metadata
            FROM regression_eval_runs
            WHERE org_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            org_id,
            limit,
            offset,
        )
        total_row = await client.fetchrow(
            "SELECT COUNT(*) AS n FROM regression_eval_runs WHERE org_id = $1",
            org_id,
        )
        total = int((total_row or {}).get("n") or 0)
        runs = [self._shape_row(dict(r), detail=False) for r in rows]
        return {"runs": runs, "limit": limit, "offset": offset, "total": total}

    async def get_run(self, org_id: str, run_id: str) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT id, org_id, agent_id, change_id, passed, failed, failures,
                   status, created_at, metadata
            FROM regression_eval_runs
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            run_id,
        )
        if row is None:
            return None
        return self._shape_row(dict(row), detail=True)

    async def resolve_baseline(
        self,
        org_id: str,
        *,
        agent_id: str | None,
        explicit_id: str | None,
        exclude_id: str | None,
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Return (baseline_run, source).

        Prefers an explicit baseline id; otherwise the most recent prior run
        for the same org/agent. source is "explicit" | "previous_run" | None.
        """
        client = await self._client()
        if client is None:
            return None, None
        if explicit_id:
            row = await client.fetchrow(
                """
                SELECT id, org_id, agent_id, change_id, passed, failed,
                       status, created_at, metadata
                FROM regression_eval_runs
                WHERE org_id = $1 AND id = $2::uuid
                """,
                org_id,
                explicit_id,
            )
            if row is not None:
                return self._shape_row(dict(row), detail=False), "explicit"
        row = await client.fetchrow(
            """
            SELECT id, org_id, agent_id, change_id, passed, failed,
                   status, created_at, metadata
            FROM regression_eval_runs
            WHERE org_id = $1
              AND ($2::text IS NULL OR agent_id = $2)
              AND ($3::uuid IS NULL OR id <> $3::uuid)
            ORDER BY created_at DESC
            LIMIT 1
            """,
            org_id,
            agent_id,
            exclude_id,
        )
        if row is None:
            return None, None
        return self._shape_row(dict(row), detail=False), "previous_run"


__all__ = ["CIEvalHistoryStore"]
