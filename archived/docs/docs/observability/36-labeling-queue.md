---
title: "36 — Labeling queue + IAA (Phase D)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 36 — Labeling queue + IAA (Phase D)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Laminar "labeling queue" surface. Three tables
> (labeling_items / annotations / labeling_assignments),
> full service for pop / annotate / skip / export, plus
> Cohen's kappa + Krippendorff's alpha for inter-annotator
> agreement. Pairs with Phase J (synthetic Q/A seeds the
> queue) and Phase S (dataset-as-spreadsheet UI consumes
> the export).
> ~900 LOC backend + 38 unit tests.

## Goal & motivation

Laminar's "labeling queue" is one of their 5 numbered surface
features. The user's question is never "can my annotators
label data?" — every team can. The question is "can my
annotators label data **in Eden** and have that label flow
into a fine-tuning dataset without manual export steps?"
That's the gap Phase D closes.

The Cat 3 HiL surface (HumanInTheLoopService +
PairwiseAnnotationService) is currently STUB. Phase D
replaces it with a real implementation + the IAA math
(Cohen's kappa + Krippendorff's alpha) that lets the
operator see "this annotator agrees with the gold standard
at kappa = 0.78" and decide which labels to promote to
the dataset.

## What's in Eden

### Three tables

| Table | Purpose |
|---|---|
| `labeling_items` | The queue — one row per item to label. Carries `payload` (the content), `label_schema` (the widget spec), `assigned_to` (optional fixed annotator), `required_skills` (for skill-matched routing), `annotations_required` (1-10, default 1). |
| `annotations` | One row per (item, annotator) pair. UNIQUE constraint so a label can be revised but not double-submitted. Carries `label` (JSONB — supports scalar / dict / structured), `confidence` (0-1), `notes`, `time_spent_ms`, `skills_exercised`. |
| `labeling_assignments` | Audit trail: who picked up what, when. Powers the IAA math (overlap of annotators per item). |

### Five label schemas

The `label_schema` JSONB drives the UI widget:

```json
{"type": "thumbs", "options": ["up", "down"]}
{"type": "1-5", "min": 1, "max": 5}
{"type": "pairwise", "options": ["a", "b"]}
{"type": "thumbs-up-down", "options": ["up", "down", "neutral"]}
{"type": "free-text", "max_length": 500}
```

The service stores labels in JSONB. For scalar labels, the
service wraps them in `{"value": x}` so the schema can
evolve without churn. For pairwise, the label is
`{"winner": "a", "margin": 0.3}` so the operator can capture
both the pick + the confidence.

### Pop strategy

The pop service ranks candidates in three priority tiers:

1. **Assigned to me** — items with `assigned_to = me` first.
2. **Skill-matched** — unassigned items with `required_skills`
   that overlap my skills.
3. **Open pool** — unassigned items with no skill requirement
   (any annotator can pick them up).

Each pop creates a `labeling_assignments` row (so we know who
picked up what) and flips the item to `in_progress`.

### Inter-annotator agreement

Two metrics:

**Cohen's kappa** — for two annotators. Chance-corrected
agreement on a 0-1 scale. 1.0 = perfect, 0.0 = chance,
< 0 = anti-correlated. The implementation handles degenerate
cases (single label class) by returning 1.0 for perfect
agreement (mathematically undefined but the intuitive
answer).

**Krippendorff's alpha** — for N annotators with possible
missing values. The implementation uses interval-disagreement
on nominal data; with N=2 and no missing values it
approximates Scott's pi. Returns 1.0 for perfect agreement,
< 0 for anti-correlated.

**Per-pair** — the report also includes per-pair kappas for
every (annotator_a, annotator_b) pair. The operator uses this
to identify which annotator disagrees with the rest of the
team.

### Export

The export endpoint returns JSONL, one line per annotation:

```json
{"item_id": "...", "annotator_id": "...", "label": "up",
 "confidence": 0.8, "notes": "...", "time_spent_ms": 1234,
 "created_at": "2026-06-17T12:00:00+00:00", "payload": {...},
 "source_trace_id": "...", ...}
```

