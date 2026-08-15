"""Memory Intelligence (Cat 5) — real implementations.

Four services live in :mod:`eden.kb.episodic.memory_intel.attributor`:

* :class:`~eden.kb.episodic.memory_intel.attributor.MemoryAttributor`
  — per-memory influence scores for a single trace. Persists
  to ``memory_attributions``.
* :class:`~eden.kb.episodic.memory_intel.attributor.MemoryTimelineBuilder`
  — chronological lifecycle (created / updated / deleted /
  accessed) for one memory. Reads from
  ``memory_timeline_events``.
* :class:`~eden.kb.episodic.memory_intel.attributor.MemoryImpactScorer`
  — per-memory impact score (0..1), with the recency +
  materiality weighting. Persists to
  ``memory_impact_scores``.
* :class:`~eden.kb.episodic.memory_intel.attributor.MemoryReweaver`
  — propose merges / archives / demotions. Pure suggestion
  endpoint — never mutates the memory store.

All four services degrade gracefully when their dependencies
are missing or empty (the typical Eden pattern: a "no data"
envelope with a ``message`` hint).

See ``docs/observability-gap/05-memory-intelligence.md``.
"""

from __future__ import annotations

from .attributor import (
    MemoryAttributor,
    MemoryImpactScorer,
    MemoryReweaver,
    MemoryTimelineBuilder,
)

__all__ = [
    "MemoryAttributor",
    "MemoryTimelineBuilder",
    "MemoryImpactScorer",
    "MemoryReweaver",
]
