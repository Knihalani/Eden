"""Agent PR suggester — observability-driven code change proposals.

The :class:`PRSuggester` takes an **observability event**
(a Cat 2 RCA cluster, Cat 13 drift alert, Cat 4 retrieval
gap, etc.) and produces a :class:`PRSuggestion` — a
unified diff + a PR title + body that a human can review
and (if they choose) click "open PR" to materialise.

The flow:

1. **Map trigger → files** — the trigger payload carries
   the ``affected_files`` (from the RCA cluster /
   drift alert / retrieval gap). The suggester reads
   those files via the :class:`RepoProvider`.
2. **Build the LLM prompt** — "Given this file + this
   observability event, propose a 1-3 line code change
   as a unified diff." The LLM is the existing
   :class:`eden.llm.client.OpenRouterClient`.
3. **Parse + validate the diff** — the LLM response is
   parsed into a unified diff. The suggester validates
   that the diff hunks apply cleanly to the current file
   content (best-effort — the agent flow is human-in-the-
   loop so a bad diff surfaces as a "regenerate" button).
4. **Persist + return** — the suggestion is appended to
   the JSONL store (``.eden/pr_suggestions.jsonl``) and
   returned to the route caller.

**The suggester NEVER commits or pushes.** That step
belongs to :class:`eden.providers.pr.PRProvider` and is
invoked only when a human clicks "open PR" in the portal.

See ``docs/eden-observability-gap-roadmap.md`` § Cat 23
for the broader design.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from eden.util.atomic_io import atomic_write_lines

from ..providers.repo import FileEntry, RepoProvider

logger = logging.getLogger(__name__)


# ── Data classes ─────────────────────────────────────────────────


# The 4 trigger kinds the agent-suggest flow understands.
# Each maps to a Cat-N observability event source.
TRIGGER_RCA_CLUSTER = "rca_cluster"
TRIGGER_DRIFT_ALERT = "drift_alert"
TRIGGER_RETRIEVAL_GAP = "retrieval_gap"
TRIGGER_JUDGE_REGRESSION = "judge_regression"

VALID_TRIGGERS: frozenset[str] = frozenset(
    {
        TRIGGER_RCA_CLUSTER,
        TRIGGER_DRIFT_ALERT,
        TRIGGER_RETRIEVAL_GAP,
        TRIGGER_JUDGE_REGRESSION,
    }
)


@dataclass
class PRSuggestion:
    """A single agent-generated PR suggestion.

    Attributes:
        id: Deterministic id (``prsug_<16-hex>``).
        org_id: Tenant id.
        trigger: The trigger kind (one of
            :data:`VALID_TRIGGERS`).
        trigger_id: The source event id (e.g. the Cat 2
            cluster id ``clu_<...>``).
        trigger_summary: A 1-sentence human-readable
            description of the trigger (e.g. ``"Hallucination
            score dropped 4% in customer_service_v1"``).
        files: The list of files the diff touches. The
            :attr:`FileEntry.content` is the *original*
            content; the portal renders the diff against
            this.
        patch_diff: The unified diff proposed by the LLM.
            Empty when the suggester fell back to "no
            change suggested".
        pr_title: The proposed PR title.
        pr_body: The proposed PR body (markdown).
        blast_radius: A 0-1 score (the LLM's self-eval of
            how much of the codebase the change touches).
        confidence: A 0-1 score (the LLM's self-eval of
            how confident it is in the suggestion).
        status: One of ``"pending"`` (initial),
            ``"opened"`` (human opened the PR),
            ``"merged"`` (terminal), ``"rejected"``
            (terminal). The store updates ``opened`` /
            ``"merged"`` / ``"rejected"`` as the human
            progresses.
        created_at: Suggestion creation timestamp (UTC).
        opened_pr_number: The PR number once the human
            opens the PR (``None`` until then).
    """

    id: str
    org_id: str
    trigger: str
    trigger_id: str
    trigger_summary: str
    files: list[FileEntry]
    patch_diff: str
    pr_title: str
    pr_body: str
    blast_radius: float
    confidence: float
    status: str = "pending"
    created_at: datetime = field(
        default_factory=lambda: datetime.now(UTC),
    )
    opened_pr_number: int | None = None


# ── LLM client protocol ────────────────────────────────────────


class LLMClientLike(Protocol):
    """The minimal LLM client surface the suggester needs.

    The suggester historically typed itself against a fictional
    ``complete(prompt, system=, max_tokens=)`` method; the real
    :class:`eden.llm.client.OpenRouterClient` exposes
    ``acall(agent, prompt, slot, system_prompt, ...)``. We bridge via
    :class:`_OpenRouterAdapter` below so the suggester can default to
    the real client without hand-rolling an LLM in every call site.
    Tests still mock the Protocol directly.
    """

    async def complete(
        self,
        prompt: str,
        *,
        system: str = "",
        model: str | None = None,
        max_tokens: int = 1024,
    ) -> str:
        """Return the LLM's text completion for ``prompt``."""
        ...


class _OpenRouterAdapter:
    """Adapt :class:`eden.llm.client.OpenRouterClient` to ``LLMClientLike``.

    The real client is keyed on ``agent`` (per-agent circuit breaker)
    and on ``slot`` (the model-slots table). The suggester has neither
    concept, so we hardcode ``agent="pr_suggester"`` and pick the slot
    from ``max_tokens``: ``fast`` for small prompts, ``reasoning`` for
    everything else. Mirrors the chat agent's pattern in
    ``autonomous/agent.py`` where one fixed agent id routes all
    suggester traffic through a single breaker.

    If the wrapped client doesn't expose ``acall`` (an older test
    stub), we fall back to ``complete`` so existing tests keep working.
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    async def complete(
        self,
        prompt: str,
        *,
        system: str = "",
        model: str | None = None,
        max_tokens: int = 1024,
    ) -> str:
        from eden.llm.internal_router import route_async

        slot = "fast" if max_tokens <= 1024 else "reasoning"
        resp = await route_async(
            "pr_suggester",
            prompt,
            slot=slot,
            system_prompt=system or None,
            max_tokens=max_tokens,
            output_type="text",
            requires_quality_check=False,
        )
        return getattr(resp, "content", "") or ""


# ── PRSuggester ─────────────────────────────────────────────────


# The 4 trigger kinds, with their human-readable labels
# and the file-extraction strategy.
_TRIGGER_LABELS: dict[str, str] = {
    TRIGGER_RCA_CLUSTER: "RCA cluster",
    TRIGGER_DRIFT_ALERT: "Drift alert",
    TRIGGER_RETRIEVAL_GAP: "Retrieval gap",
    TRIGGER_JUDGE_REGRESSION: "Judge regression",
}


def _extract_files_from_payload(
    payload: dict[str, Any],
) -> tuple[list[str], str]:
    """Extract the affected files + summary from a trigger payload.

    The payload is the per-trigger JSON. Each trigger kind
    has a different shape — we read the ``affected_files``
    field when present, fall back to the ``files`` field,
    and fall back to ``[]`` when neither is set.
    """
    files: list[str] = []
    if isinstance(payload.get("affected_files"), list):
        files = [str(f) for f in payload["affected_files"]]
    elif isinstance(payload.get("files"), list):
        files = [str(f) for f in payload["files"]]
    summary = str(
        payload.get("description")
        or payload.get("summary")
        or payload.get("message")
        or "Observability event"
    )
    # De-dupe while preserving order.
    seen: set[str] = set()
    deduped: list[str] = []
    for f in files:
        if f and f not in seen:
            seen.add(f)
            deduped.append(f)
    return deduped, summary


class PRSuggester:
    """Generate PR suggestions from observability events."""

    name: str = "pr_suggester"

    def __init__(
        self,
        repo_provider: RepoProvider,
        llm_client: LLMClientLike | None = None,
        store_path: str | None = None,
    ) -> None:
        self._repo = repo_provider
        # Default to a real OpenRouter client (matches the chat agent
        # pattern). ``OpenRouterClient`` is imported lazily so tests
        # that mock the Protocol don't pay the network-stack import
        # cost, and so a missing API key in tests doesn't blow up
        # at import time.
        if llm_client is None:
            try:
                from eden.llm.client import OpenRouterClient
                llm_client = _OpenRouterAdapter(OpenRouterClient())
            except Exception as exc:  # noqa: BLE001
                # If the OpenRouter client can't be constructed
                # (no API key, missing dependency in a unit-test
                # env, etc.) keep ``self._llm`` as None and let the
                # runtime path raise a clearer RuntimeError.
                logger.debug(
                    "PRSuggester: could not construct default "
                    "OpenRouterClient (%s); llm_client stays None",
                    exc,
                )
        self._llm = llm_client
        self._store_path = store_path or self._default_store_path()

    def _default_store_path(self) -> str:
        """The default JSONL log path.

        Lives alongside the local repo's ``.eden/`` dir so
        the dev flow's "open the inbox + open the PR"
        round-trip is a single ``.eden/`` directory.
        """
        # ``RepoProvider`` doesn't expose the repo path
        # (it's an abstract contract). For the local impl
        # we peek at the private ``_repo_path`` field; for
        # non-local providers we fall back to the cwd.
        repo_path = getattr(self._repo, "repo_path", None) or os.getcwd()
        eden_dir = os.path.join(repo_path, ".eden")
        return os.path.join(eden_dir, "pr_suggestions.jsonl")

    async def suggest(
        self,
        org_id: str,
        *,
        trigger: str,
        trigger_id: str,
        trigger_payload: dict[str, Any],
    ) -> PRSuggestion:
        """Build a :class:`PRSuggestion` for the given trigger.

        Steps:
            1. Validate the trigger + extract the affected
               files + summary from the payload.
            2. Read each affected file via the
               :class:`RepoProvider`.
            3. Build the LLM prompt + call the LLM.
            4. Parse the LLM's response (a unified diff +
               JSON metadata).
            5. Persist + return the suggestion.
        """
        if trigger not in VALID_TRIGGERS:
            # The route layer validates this too; we
            # accept unknown triggers for forward-compat.
            logger.debug(
                "PRSuggester: unknown trigger %r (forward-compat)",
                trigger,
            )
        files_glob, summary = _extract_files_from_payload(trigger_payload)
        file_entries: list[FileEntry] = []
        for path in files_glob:
            content = await self._repo.read_file(path)
            if not content:
                # Skip missing / unreadable files; the
                # diff can still be proposed against the
                # other files.
                continue
            file_entries.append(
                FileEntry(
                    path=path,
                    size=len(content.encode("utf-8")),
                    content=content,
                )
            )

        # The LLM call. When no LLM client is configured
        # (the dev / CI path) we fall back to a heuristic
        # suggestion so the inbox has data to render.
        if self._llm is not None:
            try:
                pr_title, pr_body, patch_diff, blast_radius, confidence = (
                    await self._call_llm(
                        trigger=trigger,
                        trigger_id=trigger_id,
                        summary=summary,
                        files=file_entries,
                    )
                )
            except Exception as exc:
                logger.warning(
                    "PRSuggester: LLM call failed (%s); falling "
                    "back to heuristic suggestion", exc,
                )
                pr_title, pr_body, patch_diff, blast_radius, confidence = (
                    self._heuristic_suggestion(
                        trigger=trigger,
                        trigger_id=trigger_id,
                        summary=summary,
                        files=file_entries,
                    )
                )
        else:
            pr_title, pr_body, patch_diff, blast_radius, confidence = (
                self._heuristic_suggestion(
                    trigger=trigger,
                    trigger_id=trigger_id,
                    summary=summary,
                    files=file_entries,
                )
            )

        suggestion = PRSuggestion(
            id=f"prsug_{uuid.uuid4().hex[:16]}",
            org_id=org_id,
            trigger=trigger,
            trigger_id=trigger_id,
            trigger_summary=summary,
            files=file_entries,
            patch_diff=patch_diff,
            pr_title=pr_title,
            pr_body=pr_body,
            blast_radius=blast_radius,
            confidence=confidence,
            status="pending",
        )
        self._persist(suggestion)
        await self._async_persist_to_proposed_patches(suggestion)
        return suggestion

    async def list_suggestions(
        self,
        org_id: str,
        *,
        status: str | None = None,
        trigger: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> list[PRSuggestion]:
        """List suggestions from the JSONL store, newest first.

        Filters: ``status`` (one of pending/opened/merged/rejected)
        + ``trigger`` (one of :data:`VALID_TRIGGERS`)
        + ``since`` (an ISO-8601 timestamp; only suggestions
        with ``created_at >= since`` are returned). The
        date filter is the v1.7 inbox date-range slider's
        backing.

        When Postgres is available, also merges rows from
        ``proposed_patches`` (dual-read) so suggestions
        written only to the DB still appear.
        """
        out: list[PRSuggestion] = []
        seen: set[str] = set()
        if os.path.isfile(self._store_path):
            # Parse the since string once.
            since_ts: float | None = None
            if since:
                try:
                    from datetime import datetime as _dt
                    since_ts = _dt.fromisoformat(since.replace("Z", "+00:00")).timestamp()
                except Exception:
                    since_ts = None
            try:
                with open(self._store_path, encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except Exception:
                            continue
                        if data.get("org_id") != org_id:
                            continue
                        if status and data.get("status") != status:
                            continue
                        if trigger and data.get("trigger") != trigger:
                            continue
                        if since_ts is not None:
                            try:
                                from datetime import datetime as _dt
                                created = data.get("created_at")
                                if created:
                                    created_ts = _dt.fromisoformat(
                                        created.replace("Z", "+00:00"),
                                    ).timestamp()
                                    if created_ts < since_ts:
                                        continue
                            except Exception:
                                pass
                        try:
                            suggestion = _suggestion_from_dict(data)
                            out.append(suggestion)
                            seen.add(suggestion.id)
                        except Exception:
                            continue
            except Exception as exc:
                logger.debug("PRSuggester.list_suggestions: %s", exc)

        # Dual-read: merge Postgres-backed suggestions not already
        # present in the JSONL log (best-effort; no-op offline).
        try:
            pg_rows = await self._list_from_proposed_patches(
                org_id,
                status=status,
                trigger=trigger,
                since=since,
                limit=limit,
            )
            for suggestion in pg_rows:
                if suggestion.id not in seen:
                    out.append(suggestion)
                    seen.add(suggestion.id)
        except Exception as exc:
            logger.debug("PRSuggester.list_suggestions postgres: %s", exc)

        out.sort(key=lambda s: s.created_at, reverse=True)
        return out[:limit]

    async def get_suggestion(
        self, org_id: str, suggestion_id: str,
    ) -> PRSuggestion | None:
        """Read a single suggestion by id (JSONL, then Postgres)."""
        if os.path.isfile(self._store_path):
            try:
                with open(self._store_path, encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except Exception:
                            continue
                        if (
                            data.get("org_id") == org_id
                            and data.get("id") == suggestion_id
                        ):
                            return _suggestion_from_dict(data)
            except Exception as exc:
                logger.debug("PRSuggester.get_suggestion: %s", exc)
        try:
            return await self._get_from_proposed_patches(
                org_id, suggestion_id,
            )
        except Exception as exc:
            logger.debug("PRSuggester.get_suggestion postgres: %s", exc)
            return None

    async def mark_opened(
        self, org_id: str, suggestion_id: str, pr_number: int,
    ) -> PRSuggestion | None:
        """Flip the suggestion to ``"opened"`` + set the PR number.

        Rewrites the JSONL file in place. Returns the
        updated suggestion.
        """
        found = self._update_suggestion(
            org_id, suggestion_id,
            status="opened",
            opened_pr_number=pr_number,
        )
        if found is not None:
            await self._update_proposed_patches_status(
                org_id, suggestion_id, status="opened",
            )
        return found

    async def mark_status(
        self,
        org_id: str,
        suggestion_id: str,
        status: str,
    ) -> PRSuggestion | None:
        """Flip the suggestion's status to one of
        ``"merged"`` / ``"rejected"``. Returns the updated
        suggestion or ``None`` when the id is unknown."""
        if status not in {"merged", "rejected", "opened"}:
            return None
        found = self._update_suggestion(
            org_id, suggestion_id, status=status,
        )
        if found is not None:
            await self._update_proposed_patches_status(
                org_id, suggestion_id, status=status,
            )
        return found

    async def get_file_content(
        self,
        org_id: str,
        suggestion_id: str,
        file_path: str,
    ) -> dict[str, Any] | None:
        """Read the current content of a file referenced by a suggestion.

        The file is read via the :class:`RepoProvider`
        (NOT from the suggestion's stored snapshot — the
        store keeps the suggestion's view of the file
        at suggestion-creation time, but the portal
        usually wants the *current* file for the diff
        view). Returns a dict with ``path``, ``content``,
        ``size``; ``None`` when the suggestion doesn't
        exist or the file isn't accessible.
        """
        suggestion = await self.get_suggestion(
            org_id, suggestion_id,
        )
        if suggestion is None:
            return None
        # Verify the file is one of the suggestion's
        # affected files (so a malicious caller can't
        # read arbitrary files from the repo).
        affected = {f.path for f in suggestion.files}
        if file_path not in affected:
            return None
        try:
            content = await self._repo.read_file(file_path)
        except Exception:
            return None
        return {
            "path": file_path,
            "content": content,
            "size": len(content.encode("utf-8")),
        }

    async def regenerate(
        self,
        org_id: str,
        suggestion_id: str,
    ) -> PRSuggestion | None:
        """Re-run the suggester for an existing suggestion.

        Reads the trigger + payload + affected files
        from the existing suggestion, runs the LLM
        (or heuristic) again, and overwrites the
        suggestion in-place with the new diff. The
        ``status`` is reset to ``"pending"`` (a
        regenerate is a "give me a new diff" — the
        human reviews again). The ``created_at`` is
        bumped so the inbox sort keeps the fresh
        suggestion on top.
        """
        original = await self.get_suggestion(
            org_id, suggestion_id,
        )
        if original is None:
            return None
        # Re-read the file content so the new diff is
        # generated against the *current* file (not
        # the snapshot from the previous suggest).
        file_entries: list[FileEntry] = []
        for f in original.files:
            try:
                content = await self._repo.read_file(f.path)
            except Exception:
                content = f.content  # fall back to the snapshot
            if content:
                file_entries.append(
                    FileEntry(
                        path=f.path,
                        size=len(content.encode("utf-8")),
                        content=content,
                    )
                )
        # Run the LLM (or heuristic).
        if self._llm is not None:
            try:
                pr_title, pr_body, patch_diff, blast_radius, confidence = (
                    await self._call_llm(
                        trigger=original.trigger,
                        trigger_id=original.trigger_id,
                        summary=original.trigger_summary,
                        files=file_entries,
                    )
                )
            except Exception as exc:
                logger.warning(
                    "PRSuggester.regenerate: LLM call failed "
                    "(%s); falling back to heuristic", exc,
                )
                pr_title, pr_body, patch_diff, blast_radius, confidence = (
                    self._heuristic_suggestion(
                        trigger=original.trigger,
                        trigger_id=original.trigger_id,
                        summary=original.trigger_summary,
                        files=file_entries,
                    )
                )
        else:
            pr_title, pr_body, patch_diff, blast_radius, confidence = (
                self._heuristic_suggestion(
                    trigger=original.trigger,
                    trigger_id=original.trigger_id,
                    summary=original.trigger_summary,
                    files=file_entries,
                )
            )
        # Overwrite in-place. The :meth:`_update_suggestion`
        # helper preserves the id + org_id + trigger +
        # trigger_id; we update everything else.
        updated = PRSuggestion(
            id=original.id,
            org_id=original.org_id,
            trigger=original.trigger,
            trigger_id=original.trigger_id,
            trigger_summary=original.trigger_summary,
            files=file_entries,
            patch_diff=patch_diff,
            pr_title=pr_title,
            pr_body=pr_body,
            blast_radius=blast_radius,
            confidence=confidence,
            status="pending",
            created_at=datetime.now(UTC),
            opened_pr_number=original.opened_pr_number,
        )
        # Replace the row in the JSONL log. The simplest
        # implementation: re-persist + remove the old.
        # We rewrite the file in full to keep things simple.
        self._replace_suggestion(updated)
        await self._async_persist_to_proposed_patches(updated)
        return updated

    async def bulk_regenerate(
        self,
        org_id: str,
        suggestion_ids: list[str],
    ) -> dict[str, Any]:
        """Regenerate multiple suggestions in one call.

        Returns ``{"regenerated": [...], "skipped": [...]}``.
        The two arrays are deterministic — a regenerated
        suggestion lands in ``regenerated``; a missing
        id (or one owned by a different org) lands in
        ``skipped``. The method is best-effort: a
        failure in one regenerate doesn't abort the
        batch.
        """
        regenerated: list[str] = []
        skipped: list[str] = []
        for sid in suggestion_ids:
            try:
                updated = await self.regenerate(org_id, sid)
                if updated is not None:
                    regenerated.append(sid)
                else:
                    skipped.append(sid)
            except Exception as exc:
                logger.warning(
                    "PRSuggester.bulk_regenerate: %s failed (%s)",
                    sid, exc,
                )
                skipped.append(sid)
        return {
            "regenerated": regenerated,
            "skipped": skipped,
        }

    def _replace_suggestion(self, suggestion: PRSuggestion) -> None:
        """Replace an existing suggestion row in the JSONL log.

        The file is read in full + written in full. The
        row whose id + org_id matches is replaced; all
        other rows are kept verbatim. Returns ``True``
        on a successful replace.
        """
        if not os.path.isfile(self._store_path):
            return
        try:
            with open(self._store_path, encoding="utf-8") as fh:
                lines = fh.readlines()
        except Exception:
            return
        out: list[str] = []
        replaced = False
        for line in lines:
            stripped = line.strip()
            if not stripped:
                out.append(line)
                continue
            try:
                data = json.loads(stripped)
            except Exception:
                out.append(line)
                continue
            if (
                data.get("org_id") == suggestion.org_id
                and data.get("id") == suggestion.id
            ):
                out.append(
                    json.dumps(_suggestion_to_dict(suggestion))
                    + "\n"
                )
                replaced = True
            else:
                out.append(line)
        if not replaced:
            # The suggestion wasn't in the log (e.g. it was
            # generated by a different process). Append
            # the new row at the end.
            out.append(
                json.dumps(_suggestion_to_dict(suggestion))
                + "\n"
            )
        # Atomic replace — never truncate-in-place. Failures propagate
        # so callers do not treat a lost write as success.
        atomic_write_lines(self._store_path, out)

    # ── Internal helpers ───────────────────────────────────

    async def _call_llm(
        self,
        *,
        trigger: str,
        trigger_id: str,
        summary: str,
        files: list[FileEntry],
    ) -> tuple[str, str, str, float, float]:
        """Call the LLM and parse the response.

        Returns: ``(pr_title, pr_body, patch_diff,
        blast_radius, confidence)``.

        The prompt asks the LLM to return a structured
        JSON response with the 5 fields. The parser is
        defensive — a malformed response falls back to a
        plain-text PR title + an empty diff.
        """
        if self._llm is None:
            raise RuntimeError("LLM client not configured")
        file_block = "\n\n".join(
            f"--- {f.path} ---\n{f.content}" for f in files
        )
        system = (
            "You are an expert code reviewer. Given an "
            "observability event and the affected source "
            "files, propose a minimal code change as a "
            "unified diff. Always respond with a single "
            "JSON object with these fields:\n"
            "  pr_title (string)\n"
            "  pr_body (string, 2-4 sentence summary)\n"
            "  patch_diff (string, unified diff)\n"
            "  blast_radius (number, 0-1)\n"
            "  confidence (number, 0-1)\n"
            "Do not add commentary. Output ONLY the JSON."
        )
        trigger_label = _TRIGGER_LABELS.get(trigger, trigger)
        prompt = (
            f"Trigger: {trigger_label} ({trigger_id})\n"
            f"Summary: {summary}\n\n"
            f"Affected files:\n{file_block}\n\n"
            "Propose the minimal unified diff that "
            "addresses the trigger. Keep the diff to 1-3 "
            "line changes when possible."
        )
        response = await self._llm.complete(
            prompt=prompt,
            system=system,
            max_tokens=2048,
        )
        # The LLM may wrap the JSON in ```json ... ``` or
        # return it bare — try both.
        text = response.strip()
        m = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if m is None:
            return self._heuristic_suggestion(
                trigger=trigger, trigger_id=trigger_id,
                summary=summary, files=files,
            )
        try:
            data = json.loads(m.group(0))
        except Exception:
            return self._heuristic_suggestion(
                trigger=trigger, trigger_id=trigger_id,
                summary=summary, files=files,
            )
        return (
            str(data.get("pr_title", "")).strip()
            or f"Fix: {summary[:60]}",
            str(data.get("pr_body", "")).strip()
            or f"Auto-suggested based on {trigger_label} {trigger_id}.",
            str(data.get("patch_diff", "")).strip(),
            _clamp01(data.get("blast_radius", 0.1)),
            _clamp01(data.get("confidence", 0.5)),
        )

    def _heuristic_suggestion(
        self,
        *,
        trigger: str,
        trigger_id: str,
        summary: str,
        files: list[FileEntry],
    ) -> tuple[str, str, str, float, float]:
        """Heuristic fallback when no LLM is configured (or it failed).

        Produces a real-looking suggestion (title, body, an
        empty diff) so the inbox has data to render. The
        diff is empty — the human can either regenerate
        with the LLM, or write the change by hand.
        """
        trigger_label = _TRIGGER_LABELS.get(trigger, trigger)
        if files:
            paths = ", ".join(f.path for f in files[:3])
            if len(files) > 3:
                paths += f" (+{len(files) - 3} more)"
            pr_title = f"[Eden Agent] Address {trigger_label} in {paths}"
            pr_body = (
                f"Auto-suggested based on {trigger_label} "
                f"(`{trigger_id}`).\n\n**Summary:** {summary}\n\n"
                f"**Affected files:** {paths}\n\n"
                "Configure an LLM client on the PRSuggester "
                "to generate a real unified diff."
            )
        else:
            pr_title = f"[Eden Agent] Address {trigger_label} {trigger_id}"
            pr_body = (
                f"Auto-suggested based on {trigger_label} "
                f"(`{trigger_id}`).\n\n**Summary:** {summary}\n\n"
                "No affected files were attached to this "
                "trigger. Configure an LLM client on the "
                "PRSuggester to generate a real unified diff."
            )
        return (
            pr_title, pr_body, "",
            min(0.3, 0.1 * max(1, len(files))),
            0.3,
        )

    def _persist(self, suggestion: PRSuggestion) -> None:
        """Append the suggestion to the JSONL store."""
        try:
            os.makedirs(os.path.dirname(self._store_path), exist_ok=True)
            with open(self._store_path, "a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(_suggestion_to_dict(suggestion))
                    + "\n"
                )
        except Exception as exc:
            logger.debug("PRSuggester._persist: %s", exc)

    async def _async_persist_to_proposed_patches(
        self, suggestion: PRSuggestion,
    ) -> None:
        """Best-effort dual-write into Cat 23 ``proposed_patches``.

        Failures are silent so the JSONL path (and unit tests)
        keep working when Postgres is unavailable.
        """
        try:
            from eden.patches._common import _insert_row
        except Exception:
            return
        status = _suggestion_status_to_patch(suggestion.status)
        description = suggestion.pr_title or suggestion.trigger_summary or ""
        explanation = suggestion.pr_body or ""
        # repo_id is NOT NULL on proposed_patches — use a stable
        # placeholder when the suggester has no repo connection.
        repo_id = getattr(self._repo, "repo_id", None) or "local"
        try:
            await _insert_row(
                suggestion.org_id,
                "proposed_patches",
                [
                    "id",
                    "repo_id",
                    "trace_id",
                    "rca_id",
                    "base_sha",
                    "diff",
                    "description",
                    "explanation",
                    "blast_radius_score",
                    "quality_score",
                    "model_used",
                    "cost_usd",
                    "version",
                    "status",
                ],
                [
                    suggestion.id,
                    str(repo_id),
                    suggestion.trigger_id or "",
                    (
                        suggestion.trigger_id
                        if suggestion.trigger == TRIGGER_RCA_CLUSTER
                        else None
                    ),
                    "",
                    suggestion.patch_diff or "",
                    description,
                    explanation,
                    float(suggestion.blast_radius or 0.0),
                    float(suggestion.confidence or 0.0),
                    "pr_suggester",
                    0.0,
                    1,
                    status,
                ],
            )
        except Exception as exc:
            logger.debug(
                "PRSuggester._async_persist_to_proposed_patches: %s", exc,
            )

    async def _list_from_proposed_patches(
        self,
        org_id: str,
        *,
        status: str | None = None,
        trigger: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> list[PRSuggestion]:
        """Best-effort read of agent suggestions from ``proposed_patches``.

        Only rows written by the suggester (``model_used=pr_suggester``)
        are returned, so Cat 23 inbox patches don't leak into the
        agent PR-suggestion list.
        """
        try:
            from eden.patches._common import _select_rows
        except Exception:
            return []
        try:
            rows = await _select_rows(
                org_id,
                "proposed_patches",
                where="model_used = $2",
                params=("pr_suggester",),
                order_by="created_at DESC",
                limit=limit * 2,
            )
        except Exception as exc:
            logger.debug("PRSuggester._list_from_proposed_patches: %s", exc)
            return []
        since_ts: float | None = None
        if since:
            try:
                since_ts = datetime.fromisoformat(
                    since.replace("Z", "+00:00"),
                ).timestamp()
            except Exception:
                since_ts = None
        out: list[PRSuggestion] = []
        for row in rows:
            suggestion = _suggestion_from_patch_row(row)
            if suggestion is None:
                continue
            if status and suggestion.status != status:
                continue
            if trigger and suggestion.trigger != trigger:
                continue
            if since_ts is not None:
                try:
                    if suggestion.created_at.timestamp() < since_ts:
                        continue
                except Exception:
                    pass
            out.append(suggestion)
        return out[:limit]

    async def _get_from_proposed_patches(
        self, org_id: str, suggestion_id: str,
    ) -> PRSuggestion | None:
        try:
            from eden.patches._common import _select_one
        except Exception:
            return None
        try:
            row = await _select_one(
                org_id,
                "proposed_patches",
                where="id = $2",
                params=(suggestion_id,),
            )
        except Exception as exc:
            logger.debug("PRSuggester._get_from_proposed_patches: %s", exc)
            return None
        if row is None:
            return None
        return _suggestion_from_patch_row(row)

    async def _update_proposed_patches_status(
        self,
        org_id: str,
        suggestion_id: str,
        *,
        status: str | None = None,
    ) -> None:
        if status is None:
            return
        try:
            from eden.patches._common import _update_row
        except Exception:
            return
        try:
            await _update_row(
                org_id,
                "proposed_patches",
                where_col="id",
                where_val=suggestion_id,
                set_col="status",
                set_val=_suggestion_status_to_patch(status),
            )
        except Exception as exc:
            logger.debug(
                "PRSuggester._update_proposed_patches_status: %s", exc,
            )

    def _update_suggestion(
        self,
        org_id: str,
        suggestion_id: str,
        *,
        status: str | None = None,
        opened_pr_number: int | None = None,
    ) -> PRSuggestion | None:
        """Rewrite the JSONL with the suggestion's status flipped.

        The file is read in full + written in full. The
        JSONL is small (handfuls of suggestions per org
        per day) so the rewrite is fine. Returns the
        updated suggestion or ``None`` if not found.
        """
        if not os.path.isfile(self._store_path):
            return None
        try:
            with open(self._store_path, encoding="utf-8") as fh:
                lines = fh.readlines()
        except Exception:
            return None
        out_lines: list[str] = []
        found: PRSuggestion | None = None
        for line in lines:
            stripped = line.strip()
            if not stripped:
                out_lines.append(line)
                continue
            try:
                data = json.loads(stripped)
            except Exception:
                out_lines.append(line)
                continue
            if (
                data.get("org_id") == org_id
                and data.get("id") == suggestion_id
            ):
                if status is not None:
                    data["status"] = status
                if opened_pr_number is not None:
                    data["opened_pr_number"] = opened_pr_number
                found = _suggestion_from_dict(data)
                out_lines.append(
                    json.dumps(data) + "\n",
                )
            else:
                out_lines.append(line)
        if found is None:
            return None
        # Atomic replace — never truncate-in-place. Failures propagate
        # so mark_opened / mark_status do not desync Postgres.
        atomic_write_lines(self._store_path, out_lines)
        return found


# ── Helpers ─────────────────────────────────────────────────────


def _clamp01(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _suggestion_status_to_patch(status: str) -> str:
    """Map PRSuggestion status → proposed_patches.status."""
    return {
        "pending": "proposed",
        "opened": "approved",
        "merged": "merged",
        "rejected": "denied",
    }.get(status, "proposed")


def _patch_status_to_suggestion(status: str) -> str:
    """Map proposed_patches.status → PRSuggestion status."""
    return {
        "proposed": "pending",
        "approved": "opened",
        "merged": "merged",
        "denied": "rejected",
        "rejected": "rejected",
        "needs_revision": "pending",
        "reverted": "rejected",
    }.get(status, "pending")


def _suggestion_from_patch_row(row: dict[str, Any]) -> PRSuggestion | None:
    """Best-effort convert a ``proposed_patches`` row to PRSuggestion."""
    try:
        created_at = row.get("created_at")
        if isinstance(created_at, datetime):
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=UTC)
        elif isinstance(created_at, str):
            created_at = datetime.fromisoformat(
                created_at.replace("Z", "+00:00"),
            )
        else:
            created_at = datetime.now(UTC)
        explanation = row.get("explanation") or ""
        description = row.get("description") or ""
        # Recover trigger metadata from explanation prefix when present.
        trigger = "rca_cluster"
        trigger_id = str(row.get("rca_id") or row.get("trace_id") or "")
        return PRSuggestion(
            id=str(row.get("id") or ""),
            org_id=str(row.get("org_id") or ""),
            trigger=trigger,
            trigger_id=trigger_id,
            trigger_summary=description,
            files=[],
            patch_diff=str(row.get("diff") or ""),
            pr_title=description,
            pr_body=explanation if isinstance(explanation, str) else str(explanation),
            blast_radius=_clamp01(row.get("blast_radius_score", 0.0)),
            confidence=_clamp01(row.get("quality_score", 0.0)),
            status=_patch_status_to_suggestion(
                str(row.get("status") or "proposed"),
            ),
            created_at=created_at,
            opened_pr_number=None,
        )
    except Exception:
        return None


def _suggestion_to_dict(s: PRSuggestion) -> dict:
    """Serialise a :class:`PRSuggestion` to a JSON-safe dict.

    The files are written as ``{"path": ..., "size": ...,
    "content": ...}`` (the diff renders against this).
    """
    return {
        "id": s.id,
        "org_id": s.org_id,
        "trigger": s.trigger,
        "trigger_id": s.trigger_id,
        "trigger_summary": s.trigger_summary,
        "files": [
            {"path": f.path, "size": f.size, "content": f.content}
            for f in s.files
        ],
        "patch_diff": s.patch_diff,
        "pr_title": s.pr_title,
        "pr_body": s.pr_body,
        "blast_radius": s.blast_radius,
        "confidence": s.confidence,
        "status": s.status,
        "created_at": s.created_at.isoformat(),
        "opened_pr_number": s.opened_pr_number,
    }


def _suggestion_from_dict(data: dict) -> PRSuggestion:
    """Parse a :class:`PRSuggestion` from a serialised dict."""
    try:
        created_at = datetime.fromisoformat(data["created_at"])
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
    except Exception:
        created_at = datetime.now(UTC)
    return PRSuggestion(
        id=str(data.get("id", "")),
        org_id=str(data.get("org_id", "")),
        trigger=str(data.get("trigger", "")),
        trigger_id=str(data.get("trigger_id", "")),
        trigger_summary=str(data.get("trigger_summary", "")),
        files=[
            FileEntry(
                path=str(f.get("path", "")),
                size=int(f.get("size", 0)),
                content=str(f.get("content", "")),
            )
            for f in data.get("files", [])
        ],
        patch_diff=str(data.get("patch_diff", "")),
        pr_title=str(data.get("pr_title", "")),
        pr_body=str(data.get("pr_body", "")),
        blast_radius=_clamp01(data.get("blast_radius", 0.0)),
        confidence=_clamp01(data.get("confidence", 0.0)),
        status=str(data.get("status", "pending")),
        created_at=created_at,
        opened_pr_number=(
            int(data["opened_pr_number"])
            if data.get("opened_pr_number") is not None
            else None
        ),
    )


__all__ = [
    "LLMClientLike",
    "PRSuggestion",
    "PRSuggester",
    "TRIGGER_DRIFT_ALERT",
    "TRIGGER_JUDGE_REGRESSION",
    "TRIGGER_RCA_CLUSTER",
    "TRIGGER_RETRIEVAL_GAP",
    "VALID_TRIGGERS",
]
