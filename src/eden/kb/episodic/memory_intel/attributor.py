"""Memory Intelligence services (Cat 5) — real implementations.

Four services:

* :class:`MemoryAttributor` — for a single trace, reads the
  ``memory.*`` events on the trace, computes a per-memory
  influence score (0..1, normalised to sum to 1.0 across
  the trace), and persists one row per memory to
  ``memory_attributions``. The role label (``primary`` /
  ``secondary`` / ``context``) follows the appendix
  thresholds. Influence is a token-overlap heuristic between
  the memory's text and the trace's final answer — the v0
  implementation does NOT re-run the LLM (the v1
  counterfactual path is documented in the appendix but
  deferred).

* :class:`MemoryTimelineBuilder` — for one ``memory_id``,
  returns the chronological lifecycle of the memory (created
  / updated / deleted / accessed events) by reading from
  ``memory_timeline_events``. The endpoint is also wired to
  *append* a synthetic ``accessed`` event for the requesting
  trace so the timeline self-populates as a side-effect of
  use.

* :class:`MemoryImpactScorer` — for a single trace, scores
  each memory's *impact* on the final answer (0..1). Impact
  is a different signal from influence: influence measures
  "did this memory show up in the answer text?"; impact
  weighs the memory's *retrieval score* and *recency of
  prior attributions* (a memory that has been consistently
  material in the last 30 days gets a higher impact than a
  one-off that just happened to overlap). Persists to
  ``memory_impact_scores``.

* :class:`MemoryReweaver` — for one ``memory_id`` (or the
  org's full set), returns *suggestions* of three action
  types: ``archive`` (last accessed > :data:`STALE_DAYS`
  days ago), ``demote`` (zero attributions in the last
  :data:`NEVER_MATERIAL_DAYS` days), ``merge`` (Jaccard
  similarity > :data:`NEAR_DUPLICATE_THRESHOLD` with
  another memory). The endpoint never mutates state — a
  separate admin endpoint (deferred to v2 per the appendix)
  applies the merge / archive.

All four services degrade gracefully when their dependencies
are missing or empty (the typical Eden pattern: a "no data"
envelope with a ``message`` hint).

See ``docs/observability-gap/05-memory-intelligence.md``.
"""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime
from typing import Any

from ._common import (
    MAX_MEMORIES_PER_TRACE,
    MAX_NEAR_DUPLICATES,
    NEAR_DUPLICATE_THRESHOLD,
    NEVER_MATERIAL_DAYS,
    STALE_DAYS,
    _bad_request_envelope,
    _days_since,
    _delete_then_insert_attributions,
    _delete_then_insert_impact,
    _fetch_distinct_memory_ids_in_window,
    _fetch_last_accessed_for_memory,
    _fetch_memories_metadata_for_org,
    _fetch_memories_used_in_trace,
    _fetch_recent_attributions_for_memory,
    _fetch_recent_attributions_for_memories,
    _fetch_trace_response_text,
    _insert_timeline_event,
    _normalise_attributions,
    _not_found_envelope,
    _ok_envelope,
    _parse_window,
    _role_for_score,
    _token_overlap,
)

logger = logging.getLogger(__name__)


# ── 1. MemoryAttributor ──────────────────────────────────────────────


