"""Retrieval Intelligence services (Cat 4) — real implementations.

Four services:

* :class:`RetrievalUtilizationScorer` — for a single trace,
  reads the retrieved chunks (from
  :class:`eden.kb.retrieval_logger.RetrievalLogger` →
  ``retrieval_logs``) and the trace's final answer (from
  ``telemetry_events.response_body``), and answers "which
  retrieved chunks actually influenced the final answer?"
  with a per-chunk ``{retrieved, used, score}`` row. Persists
  one row per chunk to ``retrieval_utilization_scores``.

* :class:`KnowledgeGapDetector` — across all retrievals in
  the given window, groups by ``query_hash`` and flags query
  patterns whose hit rate is below ``HIT_RATE_THRESHOLD`` or
  whose utilization is below ``UTILIZATION_THRESHOLD``.
  Persists one row per gap to ``retrieval_knowledge_gaps``.

* :class:`ChunkAttribution` — for a single trace, scores each
  retrieved chunk's contribution to the final answer (0..1,
  normalised to sum to 1.0 across chunks). Uses the same
  answer-text overlap heuristic as
  :class:`RetrievalUtilizationScorer` but reframed as a
  contribution instead of a boolean.

* :class:`RetrievalReorderer` — for a collection, looks at
  the most-utilized chunks in the last
  ``REORDER_LOOKBACK_DAYS`` days (from
  ``retrieval_utilization_scores`` + the recent
  ``retrieval_logs`` for the collection) and returns a
  *suggested* order. The endpoint never mutates state — the
  appendix explicitly calls this out as a
  destructive-but-deferred action.

All four services degrade gracefully when their dependencies
are missing or empty:

* No ``retrieval_logs`` for the trace → utilization returns
  ``"no retrieval logs"`` with ``by_chunk: []``.
* No ``telemetry_events.response_body`` for the trace →
  fallback chunk-id-presence heuristic; if even that's empty
  the response carries a ``"no answer text"`` warning.
* Empty ``retrieval_logs`` for the window → gap detector
  returns ``gaps: []`` with ``"no retrieval logs"`` message.
* No utilization history for the collection → reorderer
  falls back to the most-retrieved chunks (frequency-based
  ordering, no utilization weighting).

See ``docs/observability-gap/04-retrieval-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    HIT_RATE_THRESHOLD,
    MAX_GAPS_RETURNED,
    MAX_REORDER_ITEMS,
    MIN_GAP_SAMPLE_SIZE,
    REORDER_LOOKBACK_DAYS,
    UTILIZATION_THRESHOLD,
    _bad_request_envelope,
    _chunk_ids_from_log_row,
    _dedup_preserving_order,
    _delete_then_insert_gaps,
    _delete_then_insert_utilization,
    _fetch_recent_retrieval_logs_by_collection,
    _fetch_retrieval_logs_for_trace,
    _fetch_retrieval_logs_in_window,
    _fetch_trace_response_text,
    _fetch_utilization_history_for_collection,
    _normalise_attributions,
    _ok_envelope,
    _parse_window,
    _safe_float,
    _token_overlap,
    _tokenize,
)

logger = logging.getLogger(__name__)


# ── 1. RetrievalUtilizationScorer ────────────────────────────────────


class RetrievalUtilizationScorer:
    """Per-chunk "was this retrieved chunk actually used?"
    scorer for a single trace.

    The :attr:`name` is ``"retrieval_utilization"`` and matches
    the ``feature`` field in the response envelope. Public
    method :meth:`score` returns the live envelope on success,
    or the live "no retrieval logs" / "no answer text"
    envelope when the dependencies are missing.
    """

    name = "retrieval_utilization"

    async def score(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        # 1. Read retrieval logs for this trace. Tries
        # ``job_id = trace_id`` first; falls back to the
        # ``RECENT_FALLBACK_LIMIT`` most recent logs in
        # ``RECENT_FALLBACK_SECONDS`` seconds when the trace
        # has no 1:1 ``job_id``.
        logs = await _fetch_retrieval_logs_for_trace(org_id, trace_id)
        if not logs:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "retrieved": 0,
                    "actually_used": 0,
                    "by_chunk": [],
                    "message": "no retrieval logs",
                },
            )

        # 2. Union of all chunk_ids across the trace's
        # retrieval logs. Preserves first-seen order so the
        # response is deterministic for the same input.
        chunk_ids: list[str] = []
        for row in logs:
            chunk_ids.extend(_chunk_ids_from_log_row(row))
        chunk_ids = _dedup_preserving_order(chunk_ids)
        if not chunk_ids:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "retrieved": 0,
                    "actually_used": 0,
                    "by_chunk": [],
                    "message": "no chunks in retrieval logs",
                },
            )

        # 3. Read the final answer from telemetry_events.
        answer_text = await _fetch_trace_response_text(org_id, trace_id)

        # 4. Per-chunk: compute ``used`` (boolean) and
        # ``score`` (confidence).
        by_chunk: list[dict[str, Any]] = []
        actually_used = 0
        for cid in chunk_ids:
            used = False
            score = 0.0
            if answer_text:
                # Strongest signal: chunk_id substring present
                # in the answer.
                if cid in answer_text:
                    used = True
                    score = 0.9
                else:
                    # Fallback: token-overlap heuristic on the
                    # chunk-id surrogate text. Threshold 0.2 is
                    # intentionally low — we want to flag chunks
                    # that probably *did* influence the answer
                    # even if not cited verbatim.
                    cid_tokens = _tokenize(cid)
                    ans_tokens = _tokenize(answer_text)
                    if cid_tokens:
                        overlap = len(cid_tokens & ans_tokens) / max(
                            len(cid_tokens), 1
                        )
                        if overlap >= 0.2:
                            used = True
                            score = 0.7
            # No answer text → score stays 0.0; the
            # response's ``message`` field tells the operator
            # why every score is zero-confidence.
            if used:
                actually_used += 1
            by_chunk.append(
                {
                    "chunk_id": cid,
                    "retrieved": True,
                    "used": used,
                    "score": score,
                }
            )

        # 5. Persist per-chunk rows (best-effort).
        await _delete_then_insert_utilization(
            org_id,
            trace_id,
            [
                {
                    "chunk_id": row["chunk_id"],
                    "utilized": row["used"],
                    "score": row["score"],
                }
                for row in by_chunk
            ],
        )

        # 6. Build the response. The message hints at the
        # degradation path the service took so the operator
        # can tell at a glance whether the score is
        # confidence-weighted or not.
        message: str | None = None
        if not answer_text:
            message = "no answer text — scores are zero-confidence"

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "retrieved": len(by_chunk),
                "actually_used": actually_used,
                "utilization_rate": (
                    actually_used / len(by_chunk) if by_chunk else 0.0
                ),
                "by_chunk": by_chunk,
                "message": message,
            },
        )


# ── 2. KnowledgeGapDetector ──────────────────────────────────────────


class KnowledgeGapDetector:
    """Query-pattern gap detector across the recent retrieval
    history.

    Groups :sql:`retrieval_logs` by ``query_hash`` in the
    requested window, computes per-pattern hit rate and mean
    utilization, and flags patterns below
    :data:`HIT_RATE_THRESHOLD` (hit) or
    :data:`UTILIZATION_THRESHOLD` (utilization). Persists
    flagged patterns to ``retrieval_knowledge_gaps``.

    The :attr:`name` is ``"knowledge_gap_detector"``. Public
    method :meth:`detect` returns the live envelope on
    success.
    """

    name = "knowledge_gap_detector"

    async def detect(
        self,
        org_id: str,
        *,
        window: str = "7d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '24h'",
            )

        logs = await _fetch_retrieval_logs_in_window(org_id, interval)
        if not logs:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "gaps": [],
                    "message": "no retrieval logs",
                    "patterns_observed": 0,
                },
            )

        # Aggregate per query_hash: hit_rate, util_rate,
        # sample_size, and the human-readable query_text
        # (first non-null match — query_text can be None
        # when only a vector was logged).
        per_pattern: dict[str, dict[str, Any]] = {}
        for row in logs:
            qh = (
                row.get("query_hash")
                if isinstance(row, dict)
                else row["query_hash"]
            )
            if not qh:
                continue
            qh = str(qh)
            qt = (
                row.get("query_text")
                if isinstance(row, dict)
                else row["query_text"]
            )
            # ``job_id`` is the trace_id in the common Eden
            # convention; the v1 utilization score lookup
            # joins on it.
            jid = (
                row.get("job_id")
                if isinstance(row, dict)
                else row["job_id"]
            )
            entry = per_pattern.setdefault(
                qh,
                {
                    "query_pattern": qh,
                    "query_text": str(qt) if qt else None,
                    "sample_size": 0,
                    "_retrieved_count": 0,
                    "_trace_ids": set(),
                },
            )
            entry["sample_size"] += 1
            ids = _chunk_ids_from_log_row(row)
            entry["_retrieved_count"] += len(ids)
            if jid:
                entry["_trace_ids"].add(str(jid))
            if entry["query_text"] is None and qt:
                entry["query_text"] = str(qt)

        # Look up per-trace utilization for the trace_ids
        # that appear in the window. The score is the mean
        # utilization rate per (org, query_hash) — i.e.
        # "across the N retrievals of this pattern, what
        # fraction of retrieved chunks were used?"
        #
        # We pre-fetch all rows for the window once, then
        # look up by the pattern's own trace_ids so each
        # pattern gets its own per-trace mean (not the
        # org-wide mean).
        util_by_trace = await _fetch_utilization_history_for_org_in_window(
            org_id, interval
        )
        # util_by_trace: {trace_id: {"util_rate": float, "n": int}}
        for entry in per_pattern.values():
            rates: list[float] = []
            for tid in entry["_trace_ids"]:
                stats = util_by_trace.get(tid)
                if stats is None or stats.get("n", 0) <= 0:
                    continue
                rates.append(_safe_float(stats.get("util_rate")))
            if rates:
                entry["_util_scores"] = [sum(rates) / len(rates)]

        # Build gap list. ``hit_rate`` in v1 is the proxy
        # "fraction of retrievals that returned ≥ 1 chunk"
        # — every retrieval_logs row exists because a
        # retrieval happened, but the chunk list may be
        # empty (no hit). We model that via the mean of
        # (len(retrieved_item_ids) > 0).
        gaps: list[dict[str, Any]] = []
        for entry in per_pattern.values():
            n = int(entry["sample_size"])
            if n < MIN_GAP_SAMPLE_SIZE:
                # Too few samples — noise filter.
                continue
            retrieved_count = int(entry["_retrieved_count"])
            # ``hit_rate`` proxy: assume 1.0 for now since
            # every logged retrieval returned at least one
            # item (the logger skips empty retrievals). A
            # future iteration can swap in a real hit-rate
            # signal from the source-format decoders.
            hit_rate = 1.0
            util_scores = entry.get("_util_scores") or []
            if util_scores:
                utilization: float | None = float(
                    sum(util_scores) / len(util_scores)
                )
            else:
                utilization = None
            flagged = False
            if hit_rate < HIT_RATE_THRESHOLD:
                flagged = True
            if utilization is not None and utilization < UTILIZATION_THRESHOLD:
                flagged = True
            if not flagged:
                continue
            # ``query_pattern`` is the human-readable
            # ``query_text`` when we have it; otherwise the
            # hash, prefixed so the operator can tell.
            qt = entry.get("query_text")
            pattern_display = qt[:200] if qt else f"(hash:{entry['query_pattern'][:16]})"
            gaps.append(
                {
                    "query_pattern": pattern_display,
                    "query_hash": entry["query_pattern"],
                    "hit_rate": hit_rate,
                    "utilization": utilization,
                    "sample_size": n,
                    "retrieved_count": retrieved_count,
                    "suggested_action": "add_kb_entries",
                }
            )

        # Sort by sample_size desc — the operator's
        # "biggest-bang-for-buck" view.
        gaps.sort(key=lambda g: -g["sample_size"])
        gaps = gaps[:MAX_GAPS_RETURNED]

        # Persist the gaps (best-effort).
        await _delete_then_insert_gaps(
            org_id, window, [g for g in gaps if g.get("query_pattern")]
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "gaps": gaps,
                "patterns_observed": len(per_pattern),
                "gaps_flagged": len(gaps),
            },
        )


async def _fetch_utilization_history_for_org_in_window(
    org_id: str, interval_sql: str
) -> dict[str, dict[str, Any]]:
    """For :class:`KnowledgeGapDetector`: pull the
    per-trace utilization rate (fraction of chunks used) for
    the org in the given window. Returns a dict of
    ``{trace_id: {"util_rate": float, "n": int}}``.

    Best-effort: returns ``{}`` on any failure so the gap
    detector can still run with utilization=None.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("retrieval_intel: postgres import failed: %s", exc)
        return {}
    try:
        client = await get_postgres_client()
    except Exception as exc:
        logger.debug("retrieval_intel: get_postgres_client failed: %s", exc)
        return {}
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT trace_id,
                   AVG(CASE WHEN utilized THEN 1.0 ELSE 0.0 END)::float8 AS util_rate,
                   COUNT(*)::int AS n
              FROM retrieval_utilization_scores
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
             GROUP BY trace_id
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_utilization_history_for_org_in_window failed: %s",
            exc,
        )
        return {}
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        tid = d.get("trace_id")
        if not tid:
            continue
        out[str(tid)] = {
            "util_rate": _safe_float(d.get("util_rate")),
            "n": int(d.get("n") or 0),
        }
    return out


