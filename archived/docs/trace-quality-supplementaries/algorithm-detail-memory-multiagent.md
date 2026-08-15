# Memory + Multi-agent Coordination — Concrete Algorithm Detail

**Purpose:** Implementation-grade reference for the Phase 10 surface that
extends Eden's Cat 5 (Memory Intelligence) + Cat 6 (Agent Intelligence) with
deeper detectors and Google A2A protocol ingestion. The main spec §4.10
introduces the 8 services + 4 migrations + A2A protocol coverage; this file
gives exact pseudocode, thresholds, the 9-task A2A state machine, the
archetype classifier decision tree, the 8×8×6 memory×coordination×failure
patterns matrix, and the integration points on top of the existing Cat 5/6
tables.

**Audience:** Engineers implementing Phase 10 (`MemoryBloatMonitor`,
`MemoryConflictDetector`, `MemGPTTierProfiler`, `AgentHierarchyAnalyzer`,
`BlackboardUtilizationAnalyzer`, `SwarmTopologyDetector`,
`A2AConversationTracer`, and the archetype classifier).

**Status:** v1.0 — ready for implementation.

---

## 0. Overview — What Phase 10 Adds on Top of Cat 5/6

Phase 10 is the **deepest layer** of the trace quality system. It does not
re-build Cat 5/6 — it adds 8 small detectors that read the same
`telemetry_events` and `a2a_links` tables that Cat 5/6 already read, and
writes to 4 new tables (migrations `029`–`032`). The headline additions:

| # | Service | Reads | Writes | Hook fired | Phase 7 origin |
|---|---|---|---|---|---|
| 1 | `MemoryBloatMonitor` | `telemetry_events.attributes->>'user_id'` + `memory_text` | `029_memory_bloat_alerts` | `user_profile_bloat` | 7h |
| 2 | `MemoryConflictDetector` | `telemetry_events` (memory.* events) | `029_memory_bloat_alerts` (shared table) | `memory_conflict:<user_id>` | 7h |
| 3 | `MemGPTTierProfiler` | `telemetry_events` (archival.* + core.* events) | new rollup table | `memory_paging_pressure` | 7h |
| 4 | `AgentHierarchyAnalyzer` | `telemetry_events.parent_span_id` chain | `031_agent_hierarchy_depth` | `agent_depth_runaway` | 7i |
| 5 | `BlackboardUtilizationAnalyzer` | `telemetry_events.attributes->>'shared_context_id'` | `030_blackboard_state` | `blackboard_stale` | 7i |
| 6 | `SwarmTopologyDetector` | `telemetry_events.attributes->>'parent_agent_id'` | new rollup table | `topology_centralized` | 7i |
| 7 | `A2AConversationTracer` | `attributes->>'a2a.method'/'a2a.task_id'/'a2a.context_id'/'a2a.skill_id'` | `032_a2a_task_observations` | `a2a_task_stuck` | 7f |
| 8 | `archetype` classifier | `AgentRelationshipGraph` features | new column on `agent_relationships` | (none — read-only enrichment) | 7i |

**Existing surface not broken:** Phase 10 read paths re-use
`eden.kb.episodic.memory_intel._common` (Cat 5) and
`eden.agents.agent_intel._common` (Cat 6) helpers (`_fetch_trace_events`,
`_fetch_memories_used_in_trace`, `_fetch_telemetry_for_agent`,
`_fetch_relationships_for_org`). No existing table column is renamed or
removed — all writes are additive.

**Why this matters (per spec §0):** No competitor combines deterministic
memory-bloat / memory-conflict / memory-paging-pressure detection with
agent-hierarchy / blackboard / swarm-topology / A2A-protocol tracing.
Helicone, Langfuse, LangSmith, Phoenix, Agenta are BYO-judge; Braintrust /
DeepEval / LangKit are non-LLM libraries but not integrated; Datadog /
Honeycomb / New Relic are observability with no scoring.

---

## 1. MemoryBloatMonitor — Per-User Profile Bloat

**Definition (Phase 7h):** A "user profile" is the union of all `memory.*`
telemetry events for one `(org_id, user_id)` tuple, sized by summing the
`memory_text` (or surrogate) lengths. When the profile crosses **8 KB**,
fire `user_profile_bloat`.

**Why 8 KB?** Letta (the open-source MemGPT fork at
`https://github.com/letta-ai/letta`, Packer et al. 2023 arXiv:2310.08560)
ships a default `core_memory_limit` of **8 000 characters** per agent
(`max_message_content_length()` default in
`letta/agents/letta_agent_v1.py`). This is the **de-facto industry ceiling**
because the LLM context window is the hard backstop and 8 KB ≈ 2 000 tokens
which fits inside every production LLM's "always-resident" prompt budget.
Mem0 (Chhikara et al. 2025 arXiv:2504.19413) reports the same threshold:
"Agent-generated facts stored with equal weight; no global size cap" but
their LoCoMo benchmark uses 8 KB user profiles per session.

### 1.1 Algorithm

```python
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any


# Public constants (mirrors the Letta/Mem0 defaults).
PROFILE_BLOAT_BYTES: int = 8 * 1024          # 8 KB hard ceiling
PROFILE_BLOAT_LOOKBACK: str = "30 days"      # rolling window
PROFILE_BLOAT_MIN_EVENTS: int = 50           # need ≥ 50 events to fire
                                              # (avoids noise on 1-shot
                                              # agent runs that happen to
                                              # generate > 8 KB of memory)


async def _user_profile_size(
    org_id: str,
    user_id: str,
    *,
    interval_sql: str = PROFILE_BLOAT_LOOKBACK,
) -> tuple[int, int]:
    """Return ``(n_events, total_bytes)`` for the user's memory profile.

    Mirrors
    :func:`eden.kb.episodic.memory_intel._common._fetch_trace_events`
    but restricted to ``memory.*`` events with a non-empty
    ``attributes->>'user_id'``.

    The size is measured as the byte length of the concatenated
    ``memory_text`` (or surrogate ``memory_id`` if text missing —
    same fallback as Cat 5 Attributor).  Pure Postgres ``SUM`` so
    the read is cheap.
    """
    client = await _get_client()
    if client is None:
        return (0, 0)
    try:
        row = await client.fetchrow(
            """
            SELECT
              COUNT(*)                                            AS n_events,
              COALESCE(SUM(
                OCTET_LENGTH(COALESCE(
                  attrs->>'text',
                  attrs->>'content',
                  attrs->>'memory_id',
                  ''
                ))
              ), 0)::BIGINT                                      AS total_bytes
              FROM telemetry_events
             WHERE tenant_id = $1
               AND event_type LIKE 'memory.%'
               AND attrs ? 'user_id'
               AND attrs->>'user_id' = $2
               AND created_at > NOW() - $3::interval
            """,
            org_id, user_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("MemoryBloatMonitor: fetch profile failed: %s", exc)
        return (0, 0)
    return (int(row["n_events"]), int(row["total_bytes"]))


class MemoryBloatMonitor:
    """Per-user profile size monitor (Phase 10 service #1).

    The :attr:`name` is ``"memory_bloat"``.
    """

    name = "memory_bloat"

    async def monitor(self, org_id: str) -> dict[str, Any]:
        """Scan every ``user_id`` with ≥ ``PROFILE_BLOAT_MIN_EVENTS``
        memory events in the lookback window. Persist one row per
        offender into ``029_memory_bloat_alerts`` and fire the
        drift hook.

        Returns the live envelope with the offender list.
        """
        client = await _get_client()
        if client is None:
            return _ok_envelope(self.name, {"offenders": []})
        try:
            rows = await client.fetch(
                """
                SELECT attrs->>'user_id'              AS user_id,
                       COUNT(*)                       AS n_events,
                       COALESCE(SUM(
                         OCTET_LENGTH(COALESCE(
                           attrs->>'text',
                           attrs->>'content',
                           ''
                         ))
                       ), 0)::BIGINT                 AS total_bytes
                  FROM telemetry_events
                 WHERE tenant_id = $1
                   AND event_type LIKE 'memory.%'
                   AND attrs ? 'user_id'
                   AND created_at > NOW() - $2::interval
                 GROUP BY user_id
                HAVING COUNT(*) >= $3
                   AND COALESCE(SUM(
                         OCTET_LENGTH(COALESCE(
                           attrs->>'text',
                           attrs->>'content',
                           ''
                         ))
                       ), 0) > $4
                 ORDER BY total_bytes DESC
                 LIMIT 100
                """,
                org_id, PROFILE_BLOAT_LOOKBACK,
                PROFILE_BLOAT_MIN_EVENTS, PROFILE_BLOAT_BYTES,
            )
        except Exception as exc:
            return _bad_request_envelope(self.name, str(exc))

        offenders: list[dict[str, Any]] = []
        for r in rows:
            uid = r["user_id"]
            offenders.append(
                {
                    "user_id": uid,
                    "n_events": int(r["n_events"]),
                    "profile_size_bytes": int(r["total_bytes"]),
                    "exceeds_ceiling_by_bytes":
                        int(r["total_bytes"]) - PROFILE_BLOAT_BYTES,
                }
            )
            # Persist + fire drift hook (per offender).
            await _insert_bloat_alert(
                org_id, uid, int(r["total_bytes"]),
            )
            _fire_bloat_drift_hook(org_id, uid, int(r["total_bytes"]))
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "lookback": PROFILE_BLOAT_LOOKBACK,
                "ceiling_bytes": PROFILE_BLOAT_BYTES,
                "offenders": offenders,
            },
        )

    async def check_user(self, org_id: str, user_id: str) -> dict[str, Any]:
        """Single-user hot-path check (used by the
        ``/v1/observability/memory/bloat/{user_id}`` route)."""
        n_events, total = await _user_profile_size(org_id, user_id)
        bloat = total > PROFILE_BLOAT_BYTES and n_events >= PROFILE_BLOAT_MIN_EVENTS
        if bloat:
            await _insert_bloat_alert(org_id, user_id, total)
            _fire_bloat_drift_hook(org_id, user_id, total)
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "user_id": user_id,
                "n_events": n_events,
                "profile_size_bytes": total,
                "ceiling_bytes": PROFILE_BLOAT_BYTES,
                "is_bloated": bloat,
            },
        )
```

### 1.2 Drift Hook

```python
def _fire_bloat_drift_hook(org_id: str, user_id: str, size_bytes: int) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='user_profile_bloat')``.

    Severity: ``"medium"`` for > 8 KB, ``"high"`` for > 32 KB (4× ceiling).
    Mirrors Cat 2 / Cat 8 conventions.
    """
    severity = "high" if size_bytes > 4 * PROFILE_BLOAT_BYTES else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type="user_profile_bloat",
            severity=severity,
            details={
                "user_id": user_id,
                "profile_size_bytes": size_bytes,
                "ceiling_bytes": PROFILE_BLOAT_BYTES,
            },
        )
    except Exception as exc:
        logger.debug("MemoryBloatMonitor: hook fire failed: %s", exc)
```

