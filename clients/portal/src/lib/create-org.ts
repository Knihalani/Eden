/**
 * Helpers for the portal create-organization flow.
 *
 * After ``POST /orgs``, activate the Clerk org when ``clerk_org_id`` is
 * present so JWT claims include ``org:admin``. When Clerk create is
 * degraded, the Eden row still lands but the FE must select that Eden
 * org as current (owner role) and surface a clear warning instead of
 * silently leaving the creator on another org / non-admin session.
 */

import type { Organization } from "@/lib/types";

export type CreateOrgResult = {
  org_id: string;
  name: string;
  slug: string;
  role: string;
  clerk_org_id: string | null;
  org_degraded?: boolean;
  /** First/solo workspace from ``POST /orgs`` (migration 046). */
  is_personal?: boolean;
};

/** Clerk org id to pass to ``setActive({ organization })``, or null. */
export function clerkOrgIdToActivate(created: CreateOrgResult): string | null {
  return created.clerk_org_id || null;
}

/**
 * True when Clerk sync failed or returned no org id — Eden-only row.
 * Callers should toast a warning and skip ``setActive``.
 */
export function isCreateOrgDegraded(created: CreateOrgResult): boolean {
  return Boolean(created.org_degraded) || !created.clerk_org_id;
}

/**
 * Build an Eden ``Organization`` from the create response so the portal
 * can ``setCurrentOrg`` immediately — required when ``clerk_org_id`` is
 * null (``setActive`` skipped) so the creator keeps owner/admin UX via
 * the Eden ``role`` / ``is_owner`` fields even when Clerk is degraded.
 */
export function organizationFromCreate(created: CreateOrgResult): Organization {
  const role = created.role || "owner";
  return {
    id: created.org_id,
    name: created.name,
    slug: created.slug,
    role,
    is_owner: role === "owner",
    clerk_org_id: created.clerk_org_id,
    is_personal: Boolean(created.is_personal),
  };
}

export const CREATE_ORG_DEGRADED_TITLE = "Organization created — Clerk sync delayed";
export const CREATE_ORG_DEGRADED_DESCRIPTION =
  "Your workspace was saved in Eden, but Clerk could not be reached. Invites and the org switcher may not work until you refresh after Clerk reconnects.";
