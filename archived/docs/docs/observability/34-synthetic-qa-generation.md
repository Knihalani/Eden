---
title: "34 — Synthetic Q/A generation (Phase J)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 34 — Synthetic Q/A generation (Phase J)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the RagaAI "synthetic test data" gap. Three Q/A
> styles (extractive / abstractive / multi-hop) generated
> from raw text (PDF / markdown / plain / CSV). Wires
> :class:`FakerVault` to swap real PII in the source for
> deterministic fakes before triples are produced. Pairs
> with Phase D (labeling queue) for human review.
> ~640 LOC backend + 34 unit tests.

## Goal & motivation

The original env-gen pipeline (Phase 1) generated full
RL environments from text — too ambitious, deprecated in
the May 2026 cleanup. But the **synthesize Q/A from
text** piece was kept on the roadmap. RagaAI's "synthetic
Q/A from docs" is the most-cloned feature in the
evaluation-ecosystem space; the user just wants to drop a
PDF into a box and get back (question, answer, context)
triples ready for a fine-tuning dataset.

Phase J ships that. The user can also send the triples
to the Phase D labeling queue for human review, or push
them straight to a Cat 3 dataset.

## What's in Eden

### Three Q/A types

| Type | How it works | Difficulty | Default |
|---|---|---|---|
| **extractive** | Answer is a verbatim sentence from the source; question is templated. | 1 (easy) | ✅ yes |
| **abstractive** | Answer is a paraphrase via LLM (slot=fast, stub-falls-back to extractive). | 2-3 | stub |
| **multi_hop** | Answer is composed of two adjacent chunks; question is templated to require both. | 4 (hard) | opt-in |

The extractive type ships first because it's zero-LLM —
the entire pipeline runs without an OpenRouter call, which
keeps the test suite fast and the cost bounded. The
abstractive type is wired as a stub that falls back to
extractive; the real LLM call lives in the route layer
(``POST /synthetic/generate`` accepts the user's
`llm_client` via the `app.state.llm_client` config — see
the "production wiring" section below).

### Input formats

* `text` — plain text (default)
* `markdown` — same chunker, with paragraph-break awareness
* `csv` — every row's `text_column` becomes a chunk

The chunker is **sentence-aware**: it prefers to break on
`.` / `!` / `?` / `\n\n` boundaries so no answer sentence
is split across chunks. Overlap defaults to 100 chars
(configurable).

### PII swap (FakerVault integration)

Every chunk is run through the FakerVault (Phase K) before
Q/A generation. Real emails / phone numbers / SSNs are
replaced with deterministic fakes. The output is
idempotent — running the same source twice produces the
same fakes.

This is a *defence-in-depth* pass. The production PII
masker (Phase 7.3a + Phase K) is the upstream filter; this
swap is the last line of defence for synthetic data
shipped to customers.

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/synthetic/generate` | yes | Run a generation; returns inline triples |
| `GET` | `/orgs/{org}/synthetic/runs` | yes (501) | List past runs (Phase J.5) |
| `GET` | `/orgs/{org}/synthetic/runs/{id}` | yes (501) | Fetch a run (Phase J.5) |

The list / fetch routes return 501 for now — the
persistence layer is a follow-up that pairs with the Cat
3 dataset promotion endpoint (also deferred).

## Example session

```bash
curl -X POST -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{
       "text": "Apples are red and crunchy. They grow on trees in temperate climates. Bananas are yellow and soft. They grow in tropical climates. Cherries are small and dark red. They grow on bushes.",
       "source_format": "text",
       "qa_type": "extractive",
       "qa_per_chunk": 3,
       "chunk_size": 200,
       "chunk_overlap": 50
     }' \
     https://app.eden.example/orgs/myorg/synthetic/generate