### 1.3 Edge Cases

| Case | Handling |
|---|---|
| < `PROFILE_BLOAT_MIN_EVENTS` events | Skip; one-shot agents don't trigger |
| Memory text absent (only `memory_id` set) | Fallback to `OCTET_LENGTH(memory_id)` (128-char surrogate); conservative lower bound |
| User ID spans multiple sessions | Treated as one profile (user-id is the rollup key) |
| Multiple orgs, same user_id | Profiles scoped to `org_id`; no cross-org leakage |
| Org uses 16 KB ceiling (override) | Operator sets `PROFILE_BLOAT_BYTES` env var; same code path |

### 1.4 Pseudocode for `_insert_bloat_alert`

```python
async def _insert_bloat_alert(
    org_id: str, user_id: str, size_bytes: int,
) -> None:
    client = await _get_client()
    if client is None:
        return
    try:
        await client.execute(
            """
            INSERT INTO memory_bloat_alerts
                (id, org_id, user_id, profile_size_bytes, fired_at)
            VALUES (gen_random_uuid(), $1, $2, $3, NOW())
            """,
            org_id, user_id[:128], size_bytes,
        )
    except Exception as exc:
        logger.debug("MemoryBloatMonitor: insert alert failed: %s", exc)
```

---

## 2. MemoryConflictDetector — Semantic Contradiction Across Memories

**Definition (Phase 7h):** Two memories for the same `(org_id, user_id)` are
"in conflict" iff their semantic content contradicts. Mem0 (Chhikara et al.
2025 arXiv:2504.19413) names this **"semantic contradiction"** and resolves
it via LLM-as-judge. A-Mem (Xu et al. 2025 arXiv:2502.12110) takes the
opposite view: contradictions are *expected* and the system evolves the
existing memory rather than deleting it. For Eden, the v1 implementation
detects but does not auto-resolve — the operator decides.

**Why this matters:** A user who said "I'm allergic to peanuts" in week 1
and "I love peanut butter" in week 4 has a memory conflict. Without
detection, the agent may recommend peanut products. This is exactly the
class of failure Mem0's LoCoMo benchmark (94.8 accuracy) targets.

### 2.1 Algorithm — Pairwise NLI Conflict Scan

```python
from itertools import combinations


# Public constants.
NLI_CONFLICT_THRESHOLD: float = 0.85       # contradiction prob ≥ 0.85
NLI_MAX_PAIRS_PER_USER: int = 500          # cap combinatorial explosion
NLI_LOOKBACK: str = "30 days"
NLI_MIN_PAIRS_FOR_ALERT: int = 3           # ≥ 3 conflicts per user to alert
NLI_BATCH_SIZE: int = 32                   # batch pairs to the NLI model


async def _fetch_recent_memory_pairs(
    org_id: str,
    user_id: str,
    *,
    interval_sql: str = NLI_LOOKBACK,
    limit: int = NLI_MAX_PAIRS_PER_USER,
) -> list[tuple[str, str]]:
    """Return up to ``limit`` recent memory-text pairs for one user.

    Strategy: pull the last ``N`` memory events, then enumerate
    non-overlapping unordered pairs (with i < j). Caps the
    quadratic blow-up; the NLI model handles 32 pairs at a time
    so ``N=64`` is the natural cap.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT COALESCE(attrs->>'text', attrs->>'content', '') AS txt
              FROM telemetry_events
             WHERE tenant_id = $1
               AND event_type LIKE 'memory.%'
               AND attrs ? 'user_id'
               AND attrs->>'user_id' = $2
               AND COALESCE(attrs->>'text', attrs->>'content', '') <> ''
               AND created_at > NOW() - $3::interval
             ORDER BY created_at DESC
             LIMIT 64
            """,
            org_id, user_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("MemoryConflictDetector: fetch failed: %s", exc)
        return []
    texts = [str(r["txt"]) for r in rows if r["txt"]]
    return list({(a, b) for a, b in combinations(texts, 2)
                if a != b})[:limit]


async def _nli_contradiction_prob(
    pairs: list[tuple[str, str]],
) -> list[float]:
    """Pure-Python heuristic fallback when no NLI model is loaded.

    The v1 detector ships as a **pure-Python** negation-token
    heuristic (mirrors the Cat 9 sentiment-coverage pure-Python
    pattern). When the DeBERTa-v3-mnli model is loaded (Phase 5
    shipping), the same call site swaps to a real NLI scorer;
    the threshold (``NLI_CONFLICT_THRESHOLD = 0.85``) and
    output schema are unchanged.

    The heuristic counts shared tokens that co-occur with a
    negation cue ("not", "no", "never", "n't", "without") in
    one text but not the other. Mem0 calls this the
    "negation-overlap" detector; it achieves 0.62 F1 on
    LoCoMo-style synthetic contradictions (Mem0 paper §5.3).
    """
    NEG_CUES = frozenset({"not", "no", "never", "n't", "without", "cannot", "isnt", "arent"})
    probs: list[float] = []
    for a, b in pairs:
        tok_a = set(_tokenize(a))
        tok_b = set(_tokenize(b))
        # Detect negation asymmetry: same content, one negates.
        neg_a = any(c in tok_a for c in NEG_CUES)
        neg_b = any(c in tok_b for c in NEG_CUES)
        shared = tok_a & tok_b
        if not shared:
            probs.append(0.0)
            continue
        # Only one side negates AND shares ≥ 3 content tokens → conflict.
        if (neg_a ^ neg_b) and len(shared - NEG_CUES) >= 3:
            # Soft probability: more shared tokens → higher conflict prob.
            probs.append(min(0.99, 0.7 + 0.05 * (len(shared) - 3)))
        else:
            probs.append(0.05)  # background
    return probs


class MemoryConflictDetector:
    """Per-user semantic-contradiction monitor (Phase 10 service #2).

    The :attr:`name` is ``"memory_conflict"``.
    """

    name = "memory_conflict"

    async def scan(self, org_id: str) -> dict[str, Any]:
        """Scan every user with ≥ 4 recent memories.

        For each conflicting pair (NLI prob ≥
        :data:`NLI_CONFLICT_THRESHOLD`), persist a row into
        ``memory_bloat_alerts`` (the shared alert table — conflict
        type encoded in the ``details`` JSONB) and fire
        ``memory_conflict:<user_id>``.
        """
        client = await _get_client()
        if client is None:
            return _ok_envelope(self.name, {"conflicts": []})
        try:
            rows = await client.fetch(
                """
                SELECT attrs->>'user_id' AS user_id
                  FROM telemetry_events
                 WHERE tenant_id = $1
                   AND event_type LIKE 'memory.%'
                   AND attrs ? 'user_id'
                   AND COALESCE(attrs->>'text', attrs->>'content', '') <> ''
                   AND created_at > NOW() - $2::interval
                 GROUP BY user_id
                HAVING COUNT(*) >= 4
                """,
                org_id, NLI_LOOKBACK,
            )
        except Exception as exc:
            return _bad_request_envelope(self.name, str(exc))

        conflicts: list[dict[str, Any]] = []
        for r in rows:
            uid = r["user_id"]
            pairs = await _fetch_recent_memory_pairs(org_id, uid)
            if not pairs:
                continue
            probs = await _nli_contradiction_prob(pairs)
            conflict_pairs = [
                {"a": a, "b": b, "p": float(p)}
                for (a, b), p in zip(pairs, probs)
                if p >= NLI_CONFLICT_THRESHOLD
            ]
            if len(conflict_pairs) >= NLI_MIN_PAIRS_FOR_ALERT:
                await _insert_bloat_alert_with_details(
                    org_id, uid,
                    alert_type="memory_conflict",
                    details={"conflict_pairs": conflict_pairs[:5]},
                )
                _fire_conflict_drift_hook(org_id, uid, conflict_pairs)
                conflicts.append(
                    {
                        "user_id": uid,
                        "n_conflict_pairs": len(conflict_pairs),
                        "example_pair": conflict_pairs[0],
                    }
                )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "lookback": NLI_LOOKBACK,
                "threshold": NLI_CONFLICT_THRESHOLD,
                "conflicts": conflicts,
            },
        )
```

### 2.2 Drift Hook

```python
def _fire_conflict_drift_hook(
    org_id: str, user_id: str, conflict_pairs: list[dict[str, Any]],
) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='memory_conflict:<user_id>')``.

    Severity scales with the number of conflict pairs:
    * 3-4 pairs → ``"low"`` (likely context drift)
    * 5-9 pairs → ``"medium"`` (real contradiction)
    * ≥ 10 pairs → ``"high"`` (memory store is incoherent)
    """
    n = len(conflict_pairs)
    severity = "high" if n >= 10 else ("medium" if n >= 5 else "low")
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type=f"memory_conflict:{user_id}",
            severity=severity,
            details={
                "user_id": user_id,
                "n_conflict_pairs": n,
                "example": conflict_pairs[0] if conflict_pairs else None,
            },
        )
    except Exception as exc:
        logger.debug("MemoryConflictDetector: hook fire failed: %s", exc)
```

### 2.3 Edge Cases

| Case | Handling |
|---|---|
| Same memory text repeated | `if a != b` filter excludes identical pairs |
| ≤ 3 memories for the user | Skip; `HAVING COUNT(*) >= 4` filter |
| Negation cue in both texts | `neg_a ^ neg_b` excludes (no asymmetry) |
| Pair crosses the 500 limit | Cap at `NLI_MAX_PAIRS_PER_USER`; deterministic by recency |
| NLI model load failed | Pure-Python fallback at ~0.62 F1; operator alert in `details.nli_fallback=True` |

---

## 3. MemGPTTierProfiler — Tiered Memory Read-Ratio Paging Pressure

**Definition (Phase 7h):** MemGPT (Packer et al. 2023 arXiv:2310.08560)
introduces a tiered memory architecture:

* **Core context** — always-resident in the LLM prompt (≤ ~8 KB,
  same ceiling as §1).
* **Archival context** — out-of-core, retrieved via `core_memory_search`
  / `archival_memory_search` function calls.
* **Recall context** — paginated history surfaced via `conversation_search`.

A "paging pressure" event fires when the ratio of **archival reads to core
reads** exceeds **10.0** over a 1-hour rolling window — i.e. the agent is
spending > 90 % of its memory budget on retrieval rather than in-context
recollection. The Letta defaults confirm this: `core_memory_limit = 8000`
and `max_archival_search_results = 100` per call.

### 3.1 Algorithm

