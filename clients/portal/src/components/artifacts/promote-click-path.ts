/**
 * Issue → Artifact → Promote click budget (Wave 4.5).
 * 1 open issue · 2 Open artifacts · 3 select shadow row · 4 Promote CTA
 * (evidence gates visible in detail before CTA — not an extra click).
 */
export const ISSUE_ARTIFACT_PROMOTE_CLICK_PATH = [
  "issues:open-issue",
  "issue:open-artifacts",
  "artifacts:select-row",
  "artifacts:promote-cta",
] as const;
