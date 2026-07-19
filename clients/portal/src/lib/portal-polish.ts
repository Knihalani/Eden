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
    "Traces appear here once the SDK or gateway sends telemetry. Create an API key, follow the docs quickstart, then run eden-doctor to verify.",
  issues:
    "Issues appear when Eden detects failures in finalized traces — usually within 60 seconds of a failed run. Install the SDK (docs quickstart), create an API key, then send traffic.",
  artifacts:
    "Artifacts are reusable fixes Eden learns from production. Create an API key, send traces via the SDK or gateway, then after recurring issues appear, shadow candidates land here.",
  ledger:
    "Resolve an issue or promote an Artifact to seed your first Ledger draft. Ledgers compound institutional memory across agents.",
  traces:
    "Traces appear once the gateway or SDK sends telemetry. Create an API key, follow the docs quickstart, then run eden-doctor (or python -m eden_sdk.doctor) to verify ingest.",
  playground:
    "An eval scores agent output against a rubric or expected answer — create a playground to compare prompts, then promote to an experiment (docs quickstart if you still need traces).",
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