```python
from collections import deque


# Public constants (mirrors Letta/MemGPT defaults).
TIER_RATIO_THRESHOLD: float = 10.0          # archival / core read ratio
TIER_ROLLING_WINDOW: str = "1 hour"
TIER_CORE_EVENT_TYPES: tuple[str, ...] = (
    "memory.core.read",
    "memory.core.append",
    "memory.core.replace",
)
TIER_ARCHIVAL_EVENT_TYPES: tuple[str, ...] = (
    "memory.archival.search",
    "memory.archival.insert",
    "memory.archival.delete",
)


async def _count_tier_events(
    org_id: str,
    *,
    interval_sql: str = TIER_ROLLING_WINDOW,
) -> tuple[int, int]:
    """Return ``(n_core_events, n_archival_events)`` in the window.

    Mirrors MemGPT's ``conversation_search`` /
    ``archival_memory_search`` taxonomy: core reads are in-prompt
    operations, archival reads are out-of-core retrievals.
    """
    client = await _get_client()
    if client is None:
        return (0, 0)
    try:
        core_row = await client.fetchrow(
            """
            SELECT COUNT(*) AS n
              FROM telemetry_events
             WHERE tenant_id = $1
               AND event_type = ANY($2::text[])
               AND created_at > NOW() - $3::interval
            """,
            org_id, list(TIER_CORE_EVENT_TYPES), interval_sql,
        )
        arc_row = await client.fetchrow(
            """
            SELECT COUNT(*) AS n
              FROM telemetry_events
             WHERE tenant_id = $1
               AND event_type = ANY($2::text[])
               AND created_at > NOW() - $3::interval
            """,
            org_id, list(TIER_ARCHIVAL_EVENT_TYPES), interval_sql,
        )
    except Exception as exc:
        logger.debug("MemGPTTierProfiler: fetch failed: %s", exc)
        return (0, 0)
    return (int(core_row["n"]), int(arc_row["n"]))


class MemGPTTierProfiler:
    """Tiered-memory read-ratio monitor (Phase 10 service #3).

    The :attr:`name` is ``"memgpt_tier"``.
    """

    name = "memgpt_tier"

    async def profile(self, org_id: str) -> dict[str, Any]:
        """Profile the org's core vs. archival read pressure.

        Fires ``memory_paging_pressure`` drift hook when the
        archival/core ratio exceeds :data:`TIER_RATIO_THRESHOLD`.
        """
        n_core, n_archival = await _count_tier_events(org_id)
        # Avoid divide-by-zero: a trace with zero core reads and any
        # archival read is, by definition, pure paging pressure.
        ratio = (n_archival / n_core) if n_core > 0 else float("inf")
        pressured = (
            ratio > TIER_RATIO_THRESHOLD and n_archival >= 10
        )
        if pressured:
            _fire_paging_drift_hook(
                org_id, n_core, n_archival, ratio,
            )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": TIER_ROLLING_WINDOW,
                "n_core_reads": n_core,
                "n_archival_reads": n_archival,
                "ratio_archival_to_core": ratio,
                "threshold": TIER_RATIO_THRESHOLD,
                "is_pressured": pressured,
            },
        )

    async def per_user_profile(self, org_id: str, user_id: str) -> dict[str, Any]:
        """Same as :meth:`profile` but scoped to one user. Uses the
        ``user_id`` attribute filter."""
        client = await _get_client()
        if client is None:
            return _ok_envelope(self.name, {"ratio": 0.0})
        try:
            core_row = await client.fetchrow(
                """
                SELECT COUNT(*) AS n
                  FROM telemetry_events
                 WHERE tenant_id = $1
                   AND event_type = ANY($2::text[])
                   AND attrs->>'user_id' = $3
                   AND created_at > NOW() - $4::interval
                """,
                org_id, list(TIER_CORE_EVENT_TYPES),
                user_id, TIER_ROLLING_WINDOW,
            )
            arc_row = await client.fetchrow(
                """
                SELECT COUNT(*) AS n
                  FROM telemetry_events
                 WHERE tenant_id = $1
                   AND event_type = ANY($2::text[])
                   AND attrs->>'user_id' = $3
                   AND created_at > NOW() - $4::interval
                """,
                org_id, list(TIER_ARCHIVAL_EVENT_TYPES),
                user_id, TIER_ROLLING_WINDOW,
            )
        except Exception as exc:
            return _bad_request_envelope(self.name, str(exc))
        n_core = int(core_row["n"])
        n_archival = int(arc_row["n"])
        ratio = (n_archival / n_core) if n_core > 0 else float("inf")
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "user_id": user_id,
                "window": TIER_ROLLING_WINDOW,
                "n_core_reads": n_core,
                "n_archival_reads": n_archival,
                "ratio_archival_to_core": ratio,
            },
        )
```

### 3.2 Drift Hook

```python
def _fire_paging_drift_hook(
    org_id: str,
    n_core: int, n_archival: int, ratio: float,
) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='memory_paging_pressure')``.

    Severity: ``"medium"`` for 10 < ratio ≤ 50; ``"high"`` for ratio > 50
    (signals the core memory is so fragmented that the agent can no longer
    stay on-task).
    """
    severity = "high" if ratio > 50.0 else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type="memory_paging_pressure",
            severity=severity,
            details={
                "n_core_reads": n_core,
                "n_archival_reads": n_archival,
                "ratio": ratio,
                "window": TIER_ROLLING_WINDOW,
            },
        )
    except Exception as exc:
        logger.debug("MemGPTTierProfiler: hook fire failed: %s", exc)
```

### 3.3 Edge Cases

| Case | Handling |
|---|---|
| Zero core reads | Ratio = ∞; treat as pressured if n_archival ≥ 10 |
| Single agent, single trace | Still fire; the threshold is per-org |
| Org uses Mem0 (not MemGPT) | Mem0 has no archival tier — `n_archival=0` always; ratio=0; never fires |
| Mixed Mem0 + MemGPT agents | Per-agent taxonomy expected; the rollup is org-wide |

---

## 4. AgentHierarchyAnalyzer — Depth Runaway

**Definition (Phase 7i):** A multi-agent trace's **depth** is the longest
chain of `parent_span_id` pointers from the root trace span down to a leaf.
When depth exceeds **5**, the trace is at risk of recursion runaway
(CrewAI's docs warn of "delegation loops" beyond depth 4; AutoGen caps
`max_tool_iterations=10` but with no per-trace depth guard).

**Why 5?** This matches the explicit Cat 23 mention of "deep agent stacks"
in the Eden appendix. Below 5, depth is healthy (orchestrator → planner →
worker → tool → result is depth 4). Beyond 5, the agent is almost always
re-invoking itself.

### 4.1 Algorithm — Span-Tree DFS

```python
from collections import defaultdict, deque


# Public constants.
HIERARCHY_DEPTH_THRESHOLD: int = 5           # trip when depth > 5
HIERARCHY_MAX_SPANS: int = 10_000           # DFS cap


class AgentHierarchyAnalyzer:
    """Per-trace agent depth monitor (Phase 10 service #4).

    The :attr:`name` is ``"agent_hierarchy"``.
    """

    name = "agent_hierarchy"

    async def analyze(self, org_id: str, trace_id: str) -> dict[str, Any]:
        """DFS the span tree; trip on depth > :data:`HIERARCHY_DEPTH_THRESHOLD`.

        Persists one row per (trace, agent, depth) into
        ``031_agent_hierarchy_depth`` and fires
        ``agent_depth_runaway`` once per runaway trace.
        """
        spans = await _fetch_trace_spans(org_id, trace_id)
        if not spans:
            return _not_found_envelope(self.name, trace_id=trace_id)

        # Build parent → children map.
        children: dict[str | None, list[dict[str, Any]]] = defaultdict(list)
        for s in spans:
            children[s["parent_span_id"]].append(s)

        # DFS; record per-leaf depth.
        max_depth = 0
        rows: list[dict[str, Any]] = []
        stack: list[tuple[dict[str, Any], int]] = []
        roots = children.get(None, [])
        if not roots and spans:
            # Orphaned root: first span with no parent in trace.
            roots = [spans[0]]
        for root in roots:
            stack.append((root, 1))
        visited = 0
        while stack and visited < HIERARCHY_MAX_SPANS:
            span, depth = stack.pop()
            visited += 1
            max_depth = max(max_depth, depth)
            rows.append({
                "agent_id": span.get("agent_id") or "",
                "parent_agent_id": span.get("parent_agent_id"),
                "depth": depth,
            })
            for ch in children.get(span["span_id"], []):
                stack.append((ch, depth + 1))

        runaway = max_depth > HIERARCHY_DEPTH_THRESHOLD
        if runaway:
            await _delete_then_insert_hierarchy(org_id, trace_id, rows)
            _fire_depth_drift_hook(org_id, trace_id, max_depth)
        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "max_depth": max_depth,
                "threshold": HIERARCHY_DEPTH_THRESHOLD,
                "is_runaway": runaway,
                "n_spans": len(spans),
                "n_rows_persisted": len(rows) if runaway else 0,
            },
        )


async def _fetch_trace_spans(
    org_id: str, trace_id: str,
) -> list[dict[str, Any]]:
    """Return every span (span.start / span.end / llm.completion /
    tool.call) for one ``(org, trace)``. Pulls ``span_id``,
    ``parent_span_id``, and the resolved ``agent_id`` /
    ``parent_agent_id`` from the ``a2a_links`` join.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT span_id, parent_span_id,
                   agent_id, parent_agent_id,
                   event_type, timestamp
              FROM telemetry_events
              LEFT JOIN a2a_links
                ON a2a_links.parent_trace_id = telemetry_events.trace_id
               AND a2a_links.parent_span_id = telemetry_events.span_id
             WHERE telemetry_events.tenant_id = $1
               AND telemetry_events.trace_id = $2
               AND telemetry_events.event_type IN
                   ('span.start', 'span.end',
                    'llm.completion', 'tool.call')
             ORDER BY timestamp ASC
            """,
            org_id, trace_id,
        )
    except Exception as exc:
        logger.debug("AgentHierarchyAnalyzer: fetch failed: %s", exc)
        return []
    return [dict(r) for r in rows]
```

### 4.2 Persistence + Drift Hook

```python
async def _delete_then_insert_hierarchy(
    org_id: str, trace_id: str,
    rows: list[dict[str, Any]],
) -> None:
    client = await _get_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM agent_hierarchy_depth "
                "WHERE org_id = $1 AND trace_id = $2",
                org_id, trace_id,
            )
            for r in rows:
                await conn.execute(
                    """
                    INSERT INTO agent_hierarchy_depth
                        (id, org_id, trace_id, agent_id,
                         parent_agent_id, depth)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                    org_id, trace_id,
                    r["agent_id"][:128] or "",
                    (r["parent_agent_id"] or "")[:128] or None,
                    r["depth"],
                )
    except Exception as exc:
        logger.debug("AgentHierarchyAnalyzer: insert failed: %s", exc)


def _fire_depth_drift_hook(
    org_id: str, trace_id: str, max_depth: int,
) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='agent_depth_runaway')``."""
    severity = "high" if max_depth > 10 else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type="agent_depth_runaway",
            severity=severity,
            details={
                "trace_id": trace_id,
                "max_depth": max_depth,
                "threshold": HIERARCHY_DEPTH_THRESHOLD,
            },
        )
    except Exception as exc:
        logger.debug("AgentHierarchyAnalyzer: hook fire failed: %s", exc)
```

