import { describe, expect, it } from "vitest";
import { isKnownPortalPath } from "@/lib/portal-routes";
import {
  buildHubRedirectUrl,
  labToProductPath,
  STUB_LAND,
} from "@/lib/portal-hub-redirect";
import { AUTH_SIGN_IN_FALLBACK } from "@/lib/auth-redirect";
import { NAV_SECTIONS, PRIMARY_NAV } from "@/lab/nav";

describe("product portal routes", () => {
  it("knows live product paths", () => {
    expect(isKnownPortalPath("/rebuild")).toBe(true);
    expect(isKnownPortalPath("/home")).toBe(true);
    expect(isKnownPortalPath("/traces")).toBe(true);
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
  });

  it("soft-lands stubs and dashboard; onboarding starts tour", () => {
    expect(STUB_LAND).toBe("/unavailable");
    expect(buildHubRedirectUrl("/dashboard", "")).toBe("/home");
    expect(buildHubRedirectUrl("/analytics", "")).toBe("/unavailable");
    expect(buildHubRedirectUrl("/marketplace", "")).toBe("/unavailable");
    expect(buildHubRedirectUrl("/onboarding", "")).toBe("/home?tour=1");
  });

  it("sends auth fallback to home", () => {
    expect(AUTH_SIGN_IN_FALLBACK).toBe("/home");
  });
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
