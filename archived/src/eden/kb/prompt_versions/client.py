"""Prompt versions client for Eden's Knowledge Base.

Manages prompt versioning, A/B testing, and promotion for the Evolution Engine.

V2 compat shim (Wave 2, 2026-08-11)
-----------------------------------
Migration 055 (``055_prompt_versioning.py``, in the live alembic chain)
**dropped** the legacy agent-keyed ``prompt_versions`` table
(``agent``/``system_prompt``/``few_shot_examples``/``quality_metrics``/
``active``/``promoted_at``) and replaced it with the org-scoped v2
schema:

    prompts (id, org_id, name, ...)
    prompt_versions (id, org_id, prompt_id, version, template,
                     template_hash, model, params, variables, ...)

Every method below previously targeted columns that no longer exist and
would raise ``UndefinedColumnError`` at runtime. This module is now a
**compat shim**: it keeps the legacy agent-keyed interface (callers in
``seed.py``, ``agents/base.py``, ``agents/evolution/`` and the
``prompt_canary`` route are unchanged) but maps onto the live v2 tables:

* ``agent`` → a v2 ``prompts`` row named after the agent, stored under
  the well-known **system org** (``SYSTEM_ORG_ID``). The legacy store
  was org-agnostic (seeded globally, read by global agents), so a
  sentinel org keeps that semantics without polluting any tenant's
  prompt list.
* ``system_prompt`` → ``prompt_versions.template``
* ``version`` → ``prompt_versions.version`` (explicit, as before)
* ``few_shot_examples`` / ``quality_metrics`` / ``active`` /
  ``promoted_at`` → kept inside ``prompt_versions.params`` jsonb so the
  row shape returned by :meth:`_row_to_prompt` is unchanged.
"""

import json
import logging
from datetime import UTC, datetime
from uuid import uuid4

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

#: Well-known org id for the global agent-prompt store (v2 schema).
#: The legacy ``prompt_versions`` table was org-agnostic; a sentinel org
#: keeps agent prompts out of every tenant's org-scoped prompt list
#: while giving the v2 schema the required ``org_id``.
SYSTEM_ORG_ID = "__eden_system__"

_MODEL = "eden-legacy"
_CREATED_BY = "eden-legacy"


def _iso(v: object) -> str | None:
    if v is None:
        return None
    fmt = getattr(v, "isoformat", None)
    if callable(fmt):
        return str(fmt())
    return str(v)


