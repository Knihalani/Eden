/**
 * U20 portal polish — shared constants for a11y CI, microcopy, and toast audit.
 */

/** Gap 4.8 empty-state voice — precise, technical, calm (no exclamation marks). */
export const U20_EMPTY_COPY = {
  dashboardTraces:
    "No traces ingested yet. Create an API key, then send traffic via the SDK or gateway.",
  issues:
    "No failure fingerprints yet. They appear after finalized traces fail — usually within 60 seconds. Install the SDK, then send traffic.",
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
    "Queue is empty. Send traffic via the Gateway or SDK so detectors can open issues — then Fix now plans appear here.",
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
  attentionClear:
    "No failing or warning runs in the current feed.",
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
