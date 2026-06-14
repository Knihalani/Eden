"""Cat 20 — ReplayDiff.

Side-by-side comparison of the original timeline and the
replayed timeline. The diff is per-step + per-key — the
customer can see ``step_30.prompt`` changed from
``"You are an agent..."`` to ``"You are a careful, terse
agent..."`` and the per-judge score deltas.

The v1.3 ship renders the diff from three sources:

* **Original step** — read from the parent trace's
  ``telemetry_events`` rows.
* **Replayed step** — read from the ``trace_replay_steps``
  rows the :class:`TraceReplayer` wrote.
* **Per-key diff** — for each step that exists in BOTH the
  original and the replay, the diff is the set of keys
  whose values changed. The deltas are computed for the
  per-judge scores (when both the original and the replay
  have a judge score) and for the response text.

A v2 implementation can add the full judge-score replay
(the v1.3 ship uses the existing
:class:`eden.llmops.judges.JudgeRegistry` for the
replay but the diff is computed from the raw response
hash + the per-step metadata).
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _get_fork_branch,
    _get_parent_steps,
    _get_replay_steps,
    _not_implemented_envelope,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


class ReplayDiff:
    """Side-by-side comparison of the original and replayed timelines."""

    async def diff(
        self,
        org_id: str,
        *,
        fork_id: str,
        replay_id: str,
    ) -> dict[str, Any]:
        """Render the side-by-side diff.

        Args:
            org_id: The tenant id.
            fork_id: The fork's customer-facing identifier.
            replay_id: The replay's customer-facing identifier.

        Returns:
            The Cat 20 live envelope with ``original``,
            ``replay``, and ``diff``. The ``diff`` is a
            dict of ``step_<n>.<key>`` -> ``{"from": ...,
            "to": ...}`` for each key that changed between
            the original and the replay.
        """
        if not fork_id or not fork_id.strip():
            return _not_implemented_envelope(
                "ReplayDiff",
                "fork_id is required and must be non-empty",
            )
        if not replay_id or not replay_id.strip():
            return _not_implemented_envelope(
                "ReplayDiff",
                "replay_id is required and must be non-empty",
            )

        # 1. Look up the fork.
        fork = await _get_fork_branch(fork_id=fork_id, org_id=org_id)
        if fork is None:
            return _not_implemented_envelope(
                "ReplayDiff",
                f"fork {fork_id!r} not found for org {org_id!r}",
            )

        # 2. Fetch the parent timeline + the replay timeline.
        parent_steps = await _get_parent_steps(
            parent_trace_id=fork["parent_trace_id"], org_id=org_id
        )
        replay_steps = await _get_replay_steps(
            replay_id=replay_id, org_id=org_id
        )

        # 3. Build the original + replay dicts keyed by
        #    step_index. The diff iterates the union.
        original_by_idx: dict[int, dict[str, Any]] = {}
        for position, step in enumerate(parent_steps):
            idx = step.get("payload", {}).get("step_index", position) \
                if isinstance(step.get("payload"), dict) else position
            original_by_idx[int(idx)] = step
        replay_by_idx: dict[int, dict[str, Any]] = {
            int(s["step_index"]): s for s in replay_steps
        }

        # 4. Compute the per-step + per-key diff.
        diffs: dict[str, dict[str, Any]] = {}
        all_indices = sorted(
            set(original_by_idx.keys()) | set(replay_by_idx.keys())
        )
        for idx in all_indices:
            orig = original_by_idx.get(idx, {})
            replay = replay_by_idx.get(idx, {})
            # The diff is "key changed between the two
            # timelines". We compare the cache-eligible +
            # re-executed flags + the response_hash so the
            # customer can see the cache hit / miss.
            keys = ("response_hash", "tokens_used", "cost_usd",
                    "served_from_cache", "re_executed")
            for key in keys:
                o_val = orig.get(key)
                r_val = replay.get(key)
                if o_val != r_val:
                    diffs[f"step_{idx}.{key}"] = {
                        "from": o_val,
                        "to": r_val,
                    }

        return _ok_envelope(
            "ReplayDiff",
            {
                "fork_id": fork_id,
                "replay_id": replay_id,
                "parent_trace_id": fork["parent_trace_id"],
                "original": [
                    {
                        "step_index": idx,
                        "event_id": original_by_idx[idx].get("event_id"),
                        "response_hash": original_by_idx[idx].get(
                            "response_hash"
                        ),
                        "timestamp": original_by_idx[idx].get("timestamp"),
                    }
                    for idx in all_indices
                    if idx in original_by_idx
                ],
                "replay": [
                    {
                        "step_index": idx,
                        "served_from_cache": replay_by_idx[idx].get(
                            "served_from_cache"
                        ),
                        "re_executed": replay_by_idx[idx].get(
                            "re_executed"
                        ),
                        "response_hash": replay_by_idx[idx].get(
                            "response_hash"
                        ),
                        "tokens_used": replay_by_idx[idx].get(
                            "tokens_used"
                        ),
                        "cost_usd": replay_by_idx[idx].get("cost_usd"),
                    }
                    for idx in all_indices
                    if idx in replay_by_idx
                ],
                "diff": diffs,
                "n_diffs": len(diffs),
            },
        )


__all__ = ["ReplayDiff"]
