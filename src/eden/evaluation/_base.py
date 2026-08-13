"""Canonical eval-runner base — single DB-client contract for both runner surfaces.

Both :class:`~eden.evaluation.regression_runner.RegressionRunner` (the
regression/canary gate surface) and
:class:`~eden.experiments.offline_runner.OfflineExperimentRunner` (the offline
A/B experiment surface) share the same DB-client plumbing: optional injection of
a pre-built *asyncpg* client, lazy acquisition from the global pool, and a
``memory_only`` escape hatch that forces ``_client()`` to return ``None`` so unit
tests never need a real Postgres connection.

This module is the authoritative definition of that contract; the two runner
surfaces inherit it and add their own domain logic.
"""

from __future__ import annotations

from typing import Any


class _BaseEvalRunner:
    """Shared DB-client plumbing for evaluation and experiment runner surfaces.

    Parameters
    ----------
    pg:
        Pre-built asyncpg client or pool.  When provided it is used directly,
        skipping global-pool acquisition.
    memory_only:
        When ``True``, ``_client()`` always returns ``None``.  Use this in
        unit tests to guarantee no Postgres connection is attempted.
    """

    def __init__(
        self,
        pg: Any | None = None,
        *,
        memory_only: bool = False,
    ) -> None:
        self._pg = pg
        self._memory_only = memory_only

    async def _client(self) -> Any | None:
        """Return an asyncpg client or ``None`` when unavailable.

        Resolution order:
        1. Return ``None`` immediately if ``memory_only`` is set.
        2. Return the injected ``pg`` client when present.
        3. Acquire from the global pool; return ``None`` on any error.
        """
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None


__all__ = ["_BaseEvalRunner"]
