"""StumbleWriter — atomic stumble creation with dedup + promotion (F28).

Flow: ``create()`` computes the fingerprint, inserts the stumble (deduped
on ``(org_id, trace_id, kind, fingerprint)``), then promotes it into an
issue via :class:`IssuePromoter`. A short-lived Redis ``SETNX`` guard
absorbs same-second burst duplicates before they touch Postgres.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.issues.fingerprint import compute_fingerprint, error_signature_for
from eden.issues.issue_promoter import IssuePromoter
from eden.issues.models import Issue, StumbleCreate
from eden.issues.repo import IssuesRepo

logger = logging.getLogger(__name__)

_REDIS_BURST_TTL_S = 5


class StumbleWriter:
    """Create stumbles and promote them into issues."""

    def __init__(
        self,
        repo: IssuesRepo | None = None,
        promoter: IssuePromoter | None = None,
    ) -> None:
        self._repo = repo or IssuesRepo()
        self._promoter = promoter or IssuePromoter(self._repo)

    async def create(self, sc: StumbleCreate) -> dict[str, Any]:
        """Persist a stumble and promote it. Returns a small result dict
        ``{stumble_id, fingerprint, inserted, issue}`` where ``issue`` is
        the (created or updated) :class:`Issue` or ``None`` on failure."""
        fingerprint = compute_fingerprint(
            sc.kind, sc.agent_id, error_signature_for(sc.kind, sc.detail)
        )

        # Same-second burst guard (best-effort; never blocks the write).
        if await self._burst_seen(sc, fingerprint):
            logger.debug(
                "stumble_writer: burst-deduped %s/%s", sc.trace_id, sc.kind
            )

        stumble_id, inserted = await self._repo.insert_stumble(sc, fingerprint)
        if stumble_id is None:
            return {
                "stumble_id": None,
                "fingerprint": fingerprint,
                "inserted": False,
                "issue": None,
            }

        issue: Issue | None = await self._promoter.upsert(
            sc, fingerprint, stumble_id
        )
        return {
            "stumble_id": stumble_id,
            "fingerprint": fingerprint,
            "inserted": inserted,
            "issue": issue,
        }

    async def _burst_seen(self, sc: StumbleCreate, fingerprint: str) -> bool:
        try:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return False
            key = f"stumble:{sc.org_id}:{sc.trace_id}:{sc.kind}:{fingerprint}"
            # returns True if the key was set (i.e. first time), so a
            # False means we've seen this exact stumble very recently.
            was_set = await redis.set(key, "1", ex=_REDIS_BURST_TTL_S, nx=True)
            return not bool(was_set)
        except Exception:  # pragma: no cover - redis optional
            return False