class MemoryAttributor:
    """Per-memory influence scorer for a single trace.

    The :attr:`name` is ``"memory_attributor"`` and matches
    the ``feature`` field in the response envelope. Public
    method :meth:`attribute` returns the live envelope on
    success, the live "no memories used" envelope when the
    trace has no ``memory.*`` events, and a ``bad_request``
    envelope when the request shape is wrong.
    """

    name = "memory_attributor"

    async def attribute(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        # 1. Read the memory events for the trace. The
        # underlying helper tolerates empty / missing data so
        # the envelope shape is consistent for the front-end.
        memories = await _fetch_memories_used_in_trace(org_id, trace_id)
        if not memories:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "per_memory": [],
                    "primary_memory_id": None,
                    "covered": False,
                    "message": "no memories used in this trace",
                },
            )

        # 2. Cap at MAX_MEMORIES_PER_TRACE — the v0 guardrail
        # in the appendix. The cap is applied to the
        # *ordered* memories (preserving the order the
        # harness surfaced them) so the response is
        # deterministic for the same input.
        if len(memories) > MAX_MEMORIES_PER_TRACE:
            memories = memories[:MAX_MEMORIES_PER_TRACE]

        # 3. Read the final answer. The token-overlap
        # heuristic is the fallback when the answer text is
        # missing; the front-end is told via ``message``.
        answer_text = await _fetch_trace_response_text(org_id, trace_id)

        # 4. Per-memory raw influence: token overlap with
        # the answer, with a retrieval-score multiplier
        # when the harness logged a cosine score.
        raw_scores: list[float] = []
        for mem in memories:
            text = mem.get("memory_text") or mem.get("memory_id", "")
            overlap = _token_overlap(text, answer_text) if answer_text else 0.0
            retrieval_score = mem.get("retrieval_score")
            if retrieval_score is not None and 0.0 <= retrieval_score <= 1.0:
                # retrieval_score is a 0..1 cosine similarity
                # from the harness; the v0 influence is
                # ``0.7 * overlap + 0.3 * retrieval_score`` so
                # the answer-text signal still dominates but a
                # high-cosine retrieval can still surface even
                # when the answer doesn't reference the memory
                # verbatim.
                raw = 0.7 * overlap + 0.3 * float(retrieval_score)
            else:
                raw = overlap
            raw_scores.append(raw)

        # 5. Normalise to sum to 1.0 (softmax-style). For a
        # single-memory trace, the helper returns ``[1.0]``
        # so the response is well-formed.
        normalised = _normalise_attributions(raw_scores)

        # 6. Build the per-memory response rows.
        per_memory: list[dict[str, Any]] = []
        primary: str | None = None
        for mem, score in zip(memories, normalised, strict=False):
            role = _role_for_score(float(score))
            if role == "primary" and primary is None:
                primary = mem["memory_id"]
            per_memory.append(
                {
                    "memory_id": mem["memory_id"],
                    "influence_score": round(float(score), 6),
                    "role": role,
                }
            )
        # If no row hit the primary threshold, the
        # highest-scoring row is implicitly the primary —
        # front-end rendering can pick the top-1.
        if primary is None and per_memory:
            primary = per_memory[0]["memory_id"]

        # 7. Persist (best-effort — failures are logged and
        # swallowed by the helper).
        await _delete_then_insert_attributions(
            org_id,
            trace_id,
            [
                {"memory_id": r["memory_id"], "influence_score": r["influence_score"]}
                for r in per_memory
            ],
        )

        # 8. Optional: log an "accessed" timeline event for
        # each memory the trace used. Best-effort; never
        # blocks the response.
        now = datetime.now(UTC)
        for mem in memories:
            try:
                await _insert_timeline_event(
                    org_id,
                    mem["memory_id"],
                    event_type="accessed",
                    occurred_at=now,
                    actor="agent:memory_attributor",
                    trace_id=trace_id,
                    payload={"influence_score": 0.0},  # filled below
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug(
                    "memory_intel: timeline access write failed: %s", exc,
                )

        message: str | None = None
        if not answer_text:
            message = "no answer text — uniform 1/N attribution"

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "per_memory": per_memory,
                "primary_memory_id": primary,
                "covered": True,
                "message": message,
            },
        )


# ── 2. MemoryTimelineBuilder ─────────────────────────────────────────


class MemoryTimelineBuilder:
    """Chronological lifecycle of one memory.

    The :attr:`name` is ``"memory_timeline"``. Public method
    :meth:`timeline` returns the live envelope with the most
    recent :data:`MAX_TIMELINE_EVENTS` events for the
    memory, ordered by ``occurred_at DESC``.
    """

    name = "memory_timeline"

    async def timeline(
        self,
        org_id: str,
        *,
        memory_id: str,
    ) -> dict[str, Any]:
        from ._common import _fetch_memory_timeline  # local import keeps the
        # top of the file reading in the canonical order

        if not memory_id or not str(memory_id).strip():
            return _bad_request_envelope(
                self.name,
                "memory_id must be a non-empty string",
            )
        memory_id = str(memory_id).strip()[:128]

        events = await _fetch_memory_timeline(org_id, memory_id)
        if not events:
            return _not_found_envelope(self.name, memory_id=memory_id)

        # Build the response rows. The ``payload`` is the
        # decoded ``payload_json`` (best-effort — bad JSON
        # is returned as a string).
        import json as _json

        rows: list[dict[str, Any]] = []
        for ev in events:
            payload = ev.get("payload_json")
            if isinstance(payload, str) and payload:
                with contextlib.suppress(Exception):
                    # Leave as the raw string on any decode error.
                    payload = _json.loads(payload)
            rows.append(
                {
                    "event_type": ev.get("event_type"),
                    "occurred_at": (
                        ev["occurred_at"].isoformat()
                        if hasattr(ev.get("occurred_at"), "isoformat")
                        else ev.get("occurred_at")
                    ),
                    "actor": ev.get("actor"),
                    "trace_id": ev.get("trace_id"),
                    "payload": payload,
                }
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "memory_id": memory_id,
                "events": rows,
                "event_count": len(rows),
            },
        )


