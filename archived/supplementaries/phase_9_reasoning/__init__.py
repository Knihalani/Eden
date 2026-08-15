"""Phase 9 — Reasoning quality scorer.

Surface-level markers (no model required):
  - Premature conclusion ("in conclusion", "finally").
  - Sanity-check markers ("let me verify", "double-check").
  - Self-correction patterns ("actually", "on second thought").
  - Verification markers ("verified", "confirmed").

``score_with_composite`` combines these into a 0–100 reasoning
quality score and is consumed by the Phase 7 detector fan-out.
"""
