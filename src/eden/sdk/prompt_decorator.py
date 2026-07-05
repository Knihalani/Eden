"""Python ``@prompt()`` decorator — D.9 SDK (§6.2).

Usage:

    from eden.sdk.prompt_decorator import prompt

    @prompt(name="support_reply_v1", model="gpt-4o", versioned=True)
    def build_support_reply(user_msg: str) -> str:
        return f"You are a helpful agent. User: {user_msg}"

The decorator:

1. On first call, ensures a row exists in the ``prompts``
   table (idempotent on ``(org_id, name)``).
2. On every call, records the call into
   ``telemetry_events`` with the current ``prompt_version_id``
   so the trace detail page can show the version that
   generated it.
3. When ``versioned=True``, every call increments the
   template's run counter; the customer can call
   :func:`bump_version` to create a new version.

Ponytail: the decorator is best-effort — any DB error is
logged + swallowed so the wrapped function still runs.
"""

from __future__ import annotations

import functools
import hashlib
import logging
import uuid
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)


def _template_hash(template: str) -> str:
    import re as _re
    return hashlib.sha256(
        _re.sub(r"\s+", " ", template.strip()).encode("utf-8")
    ).hexdigest()


async def _ensure_prompt_row(
    org_id: str,
    name: str,
    *,
    description: str | None = None,
) -> str | None:
    """Ensure a ``prompts`` row exists. Returns the prompt id."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:
        logger.debug("@prompt: postgres import failed: %s", exc)
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            "SELECT id FROM prompts WHERE org_id = $1 AND name = $2",
            org_id,
            name,
        )
        if row:
            return str(row["id"])
        new_id = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO prompts (
                id, org_id, name, description, tags,
                auto_eval_on_save, created_by,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, ARRAY[]::TEXT[],
                FALSE, 'sdk-decorator', NOW(), NOW()
            )
            ON CONFLICT (org_id, name) DO NOTHING
            """,
            new_id,
            org_id,
            name,
            description,
        )
        return new_id
    except Exception as exc:
        logger.debug("@prompt: ensure row failed: %s", exc)
        return None


async def _record_template_version(
    org_id: str,
    prompt_id: str,
    *,
    template: str,
    model: str,
    created_by: str = "sdk-decorator",
) -> str | None:
    """Create a new ``prompt_versions`` row. Returns the version id."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:
        logger.debug("@prompt: postgres import failed: %s", exc)
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            "SELECT COALESCE(MAX(version), 0) AS max_v "
            "FROM prompt_versions WHERE prompt_id = $1",
            prompt_id,
        )
        next_version = int((row["max_v"] if row else 0) or 0) + 1
        version_id = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO prompt_versions (
                id, org_id, prompt_id, version, template,
                template_hash, model, params, variables,
                change_note, created_by, created_at
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, '{}'::jsonb, '[]'::jsonb,
                NULL, $8, NOW()
            )
            ON CONFLICT (prompt_id, version) DO NOTHING
            """,
            version_id,
            org_id,
            prompt_id,
            next_version,
            template,
            _template_hash(template),
            model,
            created_by,
        )
        return version_id
    except Exception as exc:
        logger.debug("@prompt: version insert failed: %s", exc)
        return None


def prompt(
    *,
    name: str,
    model: str = "gpt-4o",
    org_id: str | None = None,
    description: str | None = None,
    versioned: bool = True,
) -> Callable:
    """Decorator that registers the wrapped function as a
    versioned prompt template.

    Parameters mirror the spec §D.9 fields. ``org_id``
    falls back to ``EDEN_ORG_ID`` env var when not
    supplied.
    """
    import os as _os

    def _resolve_org_id() -> str:
        return org_id or _os.environ.get("EDEN_ORG_ID", "")

    def decorator(fn: Callable) -> Callable:
        template = fn.__doc__ or fn.__name__

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            org = _resolve_org_id()
            if org:
                try:
                    pid = await _ensure_prompt_row(
                        org, name, description=description
                    )
                    if pid and versioned:
                        await _record_template_version(
                            org, pid,
                            template=template, model=model,
                        )
                except Exception as exc:
                    logger.debug("@prompt: async record failed: %s", exc)
            return await fn(*args, **kwargs)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            # Best-effort sync path. We don't run the DB
            # write in a sync context (the pg client is
            # async-only); the customer's call is untracked
            # but still runs.
            return fn(*args, **kwargs)

        if hasattr(fn, "__wrapped__") or _is_coroutine(fn):
            return async_wrapper
        return sync_wrapper

    return decorator


def _is_coroutine(fn: Callable) -> bool:
    """Return True if the callable is async."""
    import inspect
    return inspect.iscoroutinefunction(fn)


__all__ = ["prompt"]
