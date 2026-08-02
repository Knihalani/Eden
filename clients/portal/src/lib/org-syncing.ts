/**
 * Pure helpers for OrgProvider sync-gap detection.
 *
 * Kept outside the React hook so unit tests can lock the degraded-create
 * / Eden-only selection edge case without mounting Clerk providers.
 */

export type OrgSyncSelection = {
  id: string;
  clerk_org_id?: string | null;
};

/**
 * True when Clerk has an active org but Eden has not remapped it yet.
 *
 * Eden-only rows (``clerk_org_id`` null/empty after degraded create) are
 * an intentional selection — do not treat a still-active previous Clerk
 * org as a sync gap (that caused ~45s NoOrgState spinners).
 */
export function isOrgSyncing(args: {
  clerkOrgId: string | null | undefined;
  currentOrg: OrgSyncSelection | null;
  authErrorKind: "session" | "server" | null;
  loading: boolean;
  meInFlight: boolean;
  /**
   * True once the user has held an org selection this session. After a
   * Clerk-initiated switch, ``currentOrg`` is nulled on purpose while
   * /auth/me remaps — that gap SHOULD read as syncing (not "Select
   * workspace") even while the refetch is in flight. First load keeps
   * the old ``meInFlight`` suppression so the banner doesn't flash on
   * a cold start.
   */
  hadSelection?: boolean;
}): boolean {
  const {
    clerkOrgId,
    currentOrg,
    authErrorKind,
    loading,
    meInFlight,
    hadSelection,
  } = args;
  const edenOnlySelection = Boolean(
    currentOrg &&
      (currentOrg.clerk_org_id == null || currentOrg.clerk_org_id === ""),
  );
  const inflightSuppressed = meInFlight && !(hadSelection && !currentOrg);
  return Boolean(
    clerkOrgId &&
      !edenOnlySelection &&
      authErrorKind !== "session" &&
      !loading &&
      !inflightSuppressed &&
      (!currentOrg ||
        (currentOrg.clerk_org_id !== clerkOrgId &&
          currentOrg.id !== clerkOrgId)),
  );
}