The output is consumable by:
- The Cat 3 dataset_items table (the operator "promotes"
  approved items to a dataset).
- External fine-tuning pipelines (the JSONL is standard
  format).
- The Phase S dataset-as-spreadsheet UI.

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/labeling/items` | yes | Seed a new item |
| `GET` | `/orgs/{org}/labeling/queue/{user_id}` | yes | Pop the next batch |
| `POST` | `/orgs/{org}/labeling/annotate` | yes | Submit / revise |
| `POST` | `/orgs/{org}/labeling/skip` | yes | Mark un-labelable |
| `GET` | `/orgs/{org}/labeling/iia` | yes | Cohen's kappa + Krippendorff's alpha |
| `GET` | `/orgs/{org}/labeling/export` | yes | JSONL of approved labels |

## Example session

```bash
# Seed 10 items from a synthetic Q/A batch (Phase J).
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "payload": {"question": "...", "answer": "..."},
       "label_schema": {"type": "thumbs", "options": ["up", "down"]},
       "annotations_required": 2
     }' \
     https://app.eden.example/orgs/myorg/labeling/items

# Annotator Alice logs in, pops the next 5 items.
curl -H "Authorization: Bearer $JWT" \
     "https://app.eden.example/orgs/myorg/labeling/queue/alice?limit=5"

# Alice submits a label.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "item_id": "...",
       "label": "up",
       "confidence": 0.8,
       "notes": "clear answer"
     }' \
     https://app.eden.example/orgs/myorg/labeling/annotate

# After Bob has also labelled, compute IAA.
curl -H "Authorization: Bearer $JWT" \
     "https://app.eden.example/orgs/myorg/labeling/iia"
# {
#   "kappa": 0.78,
#   "alpha": 0.74,
#   "overall_agreement": 0.85,
#   "item_count": 10,
#   "annotation_count": 20,
#   "per_item": {"item-1": {"kappa": 1.0, "agreement": 1.0}, ...},
#   "per_pair": {"alice|bob": {"kappa": 0.78, "agreement": 0.85, "n": 10}, ...}
# }

# Export approved annotations.
curl -H "Authorization: Bearer $JWT" \
     "https://app.eden.example/orgs/myorg/labeling/export?status=completed" \
     > approved.jsonl
