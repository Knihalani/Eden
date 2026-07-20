/**
 * U20 portal polish — shared constants for a11y CI, microcopy, and toast audit.
 */

/** Core routes that must pass axe with zero critical violations (U20 §4 + W12 + W6). */
export const U20_CORE_AXE_ROUTES = [
  "/dashboard",
  "/traces",
  "/issues",
  "/artifacts",
  "/playgrounds",
  "/evals",
  "/improve",
  "/alerts",
  "/agents",
  "/settings",
] as const;

/** Routes where Wave 6 also fails the gate on axe `serious` (nested-interactive / name-role). */
export const U20_SERIOUS_AXE_ROUTES = ["/traces", "/improve"] as const;

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
    "No checkpoints listed. Paste a trace id to load steps, or open Traces to pick a recent run.",
  agents:
    "No agents registered. Create an API key, then register via the SDK or CLI.",
  improveQueue:
    "Queue is empty. Needs production traces and Agent Issues before triage items appear.",
  onlineScoring:
    "No scoring rules. Create one to sample production traces (code → SLM → LLM).",
} as const;

/** Filter-empty voice — distinct from never-ingested / zero-data. */
export const U20_FILTER_EMPTY_COPY = {
  traces: "No rows match the current filters. Clear filters or widen the query.",
  issues: "No issues match this status filter. Clear the filter to see the full queue.",
  agents: "No agents match the current filters. Clear search or framework filter.",
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
