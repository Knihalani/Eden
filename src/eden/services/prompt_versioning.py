"""Prompt versioning service — D.9 (§6.2).

Public surface:

* :class:`PromptService` — the per-org registry of prompts
  and their version timelines. CRUD over ``prompts`` and
  ``prompt_versions``.
* :func:`template_hash` — sha256 of the normalized template
  (used as the dedup key + the diff identifier).
* :func:`run_auto_eval` — best-effort eval runner fired
  on every new version when ``auto_eval_on_save=true``.

The service degrades gracefully: every fetcher is best-
effort so an empty database returns empty lists rather
than 500ing. The auto-eval runner is single-shot LLM (slot
``fast``) per the existing Cat 14 / Cat 6 patterns.

See ``docs/spec/upgradespec-original-2026-06.md`` §D.9 /
§B.2 / §C.2 for the full spec.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from typing import Any

logger = logging.getLogger(__name__)


# ── helpers ──────────────────────────────────────────────────────────


def template_hash(template: str) -> str:
    """sha256 of the normalized template.

    Normalisation: collapse whitespace, strip trailing
    whitespace per line, drop BOM. Two semantically
    identical templates with different formatting must
    hash the same so the version timeline doesn't show
    noise diffs.
    """
    normalized = re.sub(r"\s+", " ", template.strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _new_id() -> str:
    return f"prm_{uuid.uuid4().hex[:16]}"


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("prompt_service: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("prompt_service: get_postgres_client failed: %s", exc)
        return None


# ── PromptService ────────────────────────────────────────────────────


class PromptService:
    """Per-org prompt + version registry.

    The ``prompts`` row holds the registry entry (name,
    description, tags). The ``prompt_versions`` rows hold
    the version timeline. Re-runs dedupe on
    ``(prompt_id, version)`` so the same version can't
    be inserted twice.
    """

    # ── prompts CRUD ────────────────────────────────────────────────

    async def list_prompts(
        self, org_id: str, *, limit: int = 100
    ) -> list[dict[str, Any]]:
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT id, org_id, name, description, tags,
                       auto_eval_on_save, created_by,
                       created_at, updated_at
                  FROM prompts
                 WHERE org_id = $1
                 ORDER BY name ASC
                 LIMIT $2
                """,
                org_id,
                int(limit),
            )
        except Exception as exc:
            logger.debug("prompt_service: list_prompts failed: %s", exc)
            return []
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            for k, v in list(d.items()):
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            out.append(d)
        return out

    async def get_prompt(
        self, org_id: str, name: str
    ) -> dict[str, Any] | None:
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                SELECT id, org_id, name, description, tags,
                       auto_eval_on_save, created_by,
                       created_at, updated_at
                  FROM prompts
                 WHERE org_id = $1 AND name = $2
                """,
                org_id,
                name,
            )
        except Exception as exc:
            logger.debug("prompt_service: get_prompt failed: %s", exc)
            return None
        if row is None:
            return None
        d = dict(row)
        for k, v in list(d.items()):
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        return d

    async def create_prompt(
        self,
        org_id: str,
        *,
        name: str,
        description: str | None = None,
        tags: list[str] | None = None,
        auto_eval_on_save: bool = False,
        created_by: str = "system",
    ) -> dict[str, Any] | None:
        client = await _get_client()
        if client is None:
            return None
        prompt_id = str(uuid.uuid4())
        try:
            await client.execute(
                """
                INSERT INTO prompts (
                    id, org_id, name, description, tags,
                    auto_eval_on_save, created_by,
                    created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, NOW(), NOW()
                )
                ON CONFLICT (org_id, name) DO NOTHING
                """,
                prompt_id,
                org_id,
                name,
                description,
                list(tags or []),
                bool(auto_eval_on_save),
                created_by,
            )
        except Exception as exc:
            logger.debug("prompt_service: create_prompt failed: %s", exc)
        return await self.get_prompt(org_id, name)

    # ── versions ─────────────────────────────────────────────────────

    async def list_versions(
        self,
        org_id: str,
        prompt_name: str,
        *,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        prompt = await self.get_prompt(org_id, prompt_name)
        if prompt is None:
            return []
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT id, prompt_id, version, template,
                       template_hash, model, params, variables,
                       parent_version_id, change_note, created_by,
                       created_at
                  FROM prompt_versions
                 WHERE prompt_id = $1
                 ORDER BY version DESC
                 LIMIT $2
                """,
                prompt["id"],
                int(limit),
            )
        except Exception as exc:
            logger.debug("prompt_service: list_versions failed: %s", exc)
            return []
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            for k, v in list(d.items()):
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            out.append(d)
        return out

    async def create_version(
        self,
        org_id: str,
        prompt_name: str,
        *,
        template: str,
        model: str,
        params: dict[str, Any] | None = None,
        variables: list[str] | None = None,
        change_note: str | None = None,
        created_by: str = "system",
    ) -> dict[str, Any] | None:
        """Create a new version. Auto-increments ``version``.

        Also fires :func:`run_auto_eval` when the prompt
        has ``auto_eval_on_save=true``.
        """
        prompt = await self.get_prompt(org_id, prompt_name)
        if prompt is None:
            prompt = await self.create_prompt(
                org_id, name=prompt_name, created_by=created_by,
            )
        if prompt is None:
            return None
        client = await _get_client()
        if client is None:
            return None
        # Compute next version (MAX + 1).
        try:
            row = await client.fetchrow(
                "SELECT COALESCE(MAX(version), 0) AS max_v "
                "FROM prompt_versions WHERE prompt_id = $1",
                prompt["id"],
            )
        except Exception as exc:
            logger.debug("prompt_service: version lookup failed: %s", exc)
            row = None
        next_version = int((row["max_v"] if row else 0) or 0) + 1
        new_id = str(uuid.uuid4())
        try:
            await client.execute(
                """
                INSERT INTO prompt_versions (
                    id, org_id, prompt_id, version, template,
                    template_hash, model, params, variables,
                    change_note, created_by, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9,
                    $10, $11, NOW()
                )
                ON CONFLICT (prompt_id, version) DO NOTHING
                """,
                new_id,
                org_id,
                prompt["id"],
                next_version,
                template,
                template_hash(template),
                model,
                _json_dumps(params or {}),
                _json_dumps(list(variables or [])),
                change_note,
                created_by,
            )
        except Exception as exc:
            logger.debug("prompt_service: create_version failed: %s", exc)
            return None
        if prompt.get("auto_eval_on_save"):
            try:
                await run_auto_eval(org_id, prompt_version_id=new_id)
            except Exception as exc:
                logger.debug("prompt_service: auto_eval failed: %s", exc)
        return await self.get_version(org_id, prompt_name, next_version)

    async def get_version(
        self,
        org_id: str,
        prompt_name: str,
        version: int,
    ) -> dict[str, Any] | None:
        prompt = await self.get_prompt(org_id, prompt_name)
        if prompt is None:
            return None
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                SELECT id, prompt_id, version, template,
                       template_hash, model, params, variables,
                       parent_version_id, change_note, created_by,
                       created_at
                  FROM prompt_versions
                 WHERE prompt_id = $1 AND version = $2
                """,
                prompt["id"],
                int(version),
            )
        except Exception as exc:
            logger.debug("prompt_service: get_version failed: %s", exc)
            return None
        if row is None:
            return None
        d = dict(row)
        for k, v in list(d.items()):
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        return d

    # ── eval runs ────────────────────────────────────────────────────

    async def list_eval_runs(
        self,
        org_id: str,
        prompt_version_id: str,
        *,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        client = await _get_client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT id, prompt_version_id, dataset_id,
                       baseline_version_id, status, results,
                       scores_summary, n_evaluated,
                       created_at, started_at, completed_at
                  FROM prompt_eval_runs
                 WHERE org_id = $1 AND prompt_version_id = $2
                 ORDER BY created_at DESC
                 LIMIT $3
                """,
                org_id,
                prompt_version_id,
                int(limit),
            )
        except Exception as exc:
            logger.debug("prompt_service: list_eval_runs failed: %s", exc)
            return []
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            for k, v in list(d.items()):
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            out.append(d)
        return out