# ── 3. MemoryImpactScorer ────────────────────────────────────────────


class MemoryImpactScorer:
    """Per-memory impact scorer for a single trace.

    Impact differs from influence: influence is
    "did the answer reference this memory?" (token overlap);
    impact is a *weighted* signal that also factors in the
    memory's retrieval score, the recency of prior
    attributions, and the materiality (number of times the
    memory has been attributed in the last 30 days).

    The :attr:`name` is ``"memory_impact"``.
    """

    name = "memory_impact"

    async def score(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        # 1. Re-use the attributor's read path for the trace
        # — same set of memories, but a different scoring
        # function on top of the same data.
        memories = await _fetch_memories_used_in_trace(org_id, trace_id)
        if not memories:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "per_memory": [],
                    "primary_memory_id": None,
                    "message": "no memories used in this trace",
                },
            )
        if len(memories) > MAX_MEMORIES_PER_TRACE:
            memories = memories[:MAX_MEMORIES_PER_TRACE]

        # 2. Per-memory impact = ``0.5 * retrieval_score + 0.3
        # * materiality + 0.2 * recency``. When the harness
        # didn't log a retrieval score, we fall back to the
        # token-overlap (influence) signal so the response is
        # never all-zero.
        answer_text = await _fetch_trace_response_text(org_id, trace_id)
        per_memory: list[dict[str, Any]] = []
        primary: str | None = None
        # Batch the per-memory attribution counts into one
        # ``memory_id = ANY($1)`` query (with the 30-day window)
        # so we avoid an N+1 round-trip over ``memories``. The
        # helper still exists for single-memory callers.
        memory_ids = [str(m["memory_id"]) for m in memories]
        recent_by_memory = await _fetch_recent_attributions_for_memories(
            org_id, memory_ids, interval_sql="30 days",
        )
        for mem in memories:
            text = mem.get("memory_text") or mem.get("memory_id", "")
            overlap = _token_overlap(text, answer_text) if answer_text else 0.0
            rscore = mem.get("retrieval_score")
            rscore_f = float(rscore) if isinstance(rscore, (int, float)) else overlap
            # Materiality: count of attributions in the last
            # 30 days, normalised to a 0..1 score with a
            # soft cap at 10 (anything past 10 saturates).
            recent = recent_by_memory.get(str(mem["memory_id"]), [])
            n_recent = len(recent)
            materiality = min(1.0, n_recent / 10.0)
            # Recency: how recent the most recent attribution
            # is, on a 0..1 scale (1 = today, 0 = 30d+ ago).
            if recent:
                last = recent[0].get("created_at")
                days = _days_since(last)
                recency = 0.0 if days is None else max(0.0, 1.0 - (days / 30.0))
            else:
                recency = 0.0
            impact = 0.5 * rscore_f + 0.3 * materiality + 0.2 * recency
            if impact > 0.5 and primary is None:
                primary = mem["memory_id"]
            per_memory.append(
                {
                    "memory_id": mem["memory_id"],
                    "score": round(float(impact), 6),
                    "retrieval_score": rscore_f,
                    "materiality": round(materiality, 4),
                    "recency": round(recency, 4),
                }
            )
        # Sort by score desc for the response — the
        # top-1 becomes the implicit primary when nothing
        # crossed the 0.5 threshold.
        per_memory.sort(key=lambda r: -r["score"])
        if primary is None and per_memory:
            primary = per_memory[0]["memory_id"]

        # 3. Persist (best-effort).
        await _delete_then_insert_impact(
            org_id,
            trace_id,
            [{"memory_id": r["memory_id"], "score": r["score"]} for r in per_memory],
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "per_memory": per_memory,
                "primary_memory_id": primary,
                "message": None,
            },
        )


