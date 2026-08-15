"""Phase 5 — Hallucination / quality stack.

Recommended local models (all Apache 2.0, no external LLM call):
  - Numeric/AST guard — deterministic-first, <1ms CPU.
  - HHEM-2.1-Open (Vectara) — primary hallucination scorer.
  - MiniCheck-FT5 — borderline tiebreaker.
  - BGE-reranker-v2-m3 — retrieval relevance.

Fusion: max-confidence with deterministic-first ordering. PII
composition: the Cat 10 ``PIIMasker`` runs *before* the quality
stack on real-tenant traffic.
"""