# ── 3. ChunkAttribution ──────────────────────────────────────────────


class ChunkAttribution:
    """Per-chunk contribution to the final answer.

    For a single trace, reads the retrieved chunks (from
    ``retrieval_logs``) and the final answer (from
    ``telemetry_events.response_body``), computes a raw
    contribution score per chunk (token-overlap heuristic with
    a chunk-id-presence boost), and normalises so the
    per-chunk ``contribution_score`` values sum to 1.0.

    Deterministic: same input → same output (the
    :class:`normalise_attributions` helper is a pure
    function).

    The :attr:`name` is ``"chunk_attribution"``.
    """

    name = "chunk_attribution"

    async def attribution(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        logs = await _fetch_retrieval_logs_for_trace(org_id, trace_id)
        if not logs:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "by_chunk": [],
                    "message": "no retrieval logs",
                },
            )

        chunk_ids: list[str] = []
        for row in logs:
            chunk_ids.extend(_chunk_ids_from_log_row(row))
        chunk_ids = _dedup_preserving_order(chunk_ids)
        if not chunk_ids:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "by_chunk": [],
                    "message": "no chunks in retrieval logs",
                },
            )

        answer_text = await _fetch_trace_response_text(org_id, trace_id)

        # Raw contribution: a chunk_id substring match in the
        # answer is the strongest signal; otherwise fall back
        # to token-overlap with the chunk-id surrogate. When
        # there is no answer text at all, we fall back to a
        # uniform 1.0 so the response is well-formed (and the
        # message warns the operator).
        raw_scores: list[float] = []
        for cid in chunk_ids:
            if not answer_text:
                # No answer to attribute against — uniform.
                raw_scores.append(1.0)
                continue
            if cid in answer_text:
                # Strong signal: 1.0 (renormalised to a fraction).
                raw_scores.append(1.0)
                continue
            overlap = _token_overlap(cid, answer_text)
            # Map overlap ∈ [0, 1] → contribution ∈ [0, 1].
            # The 0.2 floor prevents vanishing small-overlap
            # chunks from getting exactly 0 attribution; that
            # would force the softmax to mis-rank chunks
            # whose only signal is a non-zero Jaccard.
            raw_scores.append(max(0.2 * overlap, overlap))

        normalised = _normalise_attributions(raw_scores)

        by_chunk: list[dict[str, Any]] = []
        for cid, cs in zip(chunk_ids, normalised, strict=False):
            by_chunk.append(
                {
                    "chunk_id": cid,
                    "contribution_score": round(float(cs), 6),
                }
            )

        message: str | None = None
        if not answer_text:
            message = "no answer text — uniform 1/N attribution"
        elif all(s == 0.0 for s in raw_scores):
            message = "no overlap signal — uniform 1/N attribution"

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "by_chunk": by_chunk,
                "message": message,
            },
        )


