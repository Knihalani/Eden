/**
 * Improve V3 shared constants — Wave 1 scaffold; Wave 2 queue views.
 * Queue column/view ids and core-loop related strip live here so the hub
 * shell can shrink without duplicating IA contracts.
 */

import type { ViewPreset } from "@/components/portal-os";

/** Core loop related strip only — Advanced leaves stay in ⌘K + Advanced nav. */
export const RELATED_LINKS = [
  { label: "Issues", href: "/issues" },
  { label: "Artifacts", href: "/artifacts" },
  { label: "Ledger", href: "/ledger" },
  { label: "Prompts", href: "/prompts" },
] as const;

export type ImproveRelatedLink = (typeof RELATED_LINKS)[number];

/** Hub embedded tabs (queue is default; plans/history soft-redirect). */
export const IMPROVE_TABS = ["queue", "plans", "history"] as const;
export type ImproveTab = (typeof IMPROVE_TABS)[number];

/**
 * Queue views — surfaced via ViewsMenu (not three permanent card walls).
 * API still emits urgent/proposed/autonomous — map via queueColumnId.
 */
export const IMPROVE_QUEUE_COLUMNS = [
  {
    id: "needs_you",
    label: "Needs you",
    hint: "Approvals, urgent issues, proposals",
  },
  {
    id: "in_progress",
    label: "In progress",
    hint: "Heal / canary / rollback in flight",
  },
  {
    id: "verify",
    label: "Verify",
    hint: "Approved patches awaiting check",
  },
] as const;

export type ImproveQueueColumnId = (typeof IMPROVE_QUEUE_COLUMNS)[number]["id"];

/** ViewsMenu presets — one active view at a time (master–detail list). */
export const IMPROVE_QUEUE_VIEW_PRESETS: ViewPreset[] = IMPROVE_QUEUE_COLUMNS.map(
  (col) => ({
    id: col.id,
    name: col.label,
    state: { filter: { column: col.id } },
  }),
);

/** Map API column ids → the three V3 views. */
export function queueColumnId(raw: string): ImproveQueueColumnId {
  if (raw === "verify") return "verify";
  if (raw === "autonomous" || raw === "in_progress") return "in_progress";
  return "needs_you";
}

/** Wave 1 nav IA marker — Prompts promoted to core Improve. */
export const WAVE1_IMPROVE_IA_COMPLETED = true as const;

/** Wave 2 queue hub master–detail rebuild. */
export const WAVE2_IMPROVE_QUEUE_COMPLETED = true as const;

/** Wave 3 plans list + plan detail Diff/Summary. */
export const WAVE3_IMPROVE_PLANS_COMPLETED = true as const;

/** Wave 9 cross-loop hardening (deep links, empties, onboarding, walkthrough). */
export const WAVE9_IMPROVE_CROSSLOOP_COMPLETED = true as const;