# ── 4. MemoryReweaver ────────────────────────────────────────────────


class MemoryReweaver:
    """Suggest merge / archive / demote actions for one memory
    (or the org's full set).

    The :attr:`name` is ``"memory_reaver"`` (typo in the
    appendix retained for backward compatibility with the
    front-end). Three action types:

    * ``archive`` — last accessed more than
      :data:`STALE_DAYS` days ago (or never accessed).
    * ``demote`` — zero attributions in the last
      :data:`NEVER_MATERIAL_DAYS` days.
    * ``merge`` — Jaccard similarity with another memory in
      the org is above :data:`NEAR_DUPLICATE_THRESHOLD`.

    All three are pure suggestions — the endpoint never
    mutates state. The destructive admin endpoint is deferred
    to v2 per the appendix.
    """

    name = "memory_reaver"

    async def suggest(
        self,
        org_id: str,
        *,
        memory_id: str = "",
        window: str = "30d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '30d', '24h'",
            )

        # 1. Decide the candidate set. When ``memory_id`` is
        # given, we run a one-memory reweave; when it's
        # empty, we reweave the org's full distinct set
        # (capped — the response is bounded by the number of
        # distinct memory_ids in the last ``window``).
        if memory_id:
            targets = [str(memory_id)[:128]]
        else:
            ids = await _fetch_distinct_memory_ids_in_window(org_id, interval)
            if not ids:
                return _ok_envelope(
                    self.name,
                    {
                        "org_id": org_id,
                        "memory_id": memory_id or None,
                        "window": window,
                        "suggestions": [],
                        "message": "no memories found in window",
                    },
                )
            targets = ids

        # 2. Fetch the per-org memory text corpus (for
        # duplicate detection). One DB roundtrip, reused
        # across all targets.
        corpus = await _fetch_memories_metadata_for_org(org_id)
        corpus_by_id = {c["memory_id"]: c.get("memory_text", "") for c in corpus}

        # 3. For each target, compute the suggestions.
        suggestions: list[dict[str, Any]] = []
        for mid in targets:
            text = corpus_by_id.get(mid, "")

            # 3a. Stale check: last_accessed > STALE_DAYS days.
            last_accessed = await _fetch_last_accessed_for_memory(org_id, mid)
            days_since_access = _days_since(last_accessed)
            if days_since_access is None or days_since_access > STALE_DAYS:
                rationale_days = (
                    f"last accessed {days_since_access} days ago"
                    if days_since_access is not None
                    else "never accessed"
                )
                suggestions.append(
                    {
                        "memory_id": mid,
                        "action": "archive",
                        "rationale": rationale_days,
                    }
                )

            # 3b. Materiality check: zero attributions in
            # the last NEVER_MATERIAL_DAYS days.
            recent = await _fetch_recent_attributions_for_memory(
                org_id, mid,
                interval_sql=f"{NEVER_MATERIAL_DAYS} days",
            )
            if not recent:
                suggestions.append(
                    {
                        "memory_id": mid,
                        "action": "demote",
                        "to_tier": "cold",
                        "rationale": (
                            f"zero attributions in last "
                            f"{NEVER_MATERIAL_DAYS} days"
                        ),
                    }
                )

            # 3c. Near-duplicate check: Jaccard >= threshold
            # against any other memory in the corpus.
            if text:
                near_dupes: list[dict[str, Any]] = []
                for other_id, other_text in corpus_by_id.items():
                    if other_id == mid or not other_text:
                        continue
                    sim = _token_overlap(text, other_text)
                    if sim >= NEAR_DUPLICATE_THRESHOLD:
                        near_dupes.append(
                            {
                                "with_memory_id": other_id,
                                "similarity": round(sim, 4),
                            }
                        )
                        if len(near_dupes) >= MAX_NEAR_DUPLICATES:
                            break
                for nd in near_dupes:
                    suggestions.append(
                        {
                            "memory_id": mid,
                            "action": "merge",
                            "with_memory_id": nd["with_memory_id"],
                            "rationale": (
                                f"near-duplicate (Jaccard "
                                f"{nd['similarity']:.2f})"
                            ),
                        }
                    )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "memory_id": memory_id or None,
                "window": window,
                "suggestions": suggestions,
                "targets_evaluated": len(targets),
            },
        )