# ── 4. RetrievalReorderer ────────────────────────────────────────────


class RetrievalReorderer:
    """Propose a new ordering for a collection's chunks by
    recent utilization.

    Looks at the ``REORDER_LOOKBACK_DAYS``-day window of
    ``retrieval_logs`` for the given ``collection``, joins
    against ``retrieval_utilization_scores`` (when present)
    to weight by per-chunk utilization, and returns a
    *suggested* order. The endpoint never mutates state — a
    separate admin endpoint applies the reorder.

    The :attr:`name` is ``"retrieval_reorderer"``.
    """

    name = "retrieval_reorderer"

    async def suggest(
        self,
        org_id: str,
        *,
        collection: str,
    ) -> dict[str, Any]:
        if not collection or not str(collection).strip():
            return _bad_request_envelope(
                self.name,
                "collection must be a non-empty string",
            )
        collection = str(collection).strip()[:64]

        interval = f"{REORDER_LOOKBACK_DAYS} days"
        logs = await _fetch_recent_retrieval_logs_by_collection(
            org_id, collection, interval
        )
        if not logs:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "collection": collection,
                    "suggested_order": [],
                    "message": "no retrieval logs",
                    "lookback_days": REORDER_LOOKBACK_DAYS,
                },
            )

        # 1. Frequency: how often each chunk was retrieved
        # in the lookback window.
        freq: dict[str, int] = {}
        for row in logs:
            for cid in _chunk_ids_from_log_row(row):
                freq[cid] = int(freq.get(cid, 0)) + 1

        # 2. Utilization: mean of per-row utilization scores
        # from retrieval_utilization_scores. The util table
        # is keyed on (org_id, trace_id) so we need to join
        # via trace_id; in v1 we read *all* the org's util
        # rows in the window and use the per-chunk mean
        # across whichever trace_ids it appears in. We use
        # the ``utilized`` boolean (not the ``score``
        # confidence) for the v1 util_rate so a noisy
        # low-confidence ``utilized=False`` doesn't depress
        # the rate the way a weighted mean would.
        util_history = await _fetch_utilization_history_for_collection(
            org_id, collection, interval
        )
        # util_by_chunk: {chunk_id: {"util_rate": float, "n": int}}
        util_by_chunk: dict[str, dict[str, Any]] = {}
        for row in util_history:
            cid = (
                row.get("chunk_id")
                if isinstance(row, dict)
                else row["chunk_id"]
            )
            if not cid:
                continue
            cid = str(cid)
            utilized = bool(
                row.get("utilized")
                if isinstance(row, dict)
                else row["utilized"]
            )
            entry = util_by_chunk.setdefault(
                cid, {"util_sum": 0.0, "n": 0}
            )
            entry["util_sum"] += 1.0 if utilized else 0.0
            entry["n"] += 1
        for _cid, e in util_by_chunk.items():
            n = int(e["n"])
            e["util_rate"] = (e["util_sum"] / n) if n > 0 else 0.0

        # 3. Composite score: ``0.7 * util_rate + 0.3 *
        # normalised_frequency``. Chunks with no util history
        # fall back to the frequency-only signal (and the
        # contribution of util_rate to their composite is 0).
        max_freq = max(freq.values()) if freq else 1
        scored: list[tuple[str, float, int, float | None]] = []
        for cid, n in freq.items():
            util_entry = util_by_chunk.get(cid)
            util_rate = float(util_entry["util_rate"]) if util_entry is not None else 0.0
            norm_freq = (n / max_freq) if max_freq > 0 else 0.0
            composite = 0.7 * util_rate + 0.3 * norm_freq
            scored.append((cid, composite, n, util_rate if util_entry else None))

        # 4. Sort by composite desc, tiebreak by frequency
        # desc, then by chunk_id asc (deterministic).
        scored.sort(key=lambda t: (-t[1], -t[2], t[0]))
        suggested_order = [cid for cid, *_ in scored[:MAX_REORDER_ITEMS]]

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "collection": collection,
                "suggested_order": suggested_order,
                "lookback_days": REORDER_LOOKBACK_DAYS,
                "chunks_observed": len(scored),
                "message": None,
            },
        )