```

## IAA interpretation

| Cohen's kappa | Interpretation |
|---|---|
| < 0 | Worse than chance (annotators are anti-correlated). |
| 0.0 - 0.2 | Slight agreement. |
| 0.2 - 0.4 | Fair agreement. |
| 0.4 - 0.6 | Moderate agreement. |
| 0.6 - 0.8 | Substantial agreement. |
| 0.8 - 1.0 | Almost perfect agreement. |

(Conventional Landis & Koch 1977 thresholds.)

The operator uses IAA to:

1. **Decide when to stop annotating** — when kappa plateaus
   above 0.7, additional annotations have diminishing
   returns.
2. **Identify outlier annotators** — per-pair kappas
   surface the annotator who disagrees with everyone else.
3. **Calibrate the label schema** — low kappa may mean
   the schema is ambiguous (e.g. a 5-point scale when
   annotators can't distinguish 3 from 4).

## RagaAI parity matrix

| RagaAI feature | Eden Phase D | Notes |
|---|---|---|
| Per-user queue | ✅ pop(annotator_id) | Priority tiers: assigned > skill-matched > open |
| Skill-based routing | ✅ required_skills | Array of skill slugs; pop matches by overlap |
| Per-annotator label | ✅ annotations table | UNIQUE on (item, annotator) for revisions |
| Time-spent tracking | ✅ time_spent_ms | Per-annotation metric |
| Confidence scoring | ✅ confidence (0-1) | Per-annotation self-report |
| Cohen's kappa | ✅ cohens_kappa() | Pure-Python, handles degenerate cases |
| Krippendorff's alpha | ✅ krippendorffs_alpha() | N-annotator, missing-value tolerant |
| Per-pair breakdown | ✅ per_pair in IAA report | Identify outlier annotators |
| Export to JSONL | ✅ GET /export | Stdlib fine-tuning format |
| Custom label schema | ✅ label_schema JSONB | thumbs / 1-5 / pairwise / free-text |
| Per-org user skills lookup | 🟡 user_skills callable | Default returns []; production wires to org_members |
| Per-item revision history | 🟡 annotations.updated_at | UNIQUE (item, annotator) so only the latest counts |
| Multi-language label UI | 🟡 via label_schema | The schema is JSONB; a Spanish/EN picker is a UI concern |
| Active learning (auto-pick hardest items) | ❌ deferred | Phase D.5 — pick the items with lowest IAA for re-annotation |

## What's NOT in this phase (deferred)

- **Per-org user skills lookup** — the production wiring
  reads from `org_members` (or a dedicated `org_user_skills`
  table). For now the pop service treats all annotators as
  generalists.
- **Active learning** — auto-select the lowest-IAA items
  for re-annotation. RagaAI has this; the implementation
  needs the IAA report to be authoritative.
- **Revision history** — the annotations table stores the
  latest label; older revisions are not preserved. A
  `label_revisions` table would solve this but is a big
  surface.
- **Multi-modal labels** — image / audio labels. The
  current schema is text-only; the `payload` JSONB can hold
  image URLs, but the UI is text-only.
- **Streaming IAA** — for very long labeling sessions, the
  IAA report is computed on demand. A streaming version
  (kappa that updates as labels come in) is a future
  feature.

## Failure modes

| Failure | Behaviour |
|---|---|
| Empty queue | Returns `[]` |
| Conflicting revisions | UPSERT semantics — last writer wins |
| Annotator submits before pop'ing | Service creates the assignment row on submit (defence-in-depth) |
| Item flips to completed mid-session | `annotations_required` threshold — once met, no more accepts |
| IAA with 0 items | Empty report, kappa=0, alpha=0 |
| IAA with degenerate single-class labels | kappa=1.0 (intuitive), alpha=1.0 |
| Export with 0 completed items | Empty string |
| User skills callable raises | Treated as "generalist" — pop falls through to open pool |
| Confidence out of [0, 1] | 400 `invalid_annotation` |
| Item id not in queue | UPSERT creates the annotation anyway (no foreign-key check) |

## Telemetry

- `labeling.item.seeded` (counter) — fires on `seed()`
- `labeling.item.popped` (counter) — fires on `pop()`
- `labeling.annotation.submitted` (counter) — fires on `annotate()`
- `labeling.item.skipped` (counter) — fires on `skip()`
- `labeling.iaa.computed` (counter) — fires on `compute_iaa()`

These flow into the same pipeline as LLM spans.

## Tests

38 unit tests in `tests/unit/evaluation/test_labeling.py`:

- `TestCohensKappa` (10) — perfect agreement, balanced
  marginals, anti-correlation, partial agreement, single
  class, p_e=1, empty, mismatched lengths, numeric labels,
  three-class.
- `TestKrippendorffsAlpha` (6) — perfect agreement,
  single annotator, missing values, all disagree,
  degenerate single-class, empty.
- `TestAgreementRate` (4) — perfect, partial, empty,
  mismatched lengths.
- `TestLabelScalar` (4) — value dict, winner dict, raw
  scalar, list.
- `TestLabelingService` (12) — seed, pop priority,
  annotate UPSERT, completion threshold, confidence
  validation, skip, IAA perfect / partial / empty, export
  + status filter, pop records assignment.
- `TestIAAReport` (1) — to_dict round-trip.
- (3 more for boundary conditions.)

All 38 pass; 0 regressions in the existing unit suite
(580/580 across the new modules).

## Cross-references

- [Cat 3 — Evaluation Quality Intelligence](03-evaluation-quality-intelligence.md)
  — the destination for promoted annotations.
- [Phase J — Synthetic Q/A Generation](34-synthetic-qa-generation.md)
  — the producer of labeling queue items.
- [Phase S — Dataset-as-Spreadsheet UI](synthetic-qa-generation.md)
  — the consumer of the export.
- [Cat 9 — User Intelligence](09-user-intelligence.md)
  — annotator skill inference (sibling surface).
