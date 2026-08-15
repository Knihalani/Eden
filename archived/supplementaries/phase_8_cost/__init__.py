"""Phase 8 — Cost optimisation: multi-tier cache.

Three tiers, in lookup order:
  1. In-memory LRU (process-local, sub-millisecond).
  2. Redis (shared across replicas, single-digit ms).
  3. Response-fingerprint match (content-hash fallback).

The cache key is normalised — case-folded, whitespace-collapsed
and stripped of caller-supplied UUIDs — so semantically equivalent
requests hit the same entry.
"""
