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
  resolveHubTarget,
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

  it("soft-lands stubs and dashboard; onboarding lands on home", () => {
    expect(STUB_LAND).toBe("/unavailable");
    expect(buildHubRedirectUrl("/dashboard", "")).toBe("/home");
    expect(buildHubRedirectUrl("/analytics", "")).toBe("/unavailable");
    expect(buildHubRedirectUrl("/marketplace", "")).toBe("/unavailable");
    expect(buildHubRedirectUrl("/onboarding", "")).toBe("/home");
  });

  // Which mechanism serves each mapping is a behavioural contract, not
  // an implementation detail: a rewrite keeps the URL (and therefore
  // skips a second pass through the middleware), a redirect changes it.
  it("serves removed surfaces with a rewrite and moved ones with a redirect", () => {
    // Gone, not moved — the "Page moved" body belongs at the URL the
    // user asked for, so the address bar still names the dead link.
    expect(resolveHubTarget("/marketplace", "")).toEqual({
      destination: "/unavailable",
      mode: "rewrite",
    });
    expect(resolveHubTarget("/analytics/deep", "")).toEqual({
      destination: "/unavailable",
      mode: "rewrite",
    });

    // Moved. `/lab/*` and `/dashboard` must land on the canonical URL —
    // the shell keys the sidebar's active item, PortalCatalogSync's
    // route-scoped prefetch and useQueryPatch off `usePathname()`.
    expect(resolveHubTarget("/lab/traces", "?id=tr_01")).toEqual({
      destination: "/traces?id=tr_01",
      mode: "redirect",
    });
    expect(resolveHubTarget("/dashboard", "")).toEqual({
      destination: "/home",
      mode: "redirect",
    });

    // Legacy /onboarding → /home. Do not force ?onboarding=1 — finished
    // tours must not reopen; active users still see the banner.
    expect(resolveHubTarget("/onboarding", "")).toEqual({
      destination: "/home",
      mode: "redirect",
    });

    expect(resolveHubTarget("/onboarding/connect", "?installation_id=42")).toEqual({
      destination: "/agents/connect?installation_id=42",
      mode: "redirect",
    });
    expect(resolveHubTarget("/onboarding/connect", "")).toEqual({
      destination: "/agents/connect",
      mode: "redirect",
    });

    expect(resolveHubTarget("/traces", "")).toBeNull();

    // Legacy /alerts → Detectors (not /home).
    expect(resolveHubTarget("/alerts", "")).toEqual({
      destination: "/signals",
      mode: "redirect",
    });
    expect(resolveHubTarget("/alerts", "?id=sig_1")).toEqual({
      destination: "/signals?id=sig_1",
      mode: "redirect",
    });
  });

  it("sends auth fallback to home; sign-up opens tour", () => {
    expect(AUTH_SIGN_IN_FALLBACK).toBe("/home");
    expect(AUTH_SIGN_UP_FALLBACK).toBe("/home?onboarding=1");
  });

  it("preserves the query string on /onboarding, like every other branch", () => {
    expect(buildHubRedirectUrl("/onboarding", "?ref=welcome")).toBe(
      "/home?ref=welcome",
    );
    expect(buildHubRedirectUrl("/onboarding", "ref=welcome")).toBe(
      "/home?ref=welcome",
    );
    // No incoming query — behavior is unchanged.
    expect(buildHubRedirectUrl("/onboarding", "")).toBe("/home");
  });

  it("produces a URL for /onboarding that a real URL parser can decode", () => {
    const result = buildHubRedirectUrl("/onboarding", "?ref=welcome");
    expect(result).not.toBeNull();
    const parsed = new URL(result as string, "https://example.test");
    expect(parsed.searchParams.get("onboarding")).toBeNull();
    expect(parsed.searchParams.get("ref")).toBe("welcome");
    expect([...parsed.searchParams.keys()]).toEqual(["ref"]);
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

  it("command palette derives routes from lab/nav SoT", async () => {
    const { buildNavCommands, collectSidebarHrefs } = await import(
      "@/lib/nav-commands"
    );
    const cmds = buildNavCommands();
    const detectors = cmds.find(
      (c) => c.href === "/signals" && c.label === "Detectors",
    );
    expect(detectors).toBeTruthy();
    expect(cmds.find((c) => c.label === "Assistant")?.href).toBe("/agent");
    expect(
      cmds.find((c) => c.href === "/settings?mode=audit")?.label,
    ).toBe("Audit trail");
    const hrefs = collectSidebarHrefs();
    expect(hrefs).toContain("/signals");
    expect(hrefs).toContain("/home");
    expect(hrefs).toEqual(
      expect.arrayContaining(PRIMARY_NAV.map((i) => i.href.split("?")[0])),
    );
  });
});