class PromptVersionsClient:
    """Client for prompt version operations (v2-schema compat shim).

    Manages the v2 ``prompts`` + ``prompt_versions`` tables behind the
    legacy agent-keyed interface used by the evolution engine.
    """

    # ── internal helpers ─────────────────────────────────────────────

    async def _resolve_prompt_id(self, agent: str) -> str | None:
        """Return the v2 ``prompts.id`` for an agent, or None."""
        client = await get_postgres_client()
        try:
            row = await client.fetchrow(
                "SELECT id FROM prompts WHERE org_id = $1 AND name = $2",
                SYSTEM_ORG_ID,
                agent,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: resolve prompt failed: %s", exc)
            return None
        if not row:
            return None
        row_id: object = row.get("id")
        return str(row_id) if row_id is not None else None

    async def _ensure_prompt(self, agent: str) -> str | None:
        """Upsert the agent's ``prompts`` row; return its id.

        Race-safe: the INSERT uses ``ON CONFLICT (org_id, name) DO NOTHING
        RETURNING id`` so a concurrent writer winning the race yields the
        existing row's id instead of a phantom UUID (a phantom would
        violate ``prompt_versions.prompt_id`` FK on the follow-up insert).
        """
        client = await get_postgres_client()
        try:
            row = await client.fetchrow(
                "SELECT id FROM prompts WHERE org_id = $1 AND name = $2",
                SYSTEM_ORG_ID,
                agent,
            )
            if row:
                return str(row["id"])
            # ON CONFLICT DO NOTHING RETURNING id — when a concurrent
            # writer wins, RETURNING emits the existing row; when we win,
            # it emits ours. Either way the returned id is real.
            inserted = await client.fetchrow(
                """
                INSERT INTO prompts (
                    id, org_id, name, description, tags,
                    auto_eval_on_save, created_by, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, NULL, ARRAY[]::TEXT[],
                    FALSE, $4, NOW(), NOW()
                )
                ON CONFLICT (org_id, name) DO NOTHING
                RETURNING id
                """,
                str(uuid4()),
                SYSTEM_ORG_ID,
                agent,
                _CREATED_BY,
            )
            if inserted:
                return str(inserted["id"])
            # Lost the race (or a concurrent commit landed between SELECT
            # and INSERT) — re-read the existing row.
            row = await client.fetchrow(
                "SELECT id FROM prompts WHERE org_id = $1 AND name = $2",
                SYSTEM_ORG_ID,
                agent,
            )
            return str(row["id"]) if row else None
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("prompt_versions shim: ensure prompt failed: %s", exc)
            return None

    def _legacy_params(
        self,
        *,
        few_shot_examples: list | None,
        quality_metrics: dict | None,
        active: bool,
        promoted_at: str | None = None,
    ) -> str:
        """Pack legacy fields into the v2 ``params`` jsonb."""
        return json.dumps(
            {
                "legacy": True,
                "active": bool(active),
                "few_shot_examples": list(few_shot_examples or []),
                "quality_metrics": dict(quality_metrics or {}),
                "promoted_at": promoted_at,
            }
        )

    # ── public API (legacy signatures preserved) ─────────────────────

    async def insert_version(
        self,
        agent: str,
        system_prompt: str,
        version: int,
        few_shot_examples: list[dict] | None = None,
        quality_metrics: dict | None = None,
        active: bool = False,
    ) -> bool:
        """Insert (or upsert) a prompt version for an agent.

        Maps onto the v2 schema: ensures the ``prompts`` row named after
        the agent (system org) and inserts/updates the ``prompt_versions``
        row at the explicit ``version``.
        """
        client = await get_postgres_client()
        prompt_id = await self._ensure_prompt(agent)
        if prompt_id is None:
            return False
        import hashlib

        template_hash = hashlib.sha256(
            " ".join(system_prompt.strip().split()).encode("utf-8")
        ).hexdigest()
        params = self._legacy_params(
            few_shot_examples=few_shot_examples,
            quality_metrics=quality_metrics,
            active=active,
            promoted_at=(
                datetime.now(UTC).isoformat() if active else None
            ),
        )
        try:
            await client.execute(
                """
                INSERT INTO prompt_versions (
                    id, org_id, prompt_id, version, template,
                    template_hash, model, params, variables,
                    change_note, created_by, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8::jsonb, '[]'::jsonb,
                    $9, $10, NOW()
                )
                ON CONFLICT (prompt_id, version) DO UPDATE SET
                    template = EXCLUDED.template,
                    template_hash = EXCLUDED.template_hash,
                    params = EXCLUDED.params
                """,
                str(uuid4()),
                SYSTEM_ORG_ID,
                prompt_id,
                int(version),
                system_prompt,
                template_hash,
                _MODEL,
                params,
                f"legacy-insert:{agent}:v{version}",
                _CREATED_BY,
            )
            return True
        except Exception as e:
            logger.error(f"Failed to insert prompt version: {e}")
            return False

    async def get_active_prompt(self, agent: str) -> dict | None:
        """Get the currently active prompt version for an agent.

        Maps to: the version flagged ``params->>'active' = 'true'`` for
        the agent's v2 prompt; falls back to the latest version when no
        version is explicitly flagged (matches legacy behavior where a
        single-version seed is implicitly active).
        """
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return None
        try:
            row = await client.fetchrow(
                """
                SELECT pv.id, pv.version, pv.template, pv.params,
                       pv.created_at, p.name AS agent
                  FROM prompt_versions pv
                  JOIN prompts p ON p.id = pv.prompt_id
                 WHERE pv.prompt_id = $1
                   AND pv.params->>'active' = 'true'
                 ORDER BY pv.version DESC
                 LIMIT 1
                """,
                prompt_id,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: active lookup failed: %s", exc)
            return None
        if row is None:
            # No explicitly-flagged active version → latest wins.
            try:
                row = await client.fetchrow(
                    """
                    SELECT pv.id, pv.version, pv.template, pv.params,
                           pv.created_at, p.name AS agent
                      FROM prompt_versions pv
                      JOIN prompts p ON p.id = pv.prompt_id
                     WHERE pv.prompt_id = $1
                     ORDER BY pv.version DESC
                     LIMIT 1
                    """,
                    prompt_id,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("prompt_versions shim: latest lookup failed: %s", exc)
                return None
        if not row:
            return None
        return self._row_to_prompt(dict(row))

    async def get_prompt_history(
        self,
        agent: str,
        limit: int = 10,
        include_inactive: bool = True,
    ) -> list[dict]:
        """Get prompt version history for an agent, newest first.

        ``include_inactive=False`` filters to the active version only
        (previously a dead parameter — Wave 2 honors it).
        """
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return []
        try:
            if include_inactive:
                rows = await client.fetch(
                    """
                    SELECT pv.id, pv.version, pv.template, pv.params,
                           pv.created_at, p.name AS agent
                      FROM prompt_versions pv
                      JOIN prompts p ON p.id = pv.prompt_id
                     WHERE pv.prompt_id = $1
                     ORDER BY pv.version DESC
                     LIMIT $2
                    """,
                    prompt_id,
                    int(limit),
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT pv.id, pv.version, pv.template, pv.params,
                           pv.created_at, p.name AS agent
                      FROM prompt_versions pv
                      JOIN prompts p ON p.id = pv.prompt_id
                     WHERE pv.prompt_id = $1
                       AND pv.params->>'active' = 'true'
                     ORDER BY pv.version DESC
                     LIMIT $2
                    """,
                    prompt_id,
                    int(limit),
                )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: history failed: %s", exc)
            return []
        return [self._row_to_prompt(dict(r)) for r in rows]

    async def get_latest_version(self, agent: str) -> int:
        """Get the latest version number for an agent (0 if none)."""
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return 0
        try:
            result = await client.fetchval(
                "SELECT MAX(version) FROM prompt_versions WHERE prompt_id = $1",
                prompt_id,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: latest version failed: %s", exc)
            return 0
        return int(result or 0)

    async def deactivate_prompt(self, agent: str, version: int) -> bool:
        """Deactivate a specific prompt version (v2: params flag)."""
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return False
        try:
            await client.execute(
                """
                UPDATE prompt_versions
                   SET params = jsonb_set(params, '{active}', 'false'::jsonb)
                 WHERE prompt_id = $1 AND version = $2
                """,
                prompt_id,
                int(version),
            )
            return True
        except Exception as e:
            logger.error(f"Failed to deactivate prompt: {e}")
            return False

    async def activate_prompt(self, agent: str, version: int) -> bool:
        """Activate a specific prompt version (deactivates all others).

        v2 has no ``active`` column — the flag lives in ``params`` jsonb,
        mirroring how PromotionLoop marks canary assignments terminal.
        """
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return False
        try:
            async with client.transaction():
                await client.execute(
                    """
                    UPDATE prompt_versions
                       SET params = jsonb_set(params, '{active}', 'false'::jsonb)
                     WHERE prompt_id = $1
                    """,
                    prompt_id,
                )
                await client.execute(
                    """
                    UPDATE prompt_versions
                       SET params = jsonb_set(
                               jsonb_set(params, '{active}', 'true'::jsonb),
                               '{promoted_at}', to_jsonb(NOW()::text)
                           )
                     WHERE prompt_id = $1 AND version = $2
                    """,
                    prompt_id,
                    int(version),
                )
            return True
        except Exception as e:
            logger.error(f"Failed to activate prompt: {e}")
            return False

    async def update_quality_metrics(
        self,
        agent: str,
        version: int,
        metrics: dict,
    ) -> bool:
        """Merge quality metrics into the version's ``params`` jsonb."""
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return False
        try:
            await client.execute(
                """
                UPDATE prompt_versions
                   SET params = jsonb_set(
                           params,
                           '{quality_metrics}',
                           COALESCE(params->'quality_metrics', '{}'::jsonb) || $3::jsonb
                       )
                 WHERE prompt_id = $1 AND version = $2
                """,
                prompt_id,
                int(version),
                json.dumps(metrics),
            )
            return True
        except Exception as e:
            logger.error(f"Failed to update quality metrics: {e}")
            return False

    async def increment_metric(
        self,
        agent: str,
        version: int,
        metric_path: str,
        delta: float = 1.0,
    ) -> bool:
        """Increment a numeric quality metric (dot notation)."""
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return False
        try:
            row = await client.fetchrow(
                """
                SELECT params->'quality_metrics' AS qm
                  FROM prompt_versions
                 WHERE prompt_id = $1 AND version = $2
                """,
                prompt_id,
                int(version),
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: metric read failed: %s", exc)
            return False
        if not row:
            return False
        try:
            metrics = json.loads(row["qm"]) if isinstance(row["qm"], str) else dict(row["qm"] or {})
        except (TypeError, ValueError):
            metrics = {}
        parts = metric_path.split(".")
        current: dict = metrics
        for part in parts[:-1]:
            if part not in current or not isinstance(current[part], dict):
                current[part] = {}
            current = current[part]
        last = parts[-1]
        try:
            current[last] = float(current.get(last, 0.0)) + delta
        except (TypeError, ValueError):
            current[last] = delta
        try:
            await client.execute(
                """
                UPDATE prompt_versions
                   SET params = jsonb_set(
                           params,
                           '{quality_metrics}',
                           $3::jsonb
                       )
                 WHERE prompt_id = $1 AND version = $2
                """,
                prompt_id,
                int(version),
                json.dumps(metrics),
            )
            return True
        except Exception as e:
            logger.error(f"Failed to increment metric: {e}")
            return False

    async def get_candidates_for_ab_test(
        self,
        agent: str,
        limit: int = 3,
    ) -> list[dict]:
        """Get inactive versions with ``ab_test_active`` (v2 params jsonb)."""
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT pv.id, pv.version, pv.template, pv.params,
                       pv.created_at, p.name AS agent
                  FROM prompt_versions pv
                  JOIN prompts p ON p.id = pv.prompt_id
                 WHERE pv.prompt_id = $1
                   AND COALESCE(pv.params->'quality_metrics'->>'ab_test_active', 'false') = 'true'
                   AND COALESCE(pv.params->>'active', 'false') = 'false'
                 ORDER BY pv.version DESC
                 LIMIT $2
                """,
                prompt_id,
                int(limit),
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: ab candidates failed: %s", exc)
            return []
        return [self._row_to_prompt(dict(r)) for r in rows]

    async def get_prompts_for_agent(
        self,
        agent: str,
        version: int | None = None,
    ) -> dict | None:
        """Get a specific prompt version or the active one."""
        if version is None:
            return await self.get_active_prompt(agent)
        client = await get_postgres_client()
        prompt_id = await self._resolve_prompt_id(agent)
        if prompt_id is None:
            return None
        try:
            row = await client.fetchrow(
                """
                SELECT pv.id, pv.version, pv.template, pv.params,
                       pv.created_at, p.name AS agent
                  FROM prompt_versions pv
                  JOIN prompts p ON p.id = pv.prompt_id
                 WHERE pv.prompt_id = $1 AND pv.version = $2
                """,
                prompt_id,
                int(version),
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("prompt_versions shim: get version failed: %s", exc)
            return None
        return self._row_to_prompt(dict(row)) if row else None

    def _row_to_prompt(self, row: dict) -> dict:
        """Convert a v2 row to the legacy prompt-version dict shape."""
        params = row.get("params")
        if isinstance(params, str):
            try:
                params = json.loads(params)
            except (TypeError, ValueError):
                params = {}
        params = params or {}
        qm = params.get("quality_metrics") or {}
        return {
            "id": str(row["id"]),
            # The v2 query aliases ``p.name AS agent``; accept the raw
            # ``name`` key too (fake/recording clients that skip aliasing).
            "agent": row.get("agent") or row.get("name") or "",
            "version": int(row.get("version") or 0),
            "system_prompt": row.get("template") or "",
            "few_shot_examples": params.get("few_shot_examples") or [],
            "quality_metrics": qm,
            "active": bool(params.get("active", False)),
            "created_at": _iso(row.get("created_at")),
            "promoted_at": params.get("promoted_at"),
        }


# Singleton
_prompt_versions_client: PromptVersionsClient | None = None


def get_prompt_versions_client() -> PromptVersionsClient:
    """Get the singleton prompt versions client."""
    global _prompt_versions_client
    if _prompt_versions_client is None:
        _prompt_versions_client = PromptVersionsClient()
    return _prompt_versions_client