# {
#   "run_id": "...",
#   "qa_type": "extractive",
#   "locale": "en",
#   "triple_count": 9,
#   "triples": [
#     {
#       "id": "qa-a1b2c3d4e5f6g7h8",
#       "question": "What does the source say about Apples?",
#       "answer": "Apples are red and crunchy.",
#       "context": "Apples are red and crunchy. They grow on trees...",
#       "source_chunk_id": "chunk-text-...",
#       "qa_type": "extractive",
#       "difficulty": 1,
#       "source_chunks": ["chunk-text-..."],
#       "tags": ["extractive"]
#     },
#     ...
#   ]
# }
```

The user can then:

1. Pipe `triples` into the Phase D labeling queue for
   human review.
2. Push approved triples to a Cat 3 dataset
   (``POST /datasets/{id}/items``).
3. Export to JSONL for fine-tuning.

## RagaAI parity matrix

| RagaAI feature | Eden Phase J | Notes |
|---|---|---|
| PDF / text / markdown / CSV input | ✅ text, markdown, csv | PDF is a follow-up (textract pipeline) |
| Extractive Q/A | ✅ extractive | 1-20 per chunk |
| Abstractive Q/A (LLM) | 🟡 stub | Real LLM call in route layer; falls back to extractive for tests |
| Multi-hop Q/A | ✅ multi_hop | Adjacent-chunk composition |
| PII anonymization | ✅ FakerVault | Phase K integration |
| Multi-locale (en/es/ar/ja/fr/de/zh) | ✅ FakerVault locales | Per-triple `locale` tag |
| Difficulty rating | ✅ 1-5 | 1=extractive, 4=multi-hop, 5=adversarial (planned) |
| Idempotent rerun | ✅ content-addressed ids | Same input → same qa id |
| Per-triple provenance | ✅ source_chunks[] | Multi-hop records both contributing chunks |
| Dataset promotion | ❌ deferred | Pairs with Cat 3 dataset_items table (J.5) |
| Saved runs | ❌ deferred (501) | Phase J.5 |

## What's NOT in this phase (deferred)

- **PDF input** — RagaAI's headline feature. Requires a
  text-extraction pipeline (PyMuPDF / pdfplumber) +
  layout-aware chunking. The current chunker is text-only.
  Pair with the Phase 0 doc-ingestion pipeline.
- **Real LLM-driven abstractive Q/A** — the route layer
  has a stub. Production wiring requires injecting the
  `app.state.llm_client` and switching the route to use
  the real `OpenRouterClient` with `slot="fast"`. The
  abstractive prompt is documented in
  `_generate_abstractive`'s docstring.
- **Dataset promotion** — `POST /synthetic/runs/{id}/promote`
  to push approved triples to `dataset_items` (Cat 3
  table). Pairs with Phase D's labeling-queue "approve"
  action.
- **Adversarial Q/A** — the "5th difficulty" style that
  injects distractors, negations, and counter-factuals.
  RagaAI has this; defer to Phase L (red-teaming probes)
  since the engine overlaps.
- **Saved runs** — `GET /synthetic/runs` is a 501 stub.
  A future phase persists run metadata (input hash,
  generation params, output stats) to a new
  `synthetic_qa_runs` table.

## Failure modes

| Failure | Behaviour |
|---|---|
| Empty text | Returns `[]` (no triples) |
| Unknown `qa_type` | 400 `unknown_qa_type` |
| `chunk_overlap >= chunk_size` | 400 `chunk_overlap_too_large` |
| LLM call fails (abstractive) | Stub falls back to extractive; production path logs + returns partial |
| PII swap fails (vault not configured) | 500 `vault_unavailable` (the singleton always provides a vault, so this shouldn't happen in practice) |
| CSV missing `text_column` | 400 (route) or `ValueError` (service) |
| Text too short (< 1 sentence) | Returns 0 triples (empty list) |

## Tests

34 unit tests in `tests/unit/data_platform/test_qa_generator.py`:

- `TestChunkText` (8) — empty/short, content-addressed
  ids, overlap produces shared content, sentence
  boundary respect, chunk size + overlap validation,
  source_format propagation.
- `TestExtractive` (8) — triples per chunk, verbatim
  answer, templated question, template round-robin,
  locale propagation, difficulty = 1, source chunk id,
  idempotent ids.
- `TestAbstractive` (3) — stub-falls-back-to-extractive,
  unknown qa_type rejected, all_qa_types sanity.
- `TestMultiHop` (4) — two-chunk composition, difficulty
  = 4, source_chunks records both, short text no multi-hop.
- `TestPIISwap` (4) — email/phone/SSN replaced, format
  respected, deterministic, no real PII survives.
- `TestCSV` (3) — multiple rows, missing column raises,
  empty CSV returns empty.
- `TestDataclassAndHelpers` (4) — to_dict round-trip,
  qa_id content-addressed, topic-of-sentence skips
  stopwords, short-input fallback.

All 34 pass; 0 regressions in the existing
`tests/unit/data_platform/` suite (104/104 total).

## Cross-references

- [Phase K — FakerVault](33-pii-anonymization-upgrades.md)
  — the consumer of this surface.
- [Phase D — Labeling queue](labeling-queue.md) — the
  human-review destination for the generated triples.
- [Cat 3 — Evaluation Quality Intelligence](03-evaluation-quality-intelligence.md)
  — the `dataset_items` table the triples get promoted to.
- [Cat 12 — Experimentation Intelligence](12-experimentation-intelligence.md)
  — the Bayesian experiment recommender that consumes
  the synthetic test sets.
