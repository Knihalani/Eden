"""StumbleWriter — atomic stumble creation with dedup + promotion (F28).

Flow: ``create()`` computes the fingerprint, inserts the stumble (deduped
on ``(org_id, trace_id, kind, fingerprint)``), then promotes it into an
issue via :class:`IssuePromoter`. A short-lived Redis ``SETNX`` guard
absorbs same-second burst duplicates before they touch Postgres.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from eden.issues.fingerprint import compute_fingerprint, error_signature_for
from eden.issues.issue_promoter import IssuePromoter
from eden.issues.metrics import record_stumble_write
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
        the (created or updated) :class:`Issue` or ``None``.

        Promotion (and the ``on_stumble_created`` / ``on_issue_created``
        hooks) only fire on a **real insert**. A same-second burst
        duplicate or an ``ON CONFLICT`` dedup returns early *without*
        bumping the issue's ``stumble_count`` — a re-scan of the same
        ``(trace_id, kind, fingerprint)`` is idempotent.
        """
        started = time.perf_counter()
        fingerprint = compute_fingerprint(
            sc.kind,
            sc.agent_id,
            error_signature_for(sc.kind, sc.detail),
            trace_id=sc.trace_id,
        )

        # Same-second burst guard: absorb duplicates before they touch
        # Postgres. A burst hit is a dedup — skip the write + promotion.
        if await self._burst_seen(sc, fingerprint):
            logger.debug(
                "stumble_writer: burst-deduped %s/%s", sc.trace_id, sc.kind
            )
            record_stumble_write(
                time.perf_counter() - started, created=False, deduped=True
            )
            return {
                "stumble_id": None,
                "fingerprint": fingerprint,
                "inserted": False,
                "deduped": "burst",
                "issue": None,
            }

        stumble_id, inserted = await self._repo.insert_stumble(sc, fingerprint)

        # No new row (write failed OR ON CONFLICT dedup): never promote.
        if stumble_id is None or not inserted:
            record_stumble_write(
                time.perf_counter() - started,
                created=False,
                deduped=stumble_id is not None,
            )
            return {
                "stumble_id": stumble_id,
                "fingerprint": fingerprint,
                "inserted": bool(inserted),
                "deduped": stumble_id is not None,
                "issue": None,
            }

        # Real insert → fire the stumble hook (F30/F47) + promote.
        await self._fire_stumble_created(sc, fingerprint, stumble_id)
        issue: Issue | None = await self._promoter.upsert(
            sc, fingerprint, stumble_id
        )
        record_stumble_write(
            time.perf_counter() - started, created=True, deduped=False
        )
        return {
            "stumble_id": stumble_id,
            "fingerprint": fingerprint,
            "inserted": inserted,
            "issue": issue,
        }

    async def _fire_stumble_created(
        self, sc: StumbleCreate, fingerprint: str, stumble_id: str
    ) -> None:
        """Best-effort ``on_stumble_created`` hook — never breaks the write."""
        try:
            from eden.llmops.promotion_hooks import get_stumble_hook

            await get_stumble_hook().on_stumble_created(
                sc.org_id,
                stumble_id=stumble_id,
                trace_id=sc.trace_id,
                kind=sc.kind,
                fingerprint=fingerprint,
                severity=sc.resolved_severity(),
                agent_id=sc.agent_id,
            )
        except Exception as exc:  # pragma: no cover - hook optional
            logger.debug("stumble_writer: on_stumble_created failed: %s", exc)

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