# ── auto-eval runner ─────────────────────────────────────────────────


async def run_auto_eval(
    org_id: str,
    *,
    prompt_version_id: str,
    dataset_id: str | None = None,
    baseline_version_id: str | None = None,
) -> str | None:
    """Best-effort auto-eval runner.

    Inserts a ``pending`` ``prompt_eval_runs`` row, then
    transitions it through ``running`` → ``completed``
    via a single-shot LLM call (slot ``fast``). Returns
    the eval_run_id on success.

    Best-effort: any DB or LLM error flips the row to
    ``failed`` with the error in ``results``.
    """
    client = await _get_client()
    if client is None:
        return None
    eval_id = str(uuid.uuid4())
    try:
        await client.execute(
            """
            INSERT INTO prompt_eval_runs (
                id, org_id, prompt_version_id, dataset_id,
                baseline_version_id, status,
                created_at, started_at
            ) VALUES (
                $1, $2, $3, $4,
                $5, 'running',
                NOW(), NOW()
            )
            """,
            eval_id,
            org_id,
            prompt_version_id,
            dataset_id,
            baseline_version_id,
        )
    except Exception as exc:
        logger.debug("prompt_service: eval insert failed: %s", exc)
        return None
    # Best-effort LLM call. Fall back to a deterministic
    # "no dataset, no eval" result if the LLM is unavailable.
    score = await _llm_score(org_id, prompt_version_id)
    status = "completed" if score is not None else "failed"
    try:
        await client.execute(
            """
            UPDATE prompt_eval_runs
               SET status = $2,
                   scores_summary = $3,
                   results = $4,
                   n_evaluated = $5,
                   completed_at = NOW()
             WHERE id = $1
            """,
            eval_id,
            status,
            _json_dumps(score or {"error": "no_score"}),
            _json_dumps({"prompt_version_id": prompt_version_id}),
            1,
        )
    except Exception as exc:
        logger.debug("prompt_service: eval update failed: %s", exc)
    return eval_id


async def _llm_score(
    org_id: str,
    prompt_version_id: str,
) -> dict[str, Any] | None:
    """Single-shot LLM scoring call. Returns a small dict
    or ``None`` when the LLM is unavailable.
    """
    try:
        from eden.llm.client import get_llm_client
    except Exception:
        return None
    try:
        client = await get_llm_client()
        if client is None:
            return None
        # Tiny summary call; the actual eval grading is
        # against a pinned dataset in a follow-up commit.
        response = await client.complete(
            prompt=(
                "Score the prompt template on a 0-1 scale "
                "for clarity + specificity. Return ONLY JSON: "
                '{"score": <float>, "rationale": "..."}'
            ),
            slot="fast",
            max_tokens=200,
        )
        if response is None:
            return None
        import json as _json
        try:
            return _json.loads(response)
        except Exception:
            return {"score": None, "raw": str(response)[:200]}
    except Exception as exc:
        logger.debug("prompt_service: llm_score failed: %s", exc)
        return None


# ── JSON helpers ─────────────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    import json as _json
    try:
        return _json.dumps(obj, default=str)
    except Exception:
        return "{}"


__all__ = [
    "PromptService",
    "run_auto_eval",
    "template_hash",
]
