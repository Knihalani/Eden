import type { ImproveQueueItem } from "@/lib/api";
import { issueFullHref } from "@/lib/portal-cross-links";

/** Match queue cards to Issues deep-link `?issue=` (Wave 5 → Wave 7 handoff). */
export function queueItemMatchesIssue(
  item: ImproveQueueItem,
  issueId: string,
): boolean {
  if (!issueId) return true;
  if (item.ref === `issue:${issueId}`) return true;
  if (item.href === `/issues/${issueId}` || item.href === issueFullHref(issueId)) {
    return true;
  }
  const p = item.payload ?? {};
  if (p.issue_id === issueId || p.source_issue_id === issueId) return true;
  if (typeof p.source_ref === "string") {
    const ref = p.source_ref;
    if (ref === issueId || ref === `issue:${issueId}` || ref.includes(issueId)) {
      return true;
    }
  }
  const nested = p.payload;
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    (nested as Record<string, unknown>).issue_id === issueId
  ) {
    return true;
  }
  return false;
}
