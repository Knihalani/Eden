# Skeletons Registry

> A canonical list of every **intentional** stub in the Eden codebase
> — places where the surface is wired up but the underlying
> implementation is partial, with rationale and an unblocker.

This document is the inverse of the roadmap. Where the roadmap lists
what's been **built**, this document lists what is **intentionally
not built** and why. Use it to:

- Avoid re-investing engineering in something that's already a
  deliberate deferral.
- Set correct expectations for users / customers.
- Track when the deferral should be revisited.

**Rule of thumb:** if something is in this document, it's *intentional*.
If something is **not** in this document and looks like a stub, it's
a **bug** — open a ticket.

---

## Cat 23 — Autonomous Code Modification (the headline stub)

**Status:** STUB surface (intentional, 2-stage opt-in)
**Surface:**
- `src/eden/code_change/` — 21 service classes across `approvals/`, `auto_approval/`, `inbox/`, `persona/`, `quality/`, `style/`
- `clients/portal/src/app/(portal)/pr-suggestions/` — the inbox + detail UI
- `src/eden/providers/pr.py:561-596` — `GitHubPRProvider` (5 methods all `raise NotImplementedError`)
- `src/eden/providers/repo.py:472-514` — `GitHubRepoProvider` (6 methods all `raise NotImplementedError`)
- `src/eden/api/routes/agent_pr_suggestions.py:272` — `open_pr` route catches `NotImplementedError` and returns `{"status": "not_implemented", ...}`
- `src/eden/api/routes/intelligence_code_change.py` — full Cat 23 router

**Unblocks when:** SLM Initiative ships (v1.6, 8-week rollout). Real end-to-end
requires 4 hard gates: read-only → attribution → sandbox → end-to-end.

**Why deferred:** the real implementation needs GitHub App auth, secret
storage, signed JWT, and a CodeChangeHook firing chain. The portal
already works in stub mode (patches show, approve/deny work, no real
PR created) so the user-facing product is usable.

**User-facing impact:** the "Open PR" button on a patch returns
`not_implemented`. Everything else (browse patches, approve, deny,
regenerate) is real.

---

## FirecrackerSimAdapter

**Status:** NotImplementedError stub
**File:** `src/eden/sim_runner.py:428,442`
**Methods:** `run_scenarios`, `run_tests`

**Fallback:** `SubprocessSimAdapter` is fully working and is the
default. Existing sim runs work.

**Unblocks when:** BandSox protocol extension + microVM provisioning
infra is in place.

**Why deferred:** Firecracker microVM provisioning needs kernel
modules + cgroups + nested virtualization on the host. The
subprocess adapter is a complete dev/prod path that exercises the
same orchestration code.

---

## `(portal)/builder/page.tsx`

**Status:** ✅ SHIPPED (v1.7, §8.1)
**File:** `clients/portal/src/app/(portal)/builder/page.tsx` +
`_components/{Canvas,Palette,Inspector,RunResultsDialog,NodeShell,nodes/*}.tsx`
+ `_hooks/useBuilderState.ts` + `_lib/{specTranslator,tarballBuilder,storage,types}.ts`

The visual DAG builder is live at `/builder`. Seven block types
(Agent, Tool, Scenario, Scoring, Memory, Loop, Seed) on a React Flow
canvas, in-portal push & run (packages a ZIP tarball, POSTs to
`/upload` + `/sim/runs`, polls the result into a modal), live YAML
preview in the Inspector, localStorage auto-save. The Seed block
flows through `eval_yaml` JSONB and is honoured by
`SubprocessSimAdapter` via the `EDEN_SEED` env var.

---

## `closed_loop_actions` apply flow

**Status:** Hooks write to the table; UI exists at `/closed-loop`
(Phase B.5) but the **apply** mutation is gated behind
`closed_loop_enabled` org setting.