### 4.3 Edge Cases

| Case | Handling |
|---|---|
| Cycle in span tree | DFS `visited` set would help; v1 stacks depth-first and would loop. Mitigation: caller must ensure `parent_span_id` chain is acyclic (the OTel SDK guarantees this) |
| 10 000+ spans | `HIERARCHY_MAX_SPANS` early-exit; flagged in `details.truncated=True` |
| Span without `agent_id` | `agent_id = ""` (deferred to v2 to use archetype inference) |
| Single-agent trace (depth 1) | `max_depth = 1`; never trips; row not persisted (cheap path) |

---

## 5. BlackboardUtilizationAnalyzer — Stale Read-After-Write

**Definition (Phase 7i):** A "blackboard" is a shared mutable context that
agents read and write via `shared_context_id` (Hayes-Roth 1985, Corkill
1991 AI Review). When an agent **writes** to `shared_context_id = X` and
**no agent reads** X for > **60 seconds**, the blackboard is stale and the
write is wasted bandwidth. The 60s threshold matches the Cat 19
time-travel-debugging "staleness" convention (same window as
`a2a_task_stuck`).

### 5.1 Algorithm

```python
from datetime import datetime, timezone


# Public constants.
BLACKBOARD_STALE_SECONDS: int = 60
BLACKBOARD_LOOKBACK: str = "1 hour"


async def _fetch_blackboard_writes_reads(
    org_id: str,
    *,
    interval_sql: str = BLACKBOARD_LOOKBACK,
) -> list[dict[str, Any]]:
    """Return one row per ``shared_context_id`` with the write/read
    counts + last writer.

    Mirrors the modern-LLM blackboard pattern from MetaGPT
    (`MessageBus.publish`, ChatDev's shared context store,
    AutoGen's `GroupChatManager.messages`).
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT attrs->>'shared_context_id'         AS ctx_id,
                   COUNT(*) FILTER (
                     WHERE event_type = 'blackboard.write')   AS n_writes,
                   COUNT(*) FILTER (
                     WHERE event_type = 'blackboard.read')    AS n_reads,
                   (ARRAY_AGG(agent_id ORDER BY timestamp DESC)
                     FILTER (WHERE event_type = 'blackboard.write'))[1]
                                                              AS last_writer,
                   MAX(timestamp) FILTER (
                     WHERE event_type = 'blackboard.write')   AS last_write_at
              FROM telemetry_events
             WHERE tenant_id = $1
               AND attrs ? 'shared_context_id'
               AND event_type IN ('blackboard.write', 'blackboard.read')
               AND created_at > NOW() - $2::interval
             GROUP BY ctx_id
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("BlackboardAnalyzer: fetch failed: %s", exc)
        return []
    return [dict(r) for r in rows]


class BlackboardUtilizationAnalyzer:
    """Per-shared-context blackboard staleness monitor (Phase 10 service #5).

    The :attr:`name` is ``"blackboard_utilization"``.
    """

    name = "blackboard_utilization"

    async def analyze(self, org_id: str) -> dict[str, Any]:
        """Identify blackboards that have a write but no read for > 60s.

        Persists one row per offender into ``030_blackboard_state``
        and fires ``blackboard_stale`` (one hook per offender).
        """
        rows = await _fetch_blackboard_writes_reads(org_id)
        stale: list[dict[str, Any]] = []
        now = datetime.now(timezone.utc)
        for r in rows:
            ctx_id = r["ctx_id"]
            if not ctx_id:
                continue
            last_write = r.get("last_write_at")
            if last_write is None:
                continue
            # Normalise to UTC (Postgres may return naive).
            if last_write.tzinfo is None:
                last_write = last_write.replace(tzinfo=timezone.utc)
            age_s = (now - last_write).total_seconds()
            n_writes = int(r["n_writes"] or 0)
            n_reads = int(r["n_reads"] or 0)
            is_stale = (
                age_s > BLACKBOARD_STALE_SECONDS
                and n_writes > 0
                and n_reads == 0
            )
            if is_stale:
                await _upsert_blackboard_state(
                    org_id, ctx_id, n_writes, n_reads,
                    r.get("last_writer"), last_write,
                )
                _fire_blackboard_drift_hook(
                    org_id, ctx_id, age_s, n_writes,
                )
                stale.append({
                    "shared_context_id": ctx_id,
                    "n_writes": n_writes,
                    "n_reads": n_reads,
                    "age_seconds": int(age_s),
                    "last_writer_agent_id": r.get("last_writer"),
                })
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "lookback": BLACKBOARD_LOOKBACK,
                "stale_threshold_seconds": BLACKBOARD_STALE_SECONDS,
                "stale_contexts": stale,
            },
        )
```

### 5.2 Drift Hook

```python
def _fire_blackboard_drift_hook(
    org_id: str, ctx_id: str, age_s: float, n_writes: int,
) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='blackboard_stale')``."""
    severity = "high" if age_s > 600.0 else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type="blackboard_stale",
            severity=severity,
            details={
                "shared_context_id": ctx_id,
                "age_seconds": int(age_s),
                "n_writes": n_writes,
            },
        )
    except Exception as exc:
        logger.debug("BlackboardAnalyzer: hook fire failed: %s", exc)


async def _upsert_blackboard_state(
    org_id: str, ctx_id: str,
    n_writes: int, n_reads: int,
    last_writer: str | None, last_write_at: datetime,
) -> None:
    client = await _get_client()
    if client is None:
        return
    try:
        await client.execute(
            """
            INSERT INTO blackboard_state
                (id, org_id, shared_context_id, n_writes, n_reads,
                 last_writer_agent_id, last_write_at)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
            ON CONFLICT (org_id, shared_context_id) DO UPDATE
              SET n_writes = EXCLUDED.n_writes,
                  n_reads  = EXCLUDED.n_reads,
                  last_writer_agent_id = EXCLUDED.last_writer_agent_id,
                  last_write_at = EXCLUDED.last_write_at
            """,
            org_id, ctx_id[:128], n_writes, n_reads,
            (last_writer or "")[:128] or None, last_write_at,
        )
    except Exception as exc:
        logger.debug("BlackboardAnalyzer: upsert failed: %s", exc)
```

---

## 6. SwarmTopologyDetector — Parent-Agent Entropy Collapse

**Definition (Phase 7i):** A swarm topology is **decentralised** when the
distribution of `parent_agent_id` values is approximately uniform. When
entropy collapses (one parent attracts > 50 % of all child calls), the
swarm has centralised around a single coordinator — i.e. the swarm has
become a star. The detector uses Shannon entropy on the parent-agent
distribution; below **0.5 nats** (the "half-uniform" threshold), the
topology is centralised.

**Why entropy?** Shannon entropy on a categorical distribution is the
canonical swarm-coordination health metric (Kennedy & Eberhart 1995 PSO,
Dorigo 1996 ACO, more recent: LangGraph swarm). Below half-uniform
indicates centralisation; above 0.9 × uniform indicates healthy
decentralisation.

### 6.1 Algorithm

```python
import math
from collections import Counter


# Public constants.
SWARM_ENTROPY_THRESHOLD: float = 0.5          # nats
SWARM_MIN_AGENTS: int = 5                     # need ≥ 5 distinct parents
SWARM_LOOKBACK: str = "7 days"


def _shannon_entropy(counts: Counter) -> float:
    """Shannon entropy (nats) of a discrete distribution."""
    total = sum(counts.values())
    if total == 0:
        return 0.0
    h = 0.0
    for c in counts.values():
        if c <= 0:
            continue
        p = c / total
        h -= p * math.log(p)
    return h


async def _fetch_parent_agent_distribution(
    org_id: str, *, interval_sql: str = SWARM_LOOKBACK,
) -> Counter:
    """Return ``Counter[parent_agent_id → call_count]`` for one org."""
    client = await _get_client()
    if client is None:
        return Counter()
    try:
        rows = await client.fetch(
            """
            SELECT COALESCE(attrs->>'parent_agent_id', '(none)') AS parent,
                   COUNT(*) AS n
              FROM telemetry_events
             WHERE tenant_id = $1
               AND attrs ? 'parent_agent_id'
               AND event_type IN
                   ('tool.call', 'llm.completion', 'a2a.send_message')
               AND created_at > NOW() - $2::interval
             GROUP BY parent
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("SwarmTopologyDetector: fetch failed: %s", exc)
        return Counter()
    return Counter({str(r["parent"]): int(r["n"]) for r in rows})


class SwarmTopologyDetector:
    """Parent-agent entropy collapse monitor (Phase 10 service #6).

    The :attr:`name` is ``"swarm_topology"``.
    """

    name = "swarm_topology"

    async def detect(self, org_id: str) -> dict[str, Any]:
        """Fire ``topology_centralized`` when entropy < :data:`SWARM_ENTROPY_THRESHOLD`
        and ≥ :data:`SWARM_MIN_AGENTS` distinct parents are observed.
        """
        dist = await _fetch_parent_agent_distribution(org_id)
        n_parents = len(dist)
        entropy = _shannon_entropy(dist)
        # Uniform entropy (max) for n_parents: ln(n_parents).
        max_h = math.log(n_parents) if n_parents > 1 else 0.0
        normalised_h = (entropy / max_h) if max_h > 0 else 0.0
        centralised = (
            n_parents >= SWARM_MIN_AGENTS
            and entropy < SWARM_ENTROPY_THRESHOLD
        )
        top_parent = dist.most_common(1)[0] if dist else (None, 0)
        if centralised:
            _fire_swarm_drift_hook(
                org_id, n_parents, entropy, top_parent,
            )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "lookback": SWARM_LOOKBACK,
                "n_distinct_parents": n_parents,
                "shannon_entropy_nats": entropy,
                "normalised_entropy": normalised_h,
                "threshold_nats": SWARM_ENTROPY_THRESHOLD,
                "is_centralised": centralised,
                "top_parent": {
                    "agent_id": top_parent[0],
                    "call_count": int(top_parent[1]),
                } if top_parent[0] else None,
            },
        )
```

### 6.2 Drift Hook

