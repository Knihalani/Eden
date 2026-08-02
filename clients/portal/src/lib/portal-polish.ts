/**
 * U20 portal polish — shared constants for a11y CI, microcopy, and toast audit.
 */

/** Live portal routes that must pass axe with zero critical violations.
 * 2026-08-01: pruned to routes that actually exist — retired surfaces
 * (/dashboard, /artifacts, /playgrounds, /ledger, /optimization) soft-land
 * and auditing them measured the redirect target. Keep in sync with
 * scripts/audit-a11y.cjs ROUTES. */
export const U20_CORE_AXE_ROUTES = [
  "/home",
  "/traces",
  "/issues",
  "/sessions",
  "/evals",
  "/improve",
  "/alerts",
  "/agents",
  "/compare",
  "/cost",
  "/gateway",
  "/signals",
  "/prompts",
  "/guardrails",
  "/settings",
] as const;

/** Routes where the gate also fails on axe `serious`. */
export const U20_SERIOUS_AXE_ROUTES = [
  "/traces",
  "/improve",
  "/evals",
  "/issues",
  "/prompts",
  "/guardrails",
] as const;

/** Gap 4.8 empty-state voice — precise, technical, calm (no exclamation marks). */
export const U20_EMPTY_COPY = {
  dashboardTraces:
    "No traces ingested yet. Create an API key, then send traffic via the SDK or gateway.",
  issues:
    "No failure fingerprints yet. They appear after finalized traces fail — usually within 60 seconds. Install the SDK, then send traffic.",
  artifacts:
    "No shadow candidates yet. They appear after recurring issues resolve. Send traces via the SDK or gateway first.",
  ledger:
    "No ledger drafts yet. Resolve an issue or promote an Artifact to seed the first draft.",
  traces:
    "No events ingested yet. Run doctor to verify ingest, then send traffic from the gateway or SDK.",
  playground:
    "No playgrounds yet. Create one to compare prompts side-by-side, then promote a run to an experiment.",
  experiments:
    "No experiments yet. Promote a playground run, or create a dataset under Evals first.",
  debugger:
    "No debugger sessions yet. Open Traces, pick a run, and use Debugger to replay spans step-by-step — or start a new session here.",
  agents:
    "No agents registered. Create an API key, then register via the SDK or CLI.",
  improveQueue:
    "Queue is empty. Needs production traces and Agent Issues before triage items appear.",
  datasets:
    "No datasets yet. Create one from a failing trace, or add cases under Evals to score prompts.",
  guardrailsPolicies:
    "No policies yet. Add a policy to block or flag unsafe tool and model calls.",
  onlineScoring:
    "No scoring rules. Create one to sample production traces (code → SLM → LLM).",
  alerts:
    "No fired detector events yet. Create detectors on the Detectors page; Inbox shows firings when thresholds trip.",
  alertsClear:
    "Inbox clear — no firing detector events for your rules.",
  signals:
    "No detectors yet. Create one to watch errors, latency, cost, or policy across runs.",
} as const;

/** Filter-empty voice — distinct from never-ingested / zero-data. */
export const U20_FILTER_EMPTY_COPY = {
  traces: "No rows match the current filters. Clear filters or widen the query.",
  issues: "No issues match this status filter. Clear the filter to see the full queue.",
  agents: "No agents match the current filters. Clear search or framework filter.",
  alerts: "No events match the current filters. Clear filters to see the full Inbox.",
  signals:
    "No detectors match the current filters. Clear search or kind/state filters.",
} as const;

/**
 * Wave-3 first-trace waiting UX — shared title/CTA/doctor commands.
 * Used by traces empty-state + dashboard first-run (not a full wizard).
 */
export const FIRST_EVENT_WAIT = {
  title: "Waiting for first event",
  titleReceived: "First event recorded",
  description:
    "No events ingested yet. Run doctor to verify ingest, then send traffic from the gateway or SDK.",
  descriptionReceived:
    "Ingest marked a first event. Refresh if it has not appeared in the list yet.",
  checkCta: "Check for events",
  doctorHint: "Verify ingest",
  doctorPython: "python -m eden_sdk.doctor",
  doctorNpx: "npx eden-doctor",
  pollMs: 10_000,
} as const;

/** Core mutations that must surface toast feedback (U20 WP5). Wave 8 audit complete. */
export const U20_TOAST_MUTATIONS = [
  "artifact.promote",
  "artifact.archive",
  "artifact.author",
  "artifact.export",
  "promotion.approve",
  "promotion.reject",
  "playground.run",
  "playground.compare",
  "alert.acknowledge",
  "issue.resolve",
  "issue.triage",
  "improve.approve",
  "plan.approve",
] as const;

