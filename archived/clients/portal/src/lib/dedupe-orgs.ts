/**
 * Display-level dedupe for the workspace list.
 *
 * Production history: before the backend idempotency guard
 * (``create_org`` 60-second duplicate window) and the
 * ``OrgProvider.setActive`` fix, Clerk's hosted create-organization
 * session task reminted an org on every sign-in that had no active
 * org. One account accumulated seven orgs with the identical name —
 * only one has a live Clerk org behind it, so the other six rendered
 * in the switcher but silently did nothing when clicked
 * (``setActive`` on a dead Clerk id throws; the catch kept the menu
 * closed-open and it looked "unclickable").
 *
 * The rows are legitimate historical data and the product decision is
 * to leave the DB untouched, so the portal collapses same-named orgs
 * down to the single most usable entry: the currently selected org,
 * then one backed by a live Clerk membership, then any Clerk-linked
 * org, then the first (``/auth/me`` orders newest first).
 */

import type { Organization } from "@/lib/types";

export type DedupeOrgsOptions = {
  /** Eden org id the user is currently on — always wins its group. */
  currentOrgId?: string | null;
  /** Clerk org ids the user actually has memberships in. */
  clerkMembershipIds?: ReadonlySet<string> | null;
};

function groupKey(org: Organization): string {
  const name = (org.name ?? "").trim().toLowerCase();
  // Never merge unnamed orgs into one another — identity is the id.
  return name || `id:${org.id}`;
}

function score(
  org: Organization,
  currentOrgId: string | null | undefined,
  clerkMembershipIds: ReadonlySet<string> | null | undefined,
): number {
  if (currentOrgId && org.id === currentOrgId) return 4;
  if (org.clerk_org_id && clerkMembershipIds?.has(org.clerk_org_id)) return 3;
  if (org.clerk_org_id) return 2;
  return 1;
}

/**
 * Collapse identically-named orgs to one entry per name. Order of the
 * surviving entries follows first appearance in the input list.
 */
export function dedupeOrganizations(
  organizations: readonly Organization[],
  options: DedupeOrgsOptions = {},
): Organization[] {
  const { currentOrgId, clerkMembershipIds } = options;
  const groups = new Map<string, Organization[]>();
  for (const org of organizations) {
    const key = groupKey(org);
    const list = groups.get(key);
    if (list) {
      list.push(org);
    } else {
      groups.set(key, [org]);
    }
  }

  const out: Organization[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    // Stable sort: ties keep input order (newest first from /auth/me).
    const winner = list
      .map((org, index) => ({ org, index, s: score(org, currentOrgId, clerkMembershipIds) }))
      .sort((a, b) => b.s - a.s || a.index - b.index)[0];
    out.push(winner.org);
  }
  return out;
}

export const DEDUPE_ORGS_COMPLETED = true as const;
