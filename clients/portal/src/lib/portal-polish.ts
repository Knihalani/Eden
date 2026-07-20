/**
 * U20 portal polish — shared constants for a11y CI, microcopy, and toast audit.
 */

/** Core routes that must pass axe with zero critical violations (U20 §4 + W12). */
export const U20_CORE_AXE_ROUTES = [
  "/dashboard",
  "/traces",
  "/issues",
  "/artifacts",
  "/playgrounds",
  "/evals",
  "/improve",
  "/alerts",
] as const;

/** Gap 4.8 empty-state voice — precise, technical, calm (no exclamation marks). */
export const U20_EMPTY_COPY = {
  dashboardTraces:
    "Waiting for first event — create an API key, follow the docs quickstart, run doctor, then check for events.",
  issues:
    "Issues appear when Eden detects failures in finalized traces — usually within 60 seconds of a failed run. Install the SDK (docs quickstart), create an API key, then send traffic.",
  artifacts:
    "Artifacts are reusable fixes Eden learns from production. Create an API key, send traces via the SDK or gateway, then after recurring issues appear, shadow candidates land here.",
  ledger:
    "Resolve an issue or promote an Artifact to seed your first Ledger draft. Ledgers compound institutional memory across agents.",
  traces:
    "Run doctor to verify ingest, then send traffic from the gateway or SDK. This list refreshes while empty — or check for events now.",
  playground:
    "An eval scores agent output against a rubric or expected answer — create a playground to compare prompts, then promote to an experiment (docs quickstart if you still need traces).",
  experiments:
    "Experiments compare control vs treatment on a dataset snapshot. Promote a playground run, or start from Evals → Datasets, then return here for grades and diffs.",
  debugger:
    "Paste a trace id to list time-travel checkpoints, then re-run from any step. Open Traces to pick a recent run if you do not have an id yet.",
} as const;

/**
 * Wave-3 first-trace waiting UX — shared title/CTA/doctor commands.
 * Used by traces empty-state + dashboard first-run (not a full wizard).
 */
export const FIRST_EVENT_WAIT = {
  title: "Waiting for first event",
  titleReceived: "First event recorded",
  description:
    "Run doctor to verify ingest, then send traffic from the gateway or SDK. This list refreshes while empty — or check for events now.",
  descriptionReceived:
    "Ingest marked a first event. Refresh if it has not appeared in the list yet.",
  checkCta: "Check for events",
  doctorHint: "Verify ingest",
  doctorPython: "python -m eden_sdk.doctor",
  doctorNpx: "npx eden-doctor",
  pollMs: 10_000,
} as const;

/** Core mutations that must surface toast feedback (U20 WP5). */
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
] as const;

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