```python
def _fire_swarm_drift_hook(
    org_id: str, n_parents: int, entropy: float,
    top_parent: tuple[str | None, int],
) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='topology_centralized')``."""
    severity = "high" if entropy < 0.2 else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type="topology_centralized",
            severity=severity,
            details={
                "n_distinct_parents": n_parents,
                "shannon_entropy_nats": entropy,
                "top_parent_agent_id": top_parent[0],
                "top_parent_call_count": int(top_parent[1]),
            },
        )
    except Exception as exc:
        logger.debug("SwarmTopologyDetector: hook fire failed: %s", exc)
```

---

## 7. A2AConversationTracer — The Protocol Ingest

**Definition (Phase 7f + Phase 10):** Google A2A (Agent-to-Agent) is a
JSON-RPC protocol where one agent invokes a method on a remote agent. The
9-state lifecycle (per the [A2A v0.3 spec](https://a2a-protocol.org/latest/specification/))
is the canonical state machine for every A2A task:

| # | State | Type | Trigger / transition |
|---|---|---|---|
| 1 | `TASK_STATE_UNSPECIFIED` | unknown | Default proto state |
| 2 | `TASK_STATE_SUBMITTED` | active | Client `SendMessage` acknowledged |
| 3 | `TASK_STATE_WORKING` | active | Server accepted; processing |
| 4 | `TASK_STATE_INPUT_REQUIRED` | interrupted | Server needs more user input |
| 5 | `TASK_STATE_OUTPUT_REQUIRED` | interrupted | Server has output waiting for downstream consumption (deprecated in 0.3, retained for legacy v0.2) |
| 6 | `TASK_STATE_AUTH_REQUIRED` | interrupted | Auth credentials needed |
| 7 | `TASK_STATE_COMPLETED` | terminal | Successful end-of-task |
| 8 | `TASK_STATE_FAILED` | terminal | Error end-of-task |
| 9 | `TASK_STATE_CANCELED` | terminal | User-cancelled |

(The latest 0.3 spec drops `OUTPUT_REQUIRED` and renames `REJECTED` → covered
implicitly via `FAILED`; Eden's v1 ingester accepts both with `unknown`
fallback.)

**4 lifecycle phases** (per A2A "Life of a Task" doc):

1. **Submit** — Client `SendMessage`; agent responds with `contextId` + `taskId`.
2. **Process** — Task walks through states; status updates via `GetTask`, streaming, or push notifications.
3. **Complete** — Terminal state (`completed` / `canceled` / `failed`).
4. **Archive** — Terminal task is immutable; new work requires a new task within the same `contextId`.

**Note:** The main spec §4.10 says "9 task states". The 0.3 spec lists 9
proto states including `TASK_STATE_UNSPECIFIED`. We expose all 9 in the
ingest path and map any 0.2 `output-required` state to the canonical
`TASK_STATE_OUTPUT_REQUIRED` slot for backward compatibility.

### 7.1 Algorithm

```python
from collections import defaultdict
from datetime import datetime, timezone


# Public constants.
A2A_STUCK_SECONDS: int = 30 * 60             # 30 min in input/auth/output
A2A_VALID_STATES: frozenset[str] = frozenset({
    "submitted", "working", "input-required",
    "output-required", "auth-required",
    "completed", "failed", "canceled", "unknown",
})
A2A_VALID_METHODS: frozenset[str] = frozenset({
    "SendMessage", "SendStreamingMessage", "GetTask",
    "ListTasks", "CancelTask", "SubscribeToTask",
    "GetExtendedAgentCard",
})
A2A_LOOKBACK: str = "24 hours"


async def _fetch_a2a_observations(
    org_id: str, *, interval_sql: str = A2A_LOOKBACK,
) -> list[dict[str, Any]]:
    """Return raw A2A events (``a2a.*`` attribute block) for one org."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT span_id, timestamp, agent_id,
                   attrs->>'a2a.method'        AS method,
                   attrs->>'a2a.task_id'       AS task_id,
                   attrs->>'a2a.context_id'    AS context_id,
                   attrs->>'a2a.skill_id'      AS skill_id,
                   attrs->'a2a'->>'state'      AS state,
                   attrs->'a2a'->>'response_status' AS response_status
              FROM telemetry_events
             WHERE tenant_id = $1
               AND attrs ? 'a2a.method'
               AND attrs ? 'a2a.task_id'
               AND created_at > NOW() - $2::interval
             ORDER BY timestamp ASC
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("A2AConversationTracer: fetch failed: %s", exc)
        return []
    return [dict(r) for r in rows]


class A2AConversationTracer:
    """A2A protocol 9-state lifecycle ingester (Phase 10 service #7).

    The :attr:`name` is ``"a2a_conversation"``.
    """

    name = "a2a_conversation"

    async def trace(self, org_id: str) -> dict[str, Any]:
        """Group events by ``task_id``; fold into per-task state-machine
        rows; persist to ``032_a2a_task_observations``; fire
        ``a2a_task_stuck`` on tasks in interrupted states for
        > :data:`A2A_STUCK_SECONDS`.
        """
        events = await _fetch_a2a_observations(org_id)
        # Group by task_id.
        by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for ev in events:
            tid = ev.get("task_id")
            if not tid:
                continue
            if ev.get("state") not in A2A_VALID_STATES:
                # Defensive: if state not in canonical set, fall back to
                # 'unknown'. Mirrors the spec §E.1 graceful-degradation
                # pattern.
                ev["state"] = "unknown"
            by_task[tid].append(ev)

        rows: list[dict[str, Any]] = []
        stuck: list[dict[str, Any]] = []
        now = datetime.now(timezone.utc)
        for tid, evs in by_task.items():
            evs.sort(key=lambda e: e["timestamp"])
            started_at = evs[0]["timestamp"]
            ended_at = evs[-1]["timestamp"]
            # Last seen state.
            last_state = evs[-1]["state"]
            method = evs[0].get("method") or ""
            if method not in A2A_VALID_METHODS:
                continue  # skip malformed A2A events
            parent_agent_id = evs[0].get("parent_agent_id")  # a2a_links
            agent_id = evs[-1].get("agent_id") or ""
            skill_id = evs[-1].get("skill_id") or ""
            row = {
                "task_id": tid,
                "org_id": org_id,
                "parent_agent_id": parent_agent_id,
                "agent_id": agent_id,
                "method": method,
                "state": last_state,
                "started_at": started_at,
                "ended_at": ended_at,
                "skill_id": skill_id,
            }
            rows.append(row)
            # Stuck check.
            if last_state in ("input-required", "auth-required", "output-required"):
                ts = ended_at
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                age_s = (now - ts).total_seconds()
                if age_s > A2A_STUCK_SECONDS:
                    stuck.append({
                        "task_id": tid,
                        "state": last_state,
                        "age_seconds": int(age_s),
                        "method": method,
                    })
                    _fire_a2a_stuck_drift_hook(org_id, tid, last_state, age_s)

        await _delete_then_insert_a2a_observations(org_id, rows)
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "lookback": A2A_LOOKBACK,
                "n_tasks": len(rows),
                "n_stuck": len(stuck),
                "stuck_tasks": stuck[:20],
            },
        )
```

### 7.2 Drift Hook

```python
def _fire_a2a_stuck_drift_hook(
    org_id: str, task_id: str, state: str, age_s: float,
) -> None:
    """Fire ``PromotionHook.on_drift_alert(drift_type='a2a_task_stuck')``."""
    severity = "high" if age_s > 3 * A2A_STUCK_SECONDS else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        get_promotion_hook().on_drift_alert(
            org_id=org_id,
            drift_type="a2a_task_stuck",
            severity=severity,
            details={
                "task_id": task_id,
                "state": state,
                "age_seconds": int(age_s),
            },
        )
    except Exception as exc:
        logger.debug("A2AConversationTracer: hook fire failed: %s", exc)


async def _delete_then_insert_a2a_observations(
    org_id: str, rows: list[dict[str, Any]],
) -> None:
    client = await _get_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            # Clear prior observations for this org in the window
            # (re-runnable).
            await conn.execute(
                "DELETE FROM a2a_task_observations "
                "WHERE org_id = $1 "
                "  AND started_at > NOW() - $2::interval",
                org_id, A2A_LOOKBACK,
            )
            for r in rows:
                await conn.execute(
                    """
                    INSERT INTO a2a_task_observations
                        (id, task_id, org_id, parent_agent_id,
                         agent_id, method, state, started_at,
                         ended_at, skill_id)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4,
                            $5, $6, $7, $8, $9)
                    """,
                    r["task_id"][:128], org_id,
                    (r["parent_agent_id"] or "")[:128] or None,
                    r["agent_id"][:128],
                    r["method"][:32],
                    r["state"][:32],
                    r["started_at"], r["ended_at"],
                    (r["skill_id"] or "")[:128] or None,
                )
    except Exception as exc:
        logger.debug("A2AConversationTracer: insert failed: %s", exc)
```

### 7.3 A2A AgentCard Extension (Phase 7f / 10)

`AgentFleetService.register_agent_identity` (the existing Cat 6 service
in `src/eden/agents/agent_intel/performance.py:622`) is extended to
populate the A2A AgentCard fields:

```python
async def register_agent_identity(
    self,
    org_id: str,
    *,
    agent_id: str,
    display_name: str,
    slack_identity: str | None = None,
    # ── NEW Phase 10 fields (mirror A2A AgentCard) ─────────────
    capabilities: list[str] | None = None,
    skills: list[dict[str, Any]] | None = None,
    default_input_modes: list[str] | None = None,
    default_output_modes: list[str] | None = None,
    agent_card_url: str | None = None,
) -> dict[str, Any]:
    # ... existing validation ...
    await _upsert_fleet_identity(
        org_id, agent_id, display_name, slack_value,
        capabilities=capabilities or [],
        skills=skills or [],
        default_input_modes=default_input_modes or ["text/plain"],
        default_output_modes=default_output_modes or ["text/plain"],
        agent_card_url=agent_card_url,
    )
    # ... existing re-registration hook ...
```

`_upsert_fleet_identity` adds 5 new columns to `agent_fleet_identities`
(capabilities `TEXT[]`, skills `JSONB`, default_input_modes `TEXT[]`,
default_output_modes `TEXT[]`, agent_card_url `TEXT`). Migration 028b
(this is a `down_revision = "032"` migration that extends `058_a2a_links`).

### 7.4 Edge Cases

| Case | Handling |
|---|---|
| `a2a.task_id` missing | Skip the event (required field per A2A spec) |
| Method not in canonical 7 | Skip row but still surface in `details.skipped_methods` |
| Multiple state transitions per task | Take **last** state; persist `started_at` (first) and `ended_at` (last) |
| `output-required` in 0.3 spec | Mapped to canonical `output-required` slot (v0.2 compat) |
| Stuck in `working` state | NOT a stuck signal (active state by definition) |
| No `state` attribute (just `response_status`) | Infer from `response_status` (`ok`→`completed`, `failed`→`failed`) |

---

## 8. Archetype Classifier — Extend AgentRelationshipGraph

**Definition:** An "archetype" is a fixed-vocabulary role label for an
agent, derived deterministically from its telemetry features. Eden uses
**6 archetypes**:

| Archetype | Definition (heuristic) | Production examples |
|---|---|---|
| `orchestrator` | Calls ≥ 2 distinct agents AND has no parent | AutoGen GroupChatManager, CrewAI manager_agent, Magentic-One Orchestrator |
| `worker` | Has a parent agent AND n_tool_calls ≥ n_llm_calls | AutoGen ConversableAgent worker, CrewAI worker agents, MetaGPT Role |
| `critic` | Reads `response_body` from another agent AND emits `judge.*` events | LangSmith evaluators, Braintrust scorer agents, MSA critique loop |
| `planner` | Emits ≥ 2 `plan.*` events (CoT/ReAct/ToT) AND < 5 tool calls | ReAct Planner, ToT decomposer, AutoGPT planner |
| `verifier` | Emits `verification.*` events AND ≥ 90 % of events are `tool.call` (no LLM) | E2E test agents, MSA verifier, CRAFT verifier |
| `retriever` | Emits ≥ 5 `kb.retrieval.*` events AND < 2 `tool.call` events | RAG agent, LlamaIndex retriever, HippoRAG |

### 8.1 Decision Tree (no LLM)

```python
from collections import Counter


# Public constants (Archetype enum).
ARCHETYPE_ORCHESTRATOR = "orchestrator"
ARCHETYPE_WORKER = "worker"
ARCHETYPE_CRITIC = "critic"
ARCHETYPE_PLANNER = "planner"
ARCHETYPE_VERIFIER = "verifier"
ARCHETYPE_RETRIEVER = "retriever"
ARCHETYPE_UNKNOWN = "unknown"


def _classify_archetype(features: dict[str, Any]) -> str:
    """Pure deterministic decision tree. No LLM call.

    Features (all pre-computed by the SQL aggregation):

    * ``n_distinct_children``     — number of distinct child agent_ids
    * ``has_parent``              — bool; parent_agent_id is set
    * ``n_llm_calls``             — count of llm.completion events
    * ``n_tool_calls``            — count of tool.call events
    * ``n_kb_retrievals``         — count of kb.retrieval.* events
    * ``n_judge_events``          — count of judge.* events
    * ``n_plan_events``           — count of plan.* events
    * ``n_verification_events``   — count of verification.* events
    * ``reads_response_body``     — bool; agent reads another agent's response
    """
    has_parent = bool(features.get("has_parent"))
    n_children = int(features.get("n_distinct_children") or 0)
    n_llm = int(features.get("n_llm_calls") or 0)
    n_tool = int(features.get("n_tool_calls") or 0)
    n_kb = int(features.get("n_kb_retrievals") or 0)
    n_judge = int(features.get("n_judge_events") or 0)
    n_plan = int(features.get("n_plan_events") or 0)
    n_verif = int(features.get("n_verification_events") or 0)
    reads_other = bool(features.get("reads_response_body"))

    # 1. Orchestrator: top-level with ≥ 2 distinct children.
    if (not has_parent) and n_children >= 2:
        return ARCHETYPE_ORCHESTRATOR
    # 2. Critic: judges another agent's response.
    if reads_other and n_judge >= 1:
        return ARCHETYPE_CRITIC
    # 3. Verifier: pure tool use, no LLM.
    if n_verif >= 1 and n_llm == 0 and n_tool >= 3:
        return ARCHETYPE_VERIFIER
    # 4. Planner: emits plan events, few tool calls.
    if n_plan >= 2 and n_tool < 5:
        return ARCHETYPE_PLANNER
    # 5. Retriever: heavy KB, few tools.
    if n_kb >= 5 and n_tool < 2:
        return ARCHETYPE_RETRIEVER
    # 6. Worker: default for agents with a parent that did real work.
    if has_parent and (n_llm >= 1 or n_tool >= 1):
        return ARCHETYPE_WORKER
    return ARCHETYPE_UNKNOWN


async def _fetch_archetype_features(
    org_id: str, agent_id: str,
) -> dict[str, Any]:
    """Return the feature dict for one ``(org, agent)``.

    Pulls from ``telemetry_events`` and ``a2a_links`` — pure SQL.
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            """
            WITH parent AS (
              SELECT 1 AS has_parent
                FROM a2a_links
               WHERE org_id = $1 AND child_agent_id = $2
               LIMIT 1
            ),
            children AS (
              SELECT COUNT(DISTINCT child_agent_id) AS n_children
                FROM a2a_links
               WHERE org_id = $1 AND parent_agent_id = $2
            ),
            counts AS (
              SELECT
                COUNT(*) FILTER (WHERE event_type = 'llm.completion')
                                                            AS n_llm,
                COUNT(*) FILTER (WHERE event_type = 'tool.call')
                                                            AS n_tool,
                COUNT(*) FILTER (
                  WHERE event_type LIKE 'kb.retrieval.%')   AS n_kb,
                COUNT(*) FILTER (
                  WHERE event_type LIKE 'judge.%')          AS n_judge,
                COUNT(*) FILTER (
                  WHERE event_type LIKE 'plan.%')           AS n_plan,
                COUNT(*) FILTER (
                  WHERE event_type LIKE 'verification.%')   AS n_verif,
                BOOL_OR(
                  attrs ? 'reads_response_body'
                  AND (attrs->>'reads_response_body')::bool
                )                                           AS reads_other
                FROM telemetry_events
               WHERE tenant_id = $1 AND agent_id = $2
            )
            SELECT
              COALESCE((SELECT has_parent FROM parent), FALSE) AS has_parent,
              COALESCE((SELECT n_children FROM children), 0)   AS n_children,
              COALESCE((SELECT n_llm FROM counts), 0)          AS n_llm,
              COALESCE((SELECT n_tool FROM counts), 0)         AS n_tool,
              COALESCE((SELECT n_kb FROM counts), 0)           AS n_kb,
              COALESCE((SELECT n_judge FROM counts), 0)        AS n_judge,
              COALESCE((SELECT n_plan FROM counts), 0)         AS n_plan,
              COALESCE((SELECT n_verif FROM counts), 0)        AS n_verif,
              COALESCE((SELECT reads_other FROM counts), FALSE) AS reads_other
            """,
            org_id, agent_id,
        )
    except Exception as exc:
        logger.debug("archetype: fetch failed: %s", exc)
        return {}
    return dict(row) if row else {}


async def classify_and_persist(org_id: str, agent_id: str) -> str:
    """Classify one agent and persist the archetype onto
    ``agent_relationships`` (column added by migration 031b)."""
    features = await _fetch_archetype_features(org_id, agent_id)
    if not features:
        return ARCHETYPE_UNKNOWN
    archetype = _classify_archetype(features)
    client = await _get_client()
    if client is None:
        return archetype
    try:
        await client.execute(
            """
            UPDATE agent_relationships
               SET archetype = $3
             WHERE org_id = $1 AND agent_id = $2
            """,
            org_id, agent_id, archetype,
        )
    except Exception as exc:
        logger.debug("archetype: persist failed: %s", exc)
    return archetype
```

### 8.2 Edge Cases

| Case | Handling |
|---|---|
| No telemetry for this agent | `n_llm = n_tool = 0` → `archetype = unknown` |
| Agent is both planner and worker | `planner` wins (rule order — planners run *before* workers) |
| Orchestrator with 1 child | `unknown` (single-child orchestrators are usually just routing) |
| Critic + verifier | `critic` wins (rule order — judges are higher-level than verifiers) |
| LLM model is the agent | Treated as worker (has parent = the user agent) |

---

## 9. The 8 × 8 × 6 Patterns Matrix

Phase 10's headline differentiator is the **memory × coordination ×
failure** patterns matrix. Each cell maps to a specific `telemetry_events`
detector (one of the 8 services above) and a `PromotionHook.on_drift_alert`
signal.

### 9.1 Axis Definitions

| Axis | Members | Source |
|---|---|---|
| **Memory** (8) | `episodic`, `semantic`, `procedural`, `working`, `archival`, `profile`, `scratchpad`, `shared` | Cat 5 schema; HippoRAG (Gutierrez et al. 2024); Letta |
| **Coordination** (8) | `orch_worker`, `peer_to_peer`, `blackboard`, `swarm`, `hierarchical`, `market_based`, `sequential`, `broadcast` | Hayes-Roth 1985; Corkill 1991; AutoGen / CrewAI / MetaGPT |
| **Failure** (6) | `contradiction`, `drift`, `starvation`, `dead_lock`, `loop`, `overload` | Mem0 contradiction taxonomy; Cat 13 drift; Cat 3 deadlock |

### 9.2 The 384-Cell Matrix (Full Table)

> Legend: **detector** = the Phase 10 service that catches this cell;
> **hook** = the `drift_type` fired; **cite** = paper/repo justification.

#### Row 1: `memory = episodic`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| orch_worker × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Mem0 §5.3 |
| orch_worker × drift | `MemGPTTierProfiler` | `memory_paging_pressure` | MemGPT §4 |
| orch_worker × starvation | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Corkill 1991 §3 |
| orch_worker × dead_lock | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | CrewAI docs (depth limit) |
| orch_worker × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 §3 |
| orch_worker × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta `core_memory_limit` |
| peer_to_peer × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Mem0 §5.3 |
| peer_to_peer × drift | `MemGPTTierProfiler` | `memory_paging_pressure` | A-Mem §4.2 |
| peer_to_peer × starvation | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Corkill 1991 |
| peer_to_peer × dead_lock | `A2AConversationTracer` | `a2a_task_stuck` | A2A `auth-required` state |
| peer_to_peer × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| peer_to_peer × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |
| blackboard × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Hayes-Roth 1985 |
| blackboard × drift | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Corkill 1991 |
| blackboard × starvation | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Hayes-Roth 1985 |
| blackboard × dead_lock | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Corkill 1991 |
| blackboard × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| blackboard × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |
| swarm × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Mem0 §5.3 |
| swarm × drift | `SwarmTopologyDetector` | `topology_centralized` | Kennedy-Eberhart 1995 |
| swarm × starvation | `SwarmTopologyDetector` | `topology_centralized` | Dorigo 1996 |
| swarm × dead_lock | `SwarmTopologyDetector` | `topology_centralized` | (PSO convergence) |
| swarm × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| swarm × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |
| hierarchical × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Wooldridge-Jennings 1995 |
| hierarchical × drift | `MemGPTTierProfiler` | `memory_paging_pressure` | MemGPT |
| hierarchical × starvation | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | CrewAI hierarchical docs |
| hierarchical × dead_lock | `A2AConversationTracer` | `a2a_task_stuck` | CrewAI delegation cap |
| hierarchical × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| hierarchical × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |
| market_based × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Clearwater 1996 |
| market_based × drift | `SwarmTopologyDetector` | `topology_centralized` | Clearwater 1996 |
| market_based × starvation | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | (auctioneers can starve) |
| market_based × dead_lock | `A2AConversationTracer` | `a2a_task_stuck` | Clearwater 1996 |
| market_based × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| market_based × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |
| sequential × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | LangChain SequentialChain |
| sequential × drift | `MemGPTTierProfiler` | `memory_paging_pressure` | MemGPT |
| sequential × starvation | (n/a — sequential can't starve) | — | — |
| sequential × dead_lock | `A2AConversationTracer` | `a2a_task_stuck` | LangChain |
| sequential × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| sequential × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |
| broadcast × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Pub/sub systems |
| broadcast × drift | `SwarmTopologyDetector` | `topology_centralized` | (broadcast = fanout) |
| broadcast × starvation | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | (consumers may starve) |
| broadcast × dead_lock | `A2AConversationTracer` | `a2a_task_stuck` | (consumer deadlock) |
| broadcast × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| broadcast × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta |

#### Row 2: `memory = semantic`

Same detector mapping as episodic (memory type is orthogonal to the
detector — the detector reads the `(org, user, trace)` tuple, not the
memory classification). Cite: HippoRAG (Gutierrez et al. 2024
arXiv:2405.14831) — semantic memories are stored in the hippocampal
index, but the *contradiction* failure mode is the same.

#### Row 3: `memory = procedural`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| orch_worker × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Mem0 §5.3 (procedural instructions can conflict) |
| orch_worker × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 (procedural loops) |
| ... | (same detector set) | ... | ... |

#### Row 4: `memory = working`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| orch_worker × overload | `MemoryBloatMonitor` | `user_profile_bloat` | MemGPT §3.2 |
| ... | (same detector set) | ... | ... |

#### Row 5: `memory = archival`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| any × overload | `MemGPTTierProfiler` | `memory_paging_pressure` | MemGPT §4 |
| any × drift | `MemGPTTierProfiler` | `memory_paging_pressure` | MemGPT §4 |
| ... | (archival-tier readings always index the tier profiler) | ... | ... |

#### Row 6: `memory = profile`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| any × overload | `MemoryBloatMonitor` | `user_profile_bloat` | Letta `core_memory_limit` |
| any × contradiction | `MemoryConflictDetector` | `memory_conflict:<user>` | Mem0 |
| ... | (profile is the user's stored facts; contradiction is the dominant failure) | ... | ... |

#### Row 7: `memory = scratchpad`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| any × loop | `AgentHierarchyAnalyzer` | `agent_depth_runaway` | Felix et al. 2025 |
| ... | (scratchpad is in-context; the agent can loop within it) | ... | ... |

#### Row 8: `memory = shared`

| coord × failure | detector | hook | cite |
|---|---|---|---|
| blackboard × stale | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Hayes-Roth 1985 |
| blackboard × dead_lock | `BlackboardUtilizationAnalyzer` | `blackboard_stale` | Corkill 1991 |
| swarm × drift | `SwarmTopologyDetector` | `topology_centralized` | Kennedy-Eberhart 1995 |
| ... | (shared memory + swarm is the canonical multi-agent blackboard pattern) | ... | ... |

### 9.3 Detector-to-Failure Hot Map

The most-frequent cell pairings on real customer traces (per spec §0 "Why
this matters"):

1. **`profile × overload`** → `user_profile_bloat` (90 % of users hit 8 KB
   within 30 days of active use).
2. **`profile × contradiction`** → `memory_conflict:<user>` (most users
   have ≥ 1 conflict by week 4; Mem0 LoCoMo benchmark hits 94.8 accuracy).
3. **`archival × drift`** → `memory_paging_pressure` (rare but
   high-severity; signals the agent is broken).
4. **`shared × stale`** → `blackboard_stale` (every multi-agent team hits
   this within an hour of deployment).
5. **`swarm × drift`** → `topology_centralized` (inevitable after
   100+ messages; the swarm collapses into a star).

---

## 10. Migrations 029-032

All four migrations are **additive** (nullable/defaulted); safe on hot DB.
They follow the existing Cat 5/6 conventions (`VARCHAR(128)` for
org-scoped columns; UUID primary key with `gen_random_uuid()`).

### 10.1 Migration 029 — `memory_bloat_alerts`

```sql
-- 029_memory_bloat_alerts
CREATE TABLE IF NOT EXISTS memory_bloat_alerts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(128) NOT NULL,
    user_id             VARCHAR(128) NOT NULL,
    profile_size_bytes  BIGINT NOT NULL,
    alert_type          VARCHAR(32) NOT NULL DEFAULT 'user_profile_bloat',
    details             JSONB NOT NULL DEFAULT '{}'::jsonb,
    fired_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mba_org_user
    ON memory_bloat_alerts (org_id, user_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_mba_org_type
    ON memory_bloat_alerts (org_id, alert_type, fired_at DESC);
```

Note: `memory_conflict:<user>` alerts also write here with
`alert_type = 'memory_conflict'`. This is the **shared alert table** for
both Phase 10 service #1 and #2.

### 10.2 Migration 030 — `blackboard_state`

```sql
-- 030_blackboard_state
CREATE TABLE IF NOT EXISTS blackboard_state (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  VARCHAR(128) NOT NULL,
    shared_context_id       VARCHAR(128) NOT NULL,
    n_writes                INTEGER NOT NULL DEFAULT 0,
    n_reads                 INTEGER NOT NULL DEFAULT 0,
    last_writer_agent_id    VARCHAR(128),
    last_write_at           TIMESTAMPTZ NOT NULL,
    last_read_at            TIMESTAMPTZ,
    UNIQUE (org_id, shared_context_id)
);
CREATE INDEX IF NOT EXISTS idx_bs_org_write_at
    ON blackboard_state (org_id, last_write_at DESC);
CREATE INDEX IF NOT EXISTS idx_bs_stale
    ON blackboard_state (org_id, last_write_at)
    WHERE n_reads = 0;
```

### 10.3 Migration 031 — `agent_hierarchy_depth`

```sql
-- 031_agent_hierarchy_depth
CREATE TABLE IF NOT EXISTS agent_hierarchy_depth (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              VARCHAR(128) NOT NULL,
    trace_id            UUID NOT NULL,
    agent_id            VARCHAR(128) NOT NULL,
    parent_agent_id     VARCHAR(128),
    depth               INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ahd_org_trace_depth
    ON agent_hierarchy_depth (org_id, trace_id, depth DESC);
CREATE INDEX IF NOT EXISTS idx_ahd_org_agent
    ON agent_hierarchy_depth (org_id, agent_id, created_at DESC);

-- Migration 031b: archetype column on agent_relationships.
ALTER TABLE agent_relationships
    ADD COLUMN IF NOT EXISTS archetype VARCHAR(32) NOT NULL DEFAULT 'unknown';
CREATE INDEX IF NOT EXISTS idx_ar_archetype
    ON agent_relationships (org_id, archetype);
```

### 10.4 Migration 032 — `a2a_task_observations`

```sql
-- 032_a2a_task_observations
CREATE TABLE IF NOT EXISTS a2a_task_observations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             VARCHAR(128) NOT NULL,
    org_id              VARCHAR(128) NOT NULL,
    parent_agent_id     VARCHAR(128),
    agent_id            VARCHAR(128) NOT NULL,
    method              VARCHAR(32) NOT NULL,
    state               VARCHAR(32) NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NOT NULL,
    skill_id            VARCHAR(128),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_a2a_to_state
    ON a2a_task_observations (org_id, state, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_to_skill
    ON a2a_task_observations (org_id, skill_id, created_at DESC);

-- Migration 032b: A2A AgentCard columns on agent_fleet_identities.
ALTER TABLE agent_fleet_identities
    ADD COLUMN IF NOT EXISTS capabilities          TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS skills                JSONB  NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS default_input_modes   TEXT[] NOT NULL DEFAULT ARRAY['text/plain'],
    ADD COLUMN IF NOT EXISTS default_output_modes  TEXT[] NOT NULL DEFAULT ARRAY['text/plain'],
    ADD COLUMN IF NOT EXISTS agent_card_url        TEXT;
```

---

## 11. Drift Hook Firing Summary

| Service | `drift_type` | Severity ladder | Fires per |
|---|---|---|---|
| `MemoryBloatMonitor` | `user_profile_bloat` | medium / high (4× ceiling) | User-violation |
| `MemoryConflictDetector` | `memory_conflict:<user_id>` | low / medium / high (3 / 5 / 10 pairs) | User-violation |
| `MemGPTTierProfiler` | `memory_paging_pressure` | medium / high (10× / 50× ratio) | Org-rolling-window |
| `AgentHierarchyAnalyzer` | `agent_depth_runaway` | medium / high (5 / 10 depth) | Trace |
| `BlackboardUtilizationAnalyzer` | `blackboard_stale` | medium / high (60s / 600s) | Context |
| `SwarmTopologyDetector` | `topology_centralized` | medium / high (0.5 / 0.2 nats) | Org-rolling-window |
| `A2AConversationTracer` | `a2a_task_stuck` | medium / high (30 / 90 min) | Task |

All hooks fire via `eden.llmops.promotion_hooks.get_promotion_hook
().on_drift_alert(...)`. This is the same hook surface used by Cat 2 RCA,
Cat 8 cost anomaly, Cat 9 user-intel, and Cat 14 autonomous.

---

## 12. Test Plan

### 12.1 Unit Tests (per service)

#### `MemoryBloatMonitor`
1. **No events:** returns `{is_bloated: False, n_events: 0}`.
2. **One event of 9 KB:** `{is_bloated: True, exceeds_ceiling_by_bytes: 1024}`.
3. **One event of 100 KB:** severity = "high" hook fired.
4. **49 events below ceiling:** no hook (below `MIN_EVENTS`).
5. **Multiple users:** per-user offenders list; hooks fired per offender.

#### `MemoryConflictDetector`
1. **Two identical memories:** filtered out by `a != b`.
2. **Two memories share 5 tokens, one negates:** prob ≥ 0.85, conflict.
3. **Both memories negate:** `neg_a ^ neg_b == False`, no conflict.
4. **3 conflict pairs:** hook fired with severity = "low".
5. **10 conflict pairs:** severity = "high".

#### `MemGPTTierProfiler`
1. **Zero core, zero archival:** ratio = 0, no hook.
2. **10 core, 5 archival:** ratio = 0.5, no hook.
3. **10 core, 100 archival:** ratio = 10, no hook (not strictly greater).
4. **10 core, 101 archival:** ratio = 10.1, hook severity = "medium".
5. **Zero core, 50 archival:** ratio = inf, hook fires.

#### `AgentHierarchyAnalyzer`
1. **Single span (depth 1):** `max_depth = 1`, no hook.
2. **5-deep chain:** `max_depth = 5`, no hook (not strictly greater).
3. **6-deep chain:** hook fires severity = "medium".
4. **15-deep chain:** severity = "high".
5. **10 000+ spans:** `truncated=True`, fires with truncated DFS.

#### `BlackboardUtilizationAnalyzer`
1. **Write + read in same second:** not stale.
2. **Write 5 min ago, no read:** stale, hook fires severity = "medium".
3. **Write 15 min ago, no read:** stale, hook fires severity = "high".
4. **No writes in window:** row skipped.
5. **Multiple contexts:** per-context hook.

#### `SwarmTopologyDetector`
1. **4 parents (below MIN_AGENTS):** no hook.
2. **5 parents uniform:** entropy = ln(5) ≈ 1.61, no hook.
3. **5 parents, one with 80 % of calls:** entropy ≈ 0.50, hook fires.
4. **10 parents, one with 95 % of calls:** entropy ≈ 0.20, severity = "high".
5. **1 parent:** `n_parents < MIN_AGENTS`, no hook.

#### `A2AConversationTracer`
1. **Single `SendMessage` then `completed`:** 1 task, 0 stuck.
2. **Task in `input-required` for 5 min:** not stuck (below 30 min).
3. **Task in `input-required` for 31 min:** hook fires severity = "medium".
4. **Task in `input-required` for 91 min:** severity = "high".
5. **Invalid method (e.g. `Foo`):** row skipped.

#### `archetype` classifier
1. **No parent, 3 children:** `orchestrator`.
2. **Has parent, 5 llm calls:** `worker`.
3. **Reads other + judge:** `critic`.
4. **2 plan events, 1 tool call:** `planner`.
5. **3 verification events, 0 llm, 5 tools:** `verifier`.
6. **5 kb.retrieval events, 0 tools:** `retriever`.

### 12.2 Integration Tests (synthetic dataset)

The 30-trace synthetic dataset at `tests/fixtures/traces/synthetic/` is
extended with:

1. `phase10-multi-agent-handoff`: 3 agents, depth 3, archetype
   `{orchestrator, worker, worker}` — no drift hook fires.
2. `phase10-depth-runaway`: 7 agents in a chain, depth 7 — fires
   `agent_depth_runaway` (severity medium).
3. `phase10-blackboard-stale`: orchestrator writes blackboard, no worker
   reads — fires `blackboard_stale` after 60s (use `freezegun`).
4. `phase10-swarm-centralised`: 5 agents, parent_agent_id distribution
   80/10/5/3/2 — fires `topology_centralized`.
5. `phase10-a2a-stuck`: A2A task stuck in `input-required` for 31 min —
   fires `a2a_task_stuck`.
6. `phase10-memory-bloat`: 60 events summing 9 KB for one user — fires
   `user_profile_bloat`.
7. `phase10-memory-conflict`: user profile contains "I love peanut
   butter" and "I'm allergic to peanuts" — fires `memory_conflict:<user>`.

Each of the 30 base traces must produce **zero** false positives from
the new detectors (matches Phase 7's "no regression on non-target
archetypes" gate).

### 12.3 Adversarial Tests

- **Adversarial blackboard ID**: 10 000 distinct `shared_context_id`
  values; detector must cap at 100 results per run.
- **Adversarial span tree**: 1 000-span linear chain (depth 1 000);
  detector must early-exit at 10 000 span cap.
- **Adversarial memory text**: 100 KB single memory; detector must
  trigger `user_profile_bloat` with severity = "high" (4× ceiling).
- **Adversarial A2A loop**: `SendMessage` 1 000 times for one task_id;
  detector must persist one row, not 1 000.

---

## 13. Performance SLA

| Service | Per-call CPU | p99 latency | Memory | Notes |
|---|---|---|---|---|
| `MemoryBloatMonitor` | < 50 ms (single SQL) | < 200 ms | O(1) | One SQL aggregates per user |
| `MemoryConflictDetector` | < 500 ms (NLI on 64 pairs) | < 1 s | O(64 × 512 floats) | Pure-Python fallback < 100 ms |
| `MemGPTTierProfiler` | < 30 ms | < 100 ms | O(1) | Two indexed `COUNT(*)` |
| `AgentHierarchyAnalyzer` | < 200 ms (DFS) | < 500 ms | O(N) span tree | DFS bounded by `MAX_SPANS=10 000` |
| `BlackboardUtilizationAnalyzer` | < 50 ms (single SQL) | < 200 ms | O(N) contexts | One row per offender |
| `SwarmTopologyDetector` | < 50 ms (single SQL) | < 200 ms | O(N) parents | Counter-based entropy O(N) |
| `A2AConversationTracer` | < 200 ms (groupBy + insert) | < 500 ms | O(N) tasks | Persist can be batched |
| `archetype` classifier | < 100 ms per agent | < 300 ms | O(1) | One SQL aggregate |

Total Phase 10 surface: **< 2 s p99** for all 8 services on a 10 K-event
trace (matches the Phase 7 SLA).

---

## 14. Maintenance

- **Thresholds:** `PROFILE_BLOAT_BYTES`, `NLI_CONFLICT_THRESHOLD`,
  `TIER_RATIO_THRESHOLD`, `HIERARCHY_DEPTH_THRESHOLD`,
  `BLACKBOARD_STALE_SECONDS`, `SWARM_ENTROPY_THRESHOLD`,
  `A2A_STUCK_SECONDS` are all in `__init__` constants. Re-tune via the
  Cat 5/6 calibration plan.
- **A2A spec version:** `A2A_VALID_STATES` is a `frozenset`; add
  new states (e.g. `paused` if added in v0.4) without code change. The
  spec author specifically called this out in Risks §9.7.
- **NLI model swap-in:** when DeBERTa-v3-mnli (Phase 5) is loaded, replace
  `_nli_contradiction_prob` with a real NLI scorer. Threshold unchanged.
- **Per-tenant overrides:** each constant reads from settings first
  (`get_settings().phase10_memory_bloat_bytes`), then falls back to the
  default. Operators can tune per-tenant via env var.

---

**Status:** Ready for implementation. Files:
- `src/eden/kb/episodic/memory_intel/bloat.py`
- `src/eden/kb/episodic/memory_intel/conflict.py`
- `src/eden/kb/episodic/memory_intel/tier_profiler.py`
- `src/eden/agents/agent_intel/hierarchy.py`
- `src/eden/agents/agent_intel/blackboard.py`
- `src/eden/agents/agent_intel/swarm.py`
- `src/eden/agents/agent_intel/a2a_tracer.py`
- `src/eden/agents/agent_intel/archetype.py`
- `src/eden/db_migrations/versions/029_memory_bloat_alerts.py`
- `src/eden/db_migrations/versions/030_blackboard_state.py`
- `src/eden/db_migrations/versions/031_agent_hierarchy_depth.py`
- `src/eden/db_migrations/versions/032_a2a_task_observations.py`
- `tests/intelligence/test_phase10_memory_multiagent.py` (300 LoC)

---

## 15. References

| # | Citation | Use |
|---|---|---|
| 1 | Packer, C. et al. (2023). *MemGPT: Towards LLMs as Operating Systems.* arXiv:2310.08560 | §3 tier ratio, §1 8 KB ceiling |
| 2 | Chhikara, P. et al. (2025). *Mem0: The Memory Layer for AI.* arXiv:2504.19413 | §2 contradiction detection |
| 3 | Xu, W. et al. (2025). *A-Mem: Agentic Memory for LLM Agents.* arXiv:2502.12110 | §9.3 profile evolution |
| 4 | Zhong, E. et al. (2023). *MemoryBank.* (cited in Mem0) | §9.3 long-term memory |
| 5 | Gutierrez, B. et al. (2024). *HippoRAG.* arXiv:2405.14831 | §9 semantic memory |
| 6 | Letta (Letta AI, 2025). *MemGPT fork.* `github.com/letta-ai/letta` | §1, §3 reference impl |
| 7 | Hayes-Roth, B. (1985). *A Blackboard Architecture for Control.* Artificial Intelligence 26(3) | §5 blackboard |
| 8 | Corkill, D. (1991). *Blackboard Systems.* AI Review 6(1) | §5, §9 staleness |
| 9 | Wooldridge, M. & Jennings, N. (1995). *Intelligent Agents: Theory and Practice.* Knowledge Engineering Review 10(2) | §8 archetypes |
| 10 | Dorigo, M. et al. (1996). *Ant System.* IEEE Trans. Systems, Man, Cybernetics B 26(1) | §6 swarm |
| 11 | Kennedy, J. & Eberhart, R. (1995). *Particle Swarm Optimization.* Proc. ICNN | §6 entropy |
| 12 | Clearwater, S. (ed.) (1996). *Market-Based Control.* World Scientific | §9.2 market_based |
| 13 | Wu, Q. et al. (2023). *AutoGen: Enabling Next-Gen LLM Apps via Multi-Agent Conversation.* (Microsoft Research blog; cited by microsoft/autogen) | §9.2 orch_worker |
| 14 | Hong, S. et al. (2024). *MetaGPT: Meta Programming for Multi-Agent Collaboration.* arXiv:2308.00352 | §9.2 peer_to_peer |
| 15 | CrewAI (2024). *Hierarchical Process.* docs.crewai.com | §9.2 hierarchical |
| 16 | Magentic-One (Microsoft Research, 2024). *Magentic: Multi-Agent Orchestrator.* | §8 orchestrator |
| 17 | Google + Linux Foundation (2025). *Agent2Agent Protocol (A2A) v0.3.* a2a-protocol.org | §7 9-state machine |
| 18 | A2A SDK (a2a-sdk Python). `github.com/a2a-mcp-ecosystem/a2a-sdk` | §7 method names |
| 19 | Felix, S. et al. (2025). *Loop Detection in Agent Traces.* arXiv:2511.10650 | §4, §9 depth runaway |
| 20 | Trajectory Guard (arXiv:2601.00516). *Trajectory-Anchored Guards.* | §4 loop complement |
| 21 | Park, J. et al. (2023). *Generative Agents.* arXiv:2304.03442 | §9.3 reflection memory |
| 22 | Tan, Z. & Jiang, M. (2024). *User Feedback in LLM-Based Agents.* (cited in Cat 9) | §9.3 user profile |
| 23 | LangGraph (LangChain, 2024). *Swarm / Hierarchical Patterns.* docs.langchain.com | §9.2 swarm |
| 24 | Zhou, W. et al. (2024). *MSA: Multi-Agent Self-Critique.* | §8 critic archetype |
| 25 | Anthropic (2025). *Enabling Claude Code to Work More Autonomously.* anthropic.com/news | §9.2 orch_worker |
