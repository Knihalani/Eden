"use client";

/**
 * Model Advisor view barrel — Wave 9.8 split (modules ≤400 LOC).
 * Prefer importing named modules; this re-exports for page.tsx compat.
 */

export {
  CANDIDATES,
  DEFAULT_CANDIDATE_IDS,
  optKey,
  findOpt,
  fmtUsd,
  fmtPct,
  fmtMs,
  fmtTokens,
  type CandidateOption,
} from "./advisor-candidates";

export { RecommendationCard } from "./recommendation-card";
export { CompareView } from "./compare-view";
export { ProjectView } from "./project-view";
export { CandidatePicker } from "./candidate-picker";
