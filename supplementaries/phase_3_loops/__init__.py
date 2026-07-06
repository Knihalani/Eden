"""Phase 3 — Loop Detection: 4-detector ensemble.

Detectors (each emits per-step trip booleans):
  1. SHA-256 hash ring on ``(tool_name, sorted_args)``.
  2. Jaccard on k=3 word shingles.
  3. Semantic cosine over real sentence-transformers embeddings.
  4. Page–Hinkley CUSUM on a novelty scalar.

Ensemble rule: trip when **2 of 4 detectors** agree inside a
**5-step rolling window**. Above the threshold the verdict is
``LOOP``; high-severity ``LOOP`` (3+ detectors agreed) maps to
``action=escalate``.

The semantic path loads the real
``sentence-transformers/all-MiniLM-L6-v2`` model from the local
HuggingFace cache (see ``supplementaries/conftest.py``).
"""
