import { describe, expect, it } from "vitest";
import {
  isKnownPortalPath,
  LIVE_PORTAL_PREFIXES,
  STUB_PORTAL_PATH_PREFIXES,
} from "@/lib/portal-routes";
import {
  buildHubRedirectUrl,
  labToProductPath,
  LIVE_PRODUCT_PREFIXES,
  STUB_LAND,
  STUB_PREFIXES,
} from "@/lib/portal-hub-redirect";
import { AUTH_SIGN_IN_FALLBACK, AUTH_SIGN_UP_FALLBACK } from "@/lib/auth-redirect";
import { NAV_SECTIONS, PRIMARY_NAV } from "@/lab/nav";

describe("product portal routes", () => {
  it("knows live product paths", () => {
    expect(isKnownPortalPath("/rebuild")).toBe(true);
    expect(isKnownPortalPath("/home")).toBe(true);
    expect(isKnownPortalPath("/traces")).toBe(true);
    expect(isKnownPortalPath("/gateway")).toBe(true);
    expect(isKnownPortalPath("/agents/connect")).toBe(true);
    expect(isKnownPortalPath("/unavailable")).toBe(true);
    expect(isKnownPortalPath("/prompts")).toBe(true);
  });

  it("maps stale /lab URLs to product", () => {
    expect(labToProductPath("/lab")).toBe("/home");
    expect(labToProductPath("/lab/traces")).toBe("/traces");
    expect(buildHubRedirectUrl("/lab/traces", "?id=tr_01")).toBe(
      "/traces?id=tr_01",
    );
  });

  it("does not bounce live product", () => {
    expect(buildHubRedirectUrl("/traces", "")).toBeNull();
    expect(buildHubRedirectUrl("/home", "")).toBeNull();
    expect(buildHubRedirectUrl("/unavailable", "")).toBeNull();
    expect(buildHubRedirectUrl("/rebuild", "")).toBeNull();
    // Docs Fill-in is a real auth bridge — must not soft-land as a stub.
    expect(buildHubRedirectUrl("/docs-fill", "?op=session")).toBeNull();
  });

  it("soft-lands stubs and dashboard; onboarding starts tour", () => {
    expect(STUB_LAND).toBe("/unavailable");
    expect(buildHubRedirectUrl("/dashboard", "")).toBe("/home");
    expect(buildHubRedirectUrl("/analytics", "")).toBe("/unavailable");
    expect(buildHubRedirectUrl("/marketplace", "")).toBe("/unavailable");
    expect(buildHubRedirectUrl("/onboarding", "")).toBe(
      "/home?onboarding=1",
    );
  });

  it("sends auth fallback to home; sign-up opens tour", () => {
    expect(AUTH_SIGN_IN_FALLBACK).toBe("/home");
    expect(AUTH_SIGN_UP_FALLBACK).toBe("/home?onboarding=1");
  });

  it("preserves the query string on /onboarding, like every other branch", () => {
    expect(buildHubRedirectUrl("/onboarding", "?ref=welcome")).toBe(
      "/home?onboarding=1&ref=welcome",
    );
    expect(buildHubRedirectUrl("/onboarding", "ref=welcome")).toBe(
      "/home?onboarding=1&ref=welcome",
    );
    // No incoming query — behavior is unchanged.
    expect(buildHubRedirectUrl("/onboarding", "")).toBe(
      "/home?onboarding=1",
    );
  });

  it("produces a URL for /onboarding that a real URL parser can decode, with both params independently retrievable", () => {
    const result = buildHubRedirectUrl("/onboarding", "?ref=welcome");
    expect(result).not.toBeNull();
    const parsed = new URL(result as string, "https://example.test");
    // A single, correctly-delimited query string — not `onboarding=1?ref=welcome`
    // masquerading as one param, which is what naive string concatenation produced.
    expect(parsed.searchParams.get("onboarding")).toBe("1");
    expect(parsed.searchParams.get("ref")).toBe("welcome");
    expect([...parsed.searchParams.keys()]).toEqual(["onboarding", "ref"]);
  });
});

describe("live/stub prefix lists share one source of truth", () => {
  // portal-routes.ts (the auth-gate file) is the single source; the
  // hub-redirect module re-exports it rather than hand-copying it, so
  // these two lists can never silently diverge again.
  it("re-exports the exact same array references from portal-hub-redirect.ts", () => {
    expect(LIVE_PRODUCT_PREFIXES).toBe(LIVE_PORTAL_PREFIXES);
    expect(STUB_PREFIXES).toBe(STUB_PORTAL_PATH_PREFIXES);
  });

  // Paths that previously drifted (present in the auth-gate list but
  // missing from the hub-redirect list) must be classified as live in
  // BOTH the auth gate and the redirect builder.
  it.each(["/gateway", "/dashboard", "/lab", "/onboarding"])(
    "classifies %s as live in both isKnownPortalPath and buildHubRedirectUrl",
    (prefix) => {
      expect(isKnownPortalPath(prefix)).toBe(true);
      // Live paths never soft-land on the stub page; each has its own
      // canonical redirect (or passes straight through as null).
      expect(buildHubRedirectUrl(prefix, "")).not.toBe(STUB_LAND);
    },
  );
});

describe("nav IA", () => {
  it("groups sections and renames Assistant / Detectors", () => {
    expect(NAV_SECTIONS.map((s) => s.id)).toEqual([
      "observe",
      "evaluate",
      "improve",
      "assist",
      "workspace",
    ]);
    expect(PRIMARY_NAV.find((i) => i.id === "agent")?.label).toBe("Assistant");
    expect(PRIMARY_NAV.find((i) => i.id === "signals")?.label).toBe(
      "Detectors",
    );
    expect(PRIMARY_NAV.find((i) => i.id === "agent")?.href).toBe("/agent");
    expect(PRIMARY_NAV.find((i) => i.id === "signals")?.href).toBe("/signals");
  });
});