/** File anchors proving each U20_TOAST_MUTATIONS key has toast.success wiring. */
export const U20_TOAST_MUTATION_SOURCES: Record<(typeof U20_TOAST_MUTATIONS)[number], string> = {
  "artifact.promote": "app/(portal)/artifacts/_components/use-artifacts-page.ts",
  "artifact.archive": "app/(portal)/artifacts/_components/use-artifacts-page.ts",
  "artifact.author": "app/(portal)/artifacts/_components/use-artifacts-page.ts",
  "artifact.export": "app/(portal)/artifacts/_components/use-artifacts-page.ts",
  "promotion.approve": "app/(portal)/improve/_components/use-improve-queue.ts",
  "promotion.reject": "app/(portal)/improve/_components/use-improve-queue.ts",
  "playground.run": "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
  "playground.compare": "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
  "alert.acknowledge": "app/(portal)/alerts/_components/use-alerts-page.ts",
  "issue.resolve": "app/(portal)/issues/_components/use-issue-detail.ts",
  "issue.triage": "app/(portal)/issues/_components/use-issue-detail.ts",
  "improve.approve": "app/(portal)/improve/_components/use-improve-queue.ts",
  "plan.approve": "app/(portal)/improve/plans/[id]/_components/use-plan-detail.ts",
};

/** U20 motion utility class names (see globals.css). */
export const U20_MOTION_CLASSES = [
  "panel-enter",
  "row-select-highlight",
  "live-append-pulse",
] as const;

/** Hubs that must ship QueryFilterBar + Views + export OS (W11). */
export const W11_OS_HUBS = [
  "traces",
  "issues",
  "alerts",
  "artifacts",
  "experiments",
  "datasets",
  "promotions",
] as const;

/** Wave 11 overhaul — hubs with j/k + Arrow list keyboard nav. */
export const WAVE11_LIST_KEYBOARD_HUBS = [
  "traces",
  "issues",
  "alerts",
  "artifacts",
] as const;

/** Wave E6 — Evaluate surfaces with j/k list keyboard nav. */
export const WAVE_E6_LIST_KEYBOARD_HUBS = [
  "experiments",
  "playgrounds",
  "datasets",
] as const;

/** Wave 11 — mobile card surfaces (not horizontally shrunk tables). Core five + leaves. */
export const WAVE11_MOBILE_CARD_SURFACES = [
  "app/(portal)/dashboard/page.tsx",
  "app/(portal)/observability/_components/TracesTab.tsx",
  "app/(portal)/issues/_components/issues-list.tsx",
  "app/(portal)/evals/page.tsx",
  // W2 peel: mobile cards marker lives on queue-board (hub shell ≤400).
  "app/(portal)/improve/_components/queue-board.tsx",
  "app/(portal)/agents/page.tsx",
  "app/(portal)/fleet/page.tsx",
  "app/(portal)/improve/runs/page.tsx",
  // Wave E6 Evaluate leaves
  "app/(portal)/experiments/_components/experiments-list.tsx",
  "app/(portal)/datasets/_components/datasets-table.tsx",
  "app/(portal)/playgrounds/page.tsx",
] as const;

/** Wave 12 freeze — Observe → Eval → Improve happy-path routes. */
export const WAVE12_LOOP_ROUTES = [
  "/traces",
  "/evals",
  "/improve",
] as const;

/**
 * Wave 12 — authenticated `(portal)` `page.tsx` count (signoff matrix).
 * Keep in sync with `find src/app/(portal) -name page.tsx | wc -l`.
 */
export const WAVE12_PORTAL_ROUTE_COUNT = 75 as const;

/** Wave 12 — visual regression baseline PNG roots under e2e/golden/screenshots/. */
export const WAVE12_VISUAL_BASELINE_IDS = [
  "01-sign-in-home",
  "02-traces-hub",
  "03-issues",
  "04-artifacts",
  "05-playgrounds",
  "06-alerts",
  "07-experiments",
  "08-debugger-sessions",
] as const;

/**
 * Wave 12 — peer corpus PNGs used as visual grammar references (path contract).
 * Full corpus: `.cursor/visual-research/ai-portals/` (+ wave0b OBSERVATIONS).
 */
export const WAVE12_PEER_VISUAL_REFS = [
  "lmnr-home-scroll1.png",
  "lmnr-home-scroll2.png",
  "langfuse-public-trace-scroll0.png",
  "braintrust-observe-scroll0.png",
  "helicone-home-product-scroll0.png",
  "arize-phoenix-product-scroll0.png",
] as const;

/** Wave 12 + Home Shell — always-on chrome sinks (desktop first paint; target ≤6). */
export const WAVE12_CHROME_SINKS = [
  "sidebar",
  "header",
  "command-palette",
  "banner",
  "toast",
  "ask-ai-fab",
] as const;
