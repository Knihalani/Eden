# Labeling unification — annotation queue ↔ F21 tool_call_labels (FEAT-162)

Date: 2026-08-06
Status: **foundation shipped** (shared types + best-effort bridge). Full
physical merge of tables / portal UIs is deferred.

## Problem

Eden has two human-label surfaces:

| Surface | Code | Storage | Purpose |
|---|---|---|---|
| General labeling queue | `src/eden/evaluation/labeling.py`, `api/routes/labeling.py`, portal annotate UI | `labeling_items` + `annotations` | HiL review, IAA, export, skill-matched queues |
| F21 tool-call thumbs | `src/eden/learning/tool_call_labels.py`, `api/routes/tool_call_labels.py` | `tool_call_labels` | Calibrator training (`good`/`bad` per span) |

They share the product concept ("a human judged this") but not types or
write paths. FEAT-162 starts unification without a big rewrite.

## Target model

1. **Single conceptual event stream** — every human judgment is a
   `HumanLabel` (`src/eden/evaluation/human_labels.py`) with:
   - `kind`: `generic` | `trace_score` | `tool_call` (extensible)
   - `label`, `annotator_id`, `org_id`
   - optional source pointers (`item_id`, `span_id`, `trace_id`, …)
2. **Specialized storage stays** — `tool_call_labels` remains the
   calibrator source of truth; `labeling_items` remains the queue /
   IAA / export surface.
3. **Adapter, not rewrite** — tool-call writes optionally upsert a
   labeling item with `label_schema.type = "tool_call"` and an
   annotation, so portal / IAA / export can see thumbs without
   migrating calibrator training off F21.

```
  Portal / API thumbs          Calibrator training
         │                            ▲
         ▼                            │
  POST /tool-calls/{span}/label ──────┤ tool_call_labels (SoT)
         │                            │
         └─ bridge (best-effort) ──► labeling_items kind=tool_call
                                      + annotations
                                      (IAA / export / queue)
```

## Shipped (2026-08-06)

* `HumanLabel` TypedDict + `TOOL_CALL_ITEM_KIND = "tool_call"`.
* `bridge_tool_call_label_to_queue(...)` — find-or-seed by
  `(org_id, source_span_id, type=tool_call)`, then `annotate()`.
* Wired from `ToolCallLabelService.create_label` (never fails the
  thumbs write; kill via `EDEN_TOOL_CALL_LABEL_BRIDGE=0`).
* API note on both labeling and tool-call route module docstrings.

## Active learning (FEAT-163)

`GET .../labeling/queue/{user}?strategy=active_learning` re-ranks
candidates by IAA disagreement, single-annotation value, and model
uncertainty (`src/eden/evaluation/active_learning.py`). Default remains
`fifo` (no behaviour change).

## Next steps (not this PR)

1. Portal annotate UI: filter / badge items by `label_schema.type`,
   including `tool_call`.
2. Optional reverse bridge: labeling annotations with kind `tool_call`
   write through to `tool_call_labels` when span_id is present.
3. Eventually a unified read API (`GET /orgs/{org}/human-labels`) that
   unions both tables into `HumanLabel` events for analytics.
4. Migrate calibrator export to accept either table once the bridge
   has enough dogfood history.
