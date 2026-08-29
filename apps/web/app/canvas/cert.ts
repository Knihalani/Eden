import type { Manifest } from "@eden/ir/types";

/**
 * Approval-strip tokens line. Uncertified programs never quote a savings number.
 * `llmReduction` is reported-only (20b) — never an `×` LLM-call ratio here.
 */
export function tokensCertLine(m: Manifest | null | undefined): string {
  if (!m) return "Not measured";
  if (m.tokensEstimated === true || m.certified === false) return "Uncertified";
  if (m.certified === true) return "Certified: measured";
  if (!m.tokensMeasured || m.tokensSaved == null || !Number.isFinite(m.tokensSaved)) return "Not measured";
  return `${Math.round(m.tokensSaved)} tokens saved`;
}