**Files:**
- `src/eden/closed_loop/executor.py` — writes the `apply` action
- `src/eden/llmops/promotion_hooks.py` — defines the gated
  `PromotionHook.apply_action`
- `clients/portal/src/app/(portal)/closed-loop/page.tsx` — has the
  "Apply" button but it surfaces a confirmation prompt

**Unblocks when:** org-level `closed_loop_enabled` flag is on, AND
the action is approved. Real end-to-end "auto-apply" requires the
Cat 23 v1.6 ship; today the apply is manual + audited.

**Why deferred:** auto-apply is a privileged action that mutates
infrastructure. Manual approve-then-apply is the safe MVP.

---

## Eval — `modalities/declare`, `clhf/generate`, `hil/*`, `pairwise/*`, `multimodal/evaluate`

**Status:** Routes registered; underlying services exist; some
methods return partial data.

**Files:**
- `src/eden/api/routes/intelligence_eval.py` (POST `/clhf/generate`,
  `/hil/tasks`, `/hil/annotations`, `/pairwise/queues`,
  `/pairwise/preferences`, `/multimodal/evaluate`,
  `/modalities/declare`)

**Unblocks when:** the customer ships the LLM-as-judge eval pipeline.
The routes work; the per-modality handlers return default
"not evaluated" responses when the modality isn't configured.

**Why deferred:** these are v2 features that depend on customer
eval pipeline data being present. Today, the eval page surfaces
metrics from `judge_scores` for modalities the customer has already
wired up.

---

## Eval — `auto-dataset` (Cat 3 / Cat 12)

**Status:** Route registered (POST `/auto-dataset`) but generates
empty CSVs when no data is in the eval table.

**Unblocks when:** customer runs the eval pipeline for at least one
traffic window.

---

## Closed-loop `apply` (gated on `closed_loop_enabled`)

Same as the closed-loop apply entry above — listed here for
discoverability. The hooks fire; the UI shows the action; the apply
button requires manual click + the org's `closed_loop_enabled` flag.

---

## Other known small stubs

### `realtime/grpc_server.py`
The gRPC server stub catches `NotImplementedError` from upstream
in-process handlers. The actual gRPC endpoint is gated behind
`grpc_enabled` org setting and is documented as "internal-only".
Customers on the JSON-over-Kafka path are unaffected.

### `realtime/ksql_cep.py`
The ksqlDB CEP path returns in-process rolling-window aggregations
when the customer's ksqlDB cluster is unreachable. This is graceful
degradation, not a stub — the in-process path is correct for the
single-tenant case.

### `intelligence_envelope.py` (`IntelligenceStubResponse`)
The envelope is used for routes that explicitly return
`{"status": "not_implemented"}` (intentional Cat 19/20/22 error
shapes). It is **not** a stub; it's the public error contract.

### `closed_loop_executor.py` and similar
Defensive `return []` / `return {}` when the DB substrate is
unavailable. These are graceful fallbacks, not stubs.

---

## How to use this document

When you're about to write code that touches a file listed above:

1. Check the unblocker. If the unblocker is met, the work is real
   engineering (file a ticket, scope, ship).
2. If the unblocker is not met, your work probably should be
   *updating* the deferral, not *implementing* the stub. Update
   this doc with the new reasoning.

When you add a new intentional stub to the codebase:

1. Add a section to this file with file paths, rationale, and
   unblocker.
2. Make the failure mode visible at the boundary (clear 404, 501,
   `not_implemented` envelope, UI badge) — never a silent
   `return null`.
3. Link the doc from the README or the relevant cat doc.

When a stub becomes a real implementation:

1. Remove the section here.
2. Update the roadmap / cat doc to reflect IMPLEMENTED status.
3. Add a release note.

---

## Document maintenance

- **Owner:** the platform team
- **Last reviewed:** 2026-06-14 (after Phase A.1–A.9 + Phase B.1–B.6 ship)
- **Next review:** with Cat 23 real ship (v1.6, gated on SLM Initiative)
