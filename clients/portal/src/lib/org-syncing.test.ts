import { describe, expect, it } from "vitest";
import { isOrgSyncing } from "./org-syncing";

const base = {
  clerkOrgId: "org_clerk_1",
  currentOrg: null,
  authErrorKind: null as "session" | "server" | null,
  loading: false,
};

describe("isOrgSyncing", () => {
  it("is false on first load while /auth/me is in flight (no flash)", () => {
    expect(
      isOrgSyncing({ ...base, meInFlight: true, hadSelection: false }),
    ).toBe(false);
  });

  it("is true mid-switch even while the remap refetch is in flight", () => {
    // Clerk org changed → currentOrg nulled on purpose. Without the
    // hadSelection carve-out the chrome flashed "Select workspace".
    expect(
      isOrgSyncing({ ...base, meInFlight: true, hadSelection: true }),
    ).toBe(true);
  });

  it("is true after the remap fetch when Eden has not caught up", () => {
    expect(
      isOrgSyncing({ ...base, meInFlight: false, hadSelection: true }),
    ).toBe(true);
  });

  it("is false once Eden remapped to Clerk's active org", () => {
    expect(
      isOrgSyncing({
        ...base,
        currentOrg: { id: "eden-1", clerk_org_id: "org_clerk_1" },
        meInFlight: false,
        hadSelection: true,
      }),
    ).toBe(false);
  });

  it("never treats an Eden-only selection as a sync gap", () => {
    expect(
      isOrgSyncing({
        ...base,
        currentOrg: { id: "eden-only", clerk_org_id: null },
        meInFlight: false,
        hadSelection: true,
      }),
    ).toBe(false);
  });

  it("stays suppressed behind a session error", () => {
    expect(
      isOrgSyncing({
        ...base,
        authErrorKind: "session",
        meInFlight: false,
        hadSelection: true,
      }),
    ).toBe(false);
  });
});
