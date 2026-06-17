// Maps Clerk organization roles to Eden's role vocabulary + provides
// the inverse mapping for places where Eden issues role strings back
// to Clerk (e.g. when inviting members).

export type EdenRole = "owner" | "admin" | "member" | "viewer";
export type ClerkRole = "org:admin" | "org:member" | `org:${string}`;

/**
 * Default Clerk role for a brand-new member invited from the portal.
 * Eden defaults to ``member``; admins promote via the team page.
 */
export const DEFAULT_CLERK_ROLE_FOR_INVITE: ClerkRole = "org:member";

/**
 * Map Clerk's role string to Eden's role vocabulary.
 *
 * Clerk ships two default roles: ``org:admin`` (full control) and
 * ``org:member`` (read-mostly). Eden historically used a four-tier
 * ladder (``owner`` / ``admin`` / ``member`` / ``viewer``); we
 * collapse to two tiers on the Clerk side and treat any custom
 * ``org:<x>`` role as ``admin`` so the migration is lossless.
 */
export function clerkRoleToEden(role: ClerkRole | string | null | undefined): EdenRole {
  if (!role) return "viewer";
  if (role === "org:admin") return "admin";
  if (role === "org:member") return "member";
  // Any custom role defaults to admin so we don't accidentally
  // demote someone who was set up with a non-standard slug.
  return "admin";
}

/**
 * Map Eden's role to Clerk's role string for invite / role-update
 * flows. Owner is treated as ``org:admin`` (the highest Clerk ships
 * with out of the box); upgrade to a custom role via the Clerk
 * dashboard once you need a real owner distinction.
 */
export function edenRoleToClerk(role: EdenRole): ClerkRole {
  if (role === "owner" || role === "admin") return "org:admin";
  return "org:member";
}

/**
 * Permission check that works against either a Clerk payload
 * (``auth().has({ role })``) or the legacy Eden role string. Use
 * this everywhere the existing RBAC checks live so we don't have to
 * rewrite each one.
 */
export function hasEdenRole(
  clerkRole: ClerkRole | string | null | undefined,
  required: EdenRole | EdenRole[],
): boolean {
  const eden = clerkRoleToEden(clerkRole);
  const required_ = Array.isArray(required) ? required : [required];
  // ``admin`` implies ``member`` implies ``viewer``. ``owner`` implies
  // every role.
  const rank: Record<EdenRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };
  const myRank = rank[eden];
  return required_.some((r) => myRank >= rank[r]);
}