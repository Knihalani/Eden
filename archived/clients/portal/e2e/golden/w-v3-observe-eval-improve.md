# Observe V3 Wave 6 — Golden path refresh (Observe → Eval → Improve)

**Script:** [`w12-observe-eval-improve.mjs`](./w12-observe-eval-improve.mjs) (alias exports `W_V3_LOOP` / `W_V3_URL_GRAMMAR`)  
**Live:** `W12_E2E_LIVE=1` or `W_V3_E2E_LIVE=1` + `e2e/.auth-state.json`  
**Dry-run:** `node e2e/golden/w12-observe-eval-improve.mjs` (prints contract, exit 0)

## Loop still holds

| Step | Route | Expect |
|------|-------|--------|
| Observe | `/traces` | Traces / spans / sessions hub (or first-run empty) |
| Evaluate | `/evals` | Datasets · Playgrounds · Experiments hub |
| Improve | `/improve` | Queue / artifacts empty-or-loaded |

≤3 decision surfaces from Home — unchanged from Wave 12.

## URL grammar assertions (Wave 6)

Writers (canonical):

- `traceId` — selected trace
- `spanId` — selected / highlighted span
- `pastHours` — time window (default 168)
- also: `view`, `mode`, `q`, `realm`, `outcome`, `agent_id`, `viewId`, `cols`, `live`

Alias-read only (never write): `span`, `span_id`, `trace_id`, path `/traces/:id`

Sample deep-link:

```
/traces?traceId=sample-trace&spanId=sample-span&pastHours=24&q=error&view=traces
```

Live smoke opens `/traces?traceId=smoke&pastHours=168` and fails if the URL writes `trace_id` / `span_id`.

## Keyboard (hub / detail) — manual when live E2E unavailable

- [ ] `j` / `k` moves list selection (opens detail)
- [ ] `Enter` opens / re-selects current row
- [ ] `Esc` closes detail (Close chip shows Esc)
- [ ] `/` focuses filter search (chip on Search)
- [ ] `⌘K` opens command palette — does **not** focus filter / clash with `k`
- [ ] Focus inside transcript: `j` / `k` step spans (list does not steal)

## Cross-links preserve window

Trace → dataset / playground must keep `pastHours` (and filter scent when present) via `TracePreserveParams`.

## Wave E6 — Evaluate compare/diff hop

Optional deep hop after Eval hub (`W_E6_EVAL_COMPARE_CONTRACT` in `w12-observe-eval-improve.mjs`):

| Route | Assert |
|-------|--------|
| `/evals?tab=experiments` | Shell `[data-wave-e4-experiments]` / `[data-wave-e6-eval="experiments"]`, or body: Experiment / Compare / Baseline / Diff / empty |
| Compare CTA | `[data-wave-e4-cta="compare"]` |
| Baseline / Diff | `[data-wave-e4-baseline]`, `[data-wave-e4-diff]`, `[data-wave-e4-compare]` when detail open |
| Empty | `No experiments yet` grammar OK |

Dry-run prints the hop + selectors and exits 0. Live (`W12_E2E_LIVE=1`): visits the hop after Eval; auth redirect fails live with a clear seed message (does not affect dry-run).

Agent 09 probe: `node e2e/golden/agent09-evaluate-probe.mjs` — soft-skips (exit 0) when `E6_PROBE_DRY=1` or `e2e/.auth-state.json` is missing; live also hits `/evals?tab=experiments` @375/@1280.

## Status

| Gate | Notes |
|------|-------|
| Dry-run contract | Always runnable in CI / offline (incl. E6 compare/diff print) |
| Live Playwright | Requires auth seed; skip in sandboxes without Clerk |
| Agent 09 probe | Soft-skip without auth / `E6_PROBE_DRY=1` |
| Manual keyboard | Use checklist above on `/traces` |
