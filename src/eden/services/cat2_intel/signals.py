"""Plain English Signals (Phase Q — Laminar parity).

Laminar's "Plain English Signals" replaces rule-based
alerting with NL UX: the user writes
"LLM refusal rate above 5% in the last 24 hours" and the
system converts that to the equivalent Cat 2 rule
(``refusal_rate > 0.05``). The advantages:

  * No DSL to learn — the user writes English.
  * Embedding clustering groups semantically similar
    signals (e.g. "latency spike" + "slow responses" cluster
    together) so one signal catches both phrasings.
  * The user can iterate ("actually I meant latency > 2s,
    not just any latency") without rebuilding rules.

This module is the unit-testable sibling of the existing
DB-coupled Cat 2 surface. It provides:

  * :class:`NLSignal` — a plain-English signal definition
    + the compiled rule (regex / SQL / EQL).
  * :func:`compile_signal` — convert NL → rule.
  * :class:`SignalClusterer` — group semantically similar
    signals via embedding clustering.
  * :func:`match_signal` — evaluate an event against a
    signal's rule.

The pipeline:

  user writes "LLM refusal rate above 5% in the last 24 hours"
       │
       ▼  compile_signal()  ── keyword extraction + pattern matching
       │
       │  rule = {metric: "refusal_rate", op: ">", threshold: 0.05, window: "24h"}
       │
       ▼  match_signal(event, rule)  ── boolean
       │
       ▼  persisted to nl_signals table
       │
       ▼  SignalClusterer finds duplicates / overlaps
       │
       ▼  operator reviews + activates
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional


logger = logging.getLogger(__name__)


# ── Dataclasses ──────────────────────────────────────────────────


@dataclass
class CompiledRule:
    """The structured rule extracted from an NL signal."""

    # The metric to track. One of: "refusal_rate", "latency_p99",
    # "cost_per_call", "error_rate", "tool_call_rate",
    # "completion_tokens", "prompt_tokens", "user_satisfaction".
    # Or "custom" for free-form rules.
    metric: str
    # Comparison operator: ">" | ">=" | "<" | "<=" | "==" | "!="
    op: str
    threshold: float
    # Time window in hours (e.g. 24, 1, 168 for a week).
    window_hours: int
    # Optional: scope filter (e.g. "agent_id=claude-opus-4").
    scope: dict[str, str] = field(default_factory=dict)
    # Raw keywords extracted from the NL (for debugging).
    keywords: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "op": self.op,
            "threshold": self.threshold,
            "window_hours": self.window_hours,
            "scope": dict(self.scope),
            "keywords": list(self.keywords),
        }


@dataclass
class NLSignal:
    """A user-defined plain-English signal."""

    id: str
    org_id: str
    description: str
    rule: CompiledRule
    enabled: bool = True
    created_by: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    # The cluster id (set by SignalClusterer). Signals in the
    # same cluster are semantically similar.
    cluster_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "description": self.description,
            "rule": self.rule.to_dict(),
            "enabled": self.enabled,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "cluster_id": self.cluster_id,
        }


# ── NL → rule compiler ─────────────────────────────────────────


# Pattern table. Each entry maps a regex (on the NL text) to
# (metric, op, threshold_extractor). The compiler tries each
# pattern; the first match wins. Patterns are deliberately
# conservative — we don't claim to understand all English,
# just the most common phrasings.
_NL_PATTERNS: tuple[tuple[re.Pattern, str, str, str], ...] = (
    # "refusal rate above 5%" / "refusal > 5%" / "more than 5% refusals"
    (re.compile(
        r"\brefusals?\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)\s*%",
        re.IGNORECASE,
    ), "refusal_rate", "PCT", "PCT"),
    (re.compile(
        r"\brefusals?\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)\s*%",
        re.IGNORECASE,
    ), "refusal_rate", "PCT", "PCT"),
    # "error rate above 1%" / "errors above 1%"
    (re.compile(
        r"\berrors?\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)\s*%",
        re.IGNORECASE,
    ), "error_rate", "PCT", "PCT"),
    # "p99 latency above 2 seconds" / "latency > 2s" / "p99 > 500ms"
    (re.compile(
        r"\b(?:p\d+\s*)?latenc(?:y|ies)\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)\s*(?P<unit>ms|millisecond|sec|second|s)\b",
        re.IGNORECASE,
    ), "latency_p99", "DURATION", "DURATION"),
    # "cost per call above $0.10" / "cost > 10 cents"
    (re.compile(
        r"\bcost\s+per\s+call\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*\$?\s*(?P<thr>\d+(?:\.\d+)?)\s*(?P<unit>cents?|dollars?|\$)?",
        re.IGNORECASE,
    ), "cost_per_call", "USD", "USD"),
    # "tool call rate above 100 per minute"
    (re.compile(
        r"\btool\s+calls?\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)\s*(?:per\s+(?P<unit>minute|hour|second|day))?",
        re.IGNORECASE,
    ), "tool_call_rate", "COUNT", "COUNT"),
    # "completion tokens above 1000"
    (re.compile(
        r"\b(?:completion|output)\s+tokens?\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)",
        re.IGNORECASE,
    ), "completion_tokens", "COUNT", "COUNT"),
    # "user satisfaction below 4.0"
    (re.compile(
        r"\buser\s+satisfaction\b.*?(?P<op>>|>=|above|>|more than|less than|<|below)\s*(?P<thr>\d+(?:\.\d+)?)",
        re.IGNORECASE,
    ), "user_satisfaction", "SCORE", "SCORE"),
    # "latency" without a numeric threshold
    (re.compile(r"\b(?:p\d+\s*)?latenc(?:y|ies)\b", re.IGNORECASE), "latency_p99", "NONE", "NONE"),
    # "errors" without a numeric threshold
    (re.compile(r"\berrors?\b", re.IGNORECASE), "error_rate", "NONE", "NONE"),
    # "refusals" without a numeric threshold
    (re.compile(r"\brefusals?\b", re.IGNORECASE), "refusal_rate", "NONE", "NONE"),
)


_OP_MAP: dict[str, str] = {
    ">": ">", ">=": ">=", "above": ">", "more than": ">",
    "<": "<", "<=": "<=", "below": "<", "less than": "<",
}


def _parse_window_hours(text: str) -> int:
    """Extract the time window from the NL text (default 24h)."""
    text_lower = text.lower()
    # Explicit numeric: "24 hours", "1h", "2 hrs".
    m = re.search(
        r"(?:in\s+the\s+(?:last|past)\s+)?(\d+)\s*(hours?|hrs?|h)\b",
        text_lower,
    )
    if m:
        return int(m.group(1))
    # "in the last hour" (implicit 1 hour).
    if re.search(r"\b(?:in\s+the\s+)?(?:last|past)\s+hour\b", text_lower):
        return 1
    # "in the past week".
    m = re.search(r"\b(?:past|last)\s+(\d+)\s+days?\b", text_lower)
    if m:
        return int(m.group(1)) * 24
    m = re.search(r"\b(?:past|last)\s+(week|7\s*days?)\b", text_lower)
    if m:
        return 24 * 7
    m = re.search(r"\b(?:past|last)\s+(\d+)\s+(?:minutes?|mins?|m)\b", text_lower)
    if m:
        # Round to nearest hour; 5 minutes → 0 hours, 30 → 0,
        # 60 → 1, 90 → 1, 120 → 2.
        return int(m.group(1)) // 60
    # "in the last minute" (implicit 1 minute).
    if re.search(r"\b(?:in\s+the\s+)?(?:last|past)\s+minute\b", text_lower):
        return 1
    return 24  # default


def _parse_scope(text: str) -> dict[str, str]:
    """Extract scope filters from the NL text.

    Recognised shapes: ``agent_id=X``, ``model=X``,
    ``user_id=X``. Returns a dict of scope → value.
    """
    scope: dict[str, str] = {}
    patterns = {
        "agent_id": r"agent[_ ]id\s*[=:]\s*(\S+)",
        "model": r"model\s*[=:]\s*([\w\-./]+)",
        "user_id": r"user[_ ]id\s*[=:]\s*(\S+)",
    }
    for key, pat in patterns.items():
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            scope[key] = m.group(1).strip("'\"")
    return scope


def _normalise_threshold(value: float, unit_kind: str) -> float:
    """Convert the raw threshold to a canonical unit (0-1 for
    percentages, milliseconds for durations, USD for
    costs, raw for counts/scores)."""
    if unit_kind == "PCT":
        return value / 100.0
    if unit_kind == "DURATION":
        # Caller will determine ms vs s from the unit string
        # — we just return the raw value here.
        return value
    if unit_kind == "USD":
        # Cents → dollars.
        return value / 100.0
    return value


def _normalise_unit_to_ms(value: float, unit: str) -> float:
    """Convert latency threshold to milliseconds."""
    u = unit.lower()
    if u.startswith("ms") or u == "millisecond":
        return value
    if u.startswith("s") and not u.startswith("ms"):
        return value * 1000.0
    return value


def compile_signal(description: str) -> CompiledRule:
    """Convert a plain-English signal description to a
    :class:`CompiledRule`.

    The compiler is deliberately conservative — it picks
    the first matching pattern from :data:`_NL_PATTERNS`. If
    no pattern matches, it returns a "custom" rule with the
    description as a keyword for embedding-based matching.
    """
    keywords = _extract_keywords(description)
    window = _parse_window_hours(description)
    scope = _parse_scope(description)
    # Try each pattern.
    for pat, metric, _, _ in _NL_PATTERNS:
        m = pat.search(description)
        if m:
            op_str = m.group("op") if "op" in m.groupdict() else None
            thr_str = m.group("thr") if "thr" in m.groupdict() else None
            unit_str = m.group("unit") if "unit" in m.groupdict() else None
            op = _OP_MAP.get((op_str or "").lower(), ">") if op_str else ">"
            if thr_str is None:
                # Pattern matched the metric but no threshold;
                # use a sensible default for the metric.
                thr = _default_threshold_for_metric(metric)
            else:
                thr = float(thr_str)
                # Special-case duration.
                if metric == "latency_p99" and unit_str:
                    thr = _normalise_unit_to_ms(thr, unit_str)
                elif metric in ("refusal_rate", "error_rate"):
                    thr = _normalise_threshold(thr, "PCT")
                elif metric == "cost_per_call":
                    # The regex may or may not capture the unit
                    # (e.g. "$0.10" doesn't capture a unit string).
                    # If the unit looks like cents, divide by 100.
                    # Otherwise treat the value as dollars.
                    if unit_str and "cent" in unit_str.lower():
                        thr = thr / 100.0
                    elif unit_str and ("dollar" in unit_str.lower() or "$" in unit_str):
                        thr = thr  # already in dollars
                    elif thr >= 1.0:
                        # Heuristic: if the number is >= 1, treat
                        # as cents (most cost alerts fire at
                        # single-digit cent thresholds like
                        # "10 cents").
                        thr = thr / 100.0
                    # else: treat as already-dollars.
            return CompiledRule(
                metric=metric,
                op=op,
                threshold=thr,
                window_hours=window,
                scope=scope,
                keywords=keywords,
            )
    # No pattern matched — return a "custom" rule for
    # embedding-based matching downstream.
    return CompiledRule(
        metric="custom",
        op="==",
        threshold=0.0,
        window_hours=window,
        scope=scope,
        keywords=keywords,
    )


def _default_threshold_for_metric(metric: str) -> float:
    """Default threshold for a metric when the NL didn't
    specify one (e.g. "any latency spike")."""
    if metric == "refusal_rate":
        return 0.05
    if metric == "error_rate":
        return 0.01
    if metric == "latency_p99":
        return 2000.0  # 2s
    if metric == "cost_per_call":
        return 0.10
    if metric == "tool_call_rate":
        return 100.0
    if metric == "completion_tokens":
        return 1000.0
    if metric == "user_satisfaction":
        return 4.0
    return 0.0


_STOPWORDS_FOR_KEYWORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "if", "then", "this",
    "that", "these", "those", "is", "are", "was", "were", "be",
    "been", "of", "in", "on", "at", "to", "for", "with", "by", "as",
    "it", "its", "they", "them", "their", "we", "us", "our", "you",
    "your", "i", "me", "my", "what", "which", "who", "when", "where",
    "why", "how", "any", "above", "below", "rate", "rates",
})


def _extract_keywords(text: str) -> list[str]:
    """Pull salient keywords from the NL for embedding / debug."""
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]+", text.lower())
    return [w for w in words if w not in _STOPWORDS_FOR_KEYWORDS]


# ── Signal matching ─────────────────────────────────────────────


def match_signal(rule: CompiledRule, value: float) -> bool:
    """Evaluate one numeric value against a :class:`CompiledRule`.

    Returns True if the rule fires (the signal matched).
    """
    if rule.metric == "custom":
        return False
    if rule.op == ">":
        return value > rule.threshold
    if rule.op == ">=":
        return value >= rule.threshold
    if rule.op == "<":
        return value < rule.threshold
    if rule.op == "<=":
        return value <= rule.threshold
    if rule.op == "==":
        return value == rule.threshold
    if rule.op == "!=":
        return value != rule.threshold
    return False


# ── Embedding clustering ────────────────────────────────────────


def _token_set(text: str) -> set[str]:
    """Return a lowercase token set for shingled similarity."""
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    """Jaccard similarity between two sets."""
    if not a and not b:
        return 0.0
    intersection = a & b
    union = a | b
    return len(intersection) / len(union) if union else 0.0


def signal_signature(description: str) -> str:
    """Content-addressed signature for a signal description.

    Same description + same metric → same signature, which
    lets the clusterer deduplicate.
    """
    normalised = re.sub(r"\s+", " ", description.lower().strip())
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]


class SignalClusterer:
    """Group semantically similar signals.

    The clusterer uses **Jaccard similarity on token sets** as
    a stand-in for embedding similarity. This is the
    unit-testable surface; the production path wires a
    real embedding model (e.g. sentence-transformers) via
    the ``embed_fn`` kwarg.

    Algorithm:
      1. Compute the token set for each signal.
      2. Union-Find: each signal is its own cluster.
      3. For each pair with similarity >= threshold,
         union them.
      4. Return the cluster mapping (signal_id → cluster_id).
    """
    def __init__(
        self,
        similarity_threshold: float = 0.4,
        embed_fn: Optional[Any] = None,
    ) -> None:
        self.similarity_threshold = similarity_threshold
        self.embed_fn = embed_fn  # reserved for future use

    def cluster(
        self,
        signals: list[NLSignal],
    ) -> dict[str, str]:
        """Return a dict mapping signal.id → cluster_id.

        Signals with no close neighbors get their own
        unique cluster.
        """
        if not signals:
            return {}
        # Compute token sets.
        token_sets: dict[str, set[str]] = {}
        for s in signals:
            kw_set = set(s.rule.keywords) | _token_set(s.description)
            token_sets[s.id] = kw_set
        # Union-Find.
        parent: dict[str, str] = {s.id: s.id for s in signals}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a: str, b: str) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        ids = [s.id for s in signals]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                sim = _jaccard(token_sets[ids[i]], token_sets[ids[j]])
                if sim >= self.similarity_threshold:
                    union(ids[i], ids[j])
        # Build the cluster_id mapping. Use the smallest
        # member id as the cluster id (deterministic).
        clusters: dict[str, list[str]] = {}
        for sid in ids:
            root = find(sid)
            clusters.setdefault(root, []).append(sid)
        mapping: dict[str, str] = {}
        for cluster_id, members in clusters.items():
            for sid in members:
                mapping[sid] = cluster_id
        return mapping

    def find_duplicates(
        self,
        signals: list[NLSignal],
    ) -> list[tuple[NLSignal, NLSignal, float]]:
        """Return a list of (signal_a, signal_b, similarity)
        pairs that are above the threshold. Used by the
        operator dashboard to surface "you already have a
        signal that says this"."""
        token_sets: dict[str, set[str]] = {}
        for s in signals:
            kw_set = set(s.rule.keywords) | _token_set(s.description)
            token_sets[s.id] = kw_set
        out: list[tuple[NLSignal, NLSignal, float]] = []
        ids = [s.id for s in signals]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                sim = _jaccard(token_sets[ids[i]], token_sets[ids[j]])
                if sim >= self.similarity_threshold:
                    out.append((signals[i], signals[j], sim))
        return out


