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
    "Traces will appear here once your agents emit telemetry. Connect an agent to see live signals in seconds.",
  issues:
    "Issues appear automatically when Eden detects agent failures in finalized traces — usually within 60 seconds of a failed run.",
  artifacts:
    "Artifacts are reusable fixes Eden learns from production. After ~7 days of traffic, recurring issues become shadow candidates here.",
  ledger:
    "Resolve an issue or promote an Artifact to seed your first Ledger draft. Ledgers compound institutional memory across agents.",
  traces:
    "Connect the Eden SDK (or run a job) — traces appear here as your agents emit telemetry. Start with eden.init() in your app.",
  playground:
    "Run a prompt against a template to compare models before opening an offline experiment.",
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