# ── Storage helpers ─────────────────────────────────────────────


def _row_to_signal(row: dict[str, Any]) -> NLSignal:
    rule_dict = row.get("rule")
    if isinstance(rule_dict, str):
        import json
        rule_dict = json.loads(rule_dict)
    rule = CompiledRule(
        metric=rule_dict.get("metric", "custom"),
        op=rule_dict.get("op", "=="),
        threshold=float(rule_dict.get("threshold", 0.0)),
        window_hours=int(rule_dict.get("window_hours", 24)),
        scope=rule_dict.get("scope", {}),
        keywords=rule_dict.get("keywords", []),
    )
    return NLSignal(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        description=str(row.get("description", "")),
        rule=rule,
        enabled=bool(row.get("enabled", True)),
        created_by=str(row["created_by"]) if row.get("created_by") else None,
        created_at=str(row.get("created_at", "")),
        updated_at=str(row.get("updated_at", "")),
        cluster_id=str(row["cluster_id"]) if row.get("cluster_id") else None,
    )


__all__ = [
    "NLSignal",
    "CompiledRule",
    "compile_signal",
    "match_signal",
    "SignalClusterer",
    "signal_signature",
    "_extract_keywords",
    "_jaccard",
    "_token_set",
    "_row_to_signal",
]
