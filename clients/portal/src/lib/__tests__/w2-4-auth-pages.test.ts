// @vitest-environment node
/**
 * Wave 2.4 — auth-pages-polish: redirect_url sanitization, soft health
 * HTTP rewrite, cookie banner auth-path skip, Clerk force→fallback.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_SIGN_IN_FALLBACK,
  AUTH_SIGN_UP_FALLBACK,
  buildAuthClerkRedirectProps,
  isAuthPath,
  sanitizeAuthRedirectUrl,
} from "@/lib/auth-redirect";
import {
  isSoftDegradedHealth,
  mapHealthResponse,
} from "@/lib/health-status";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W2.4 sanitizeAuthRedirectUrl", () => {
  it("accepts relative portal deep links with query", () => {
    expect(sanitizeAuthRedirectUrl("/docs-fill?op=fill")).toBe(
      "/docs-fill?op=fill",
    );
    expect(sanitizeAuthRedirectUrl("/traces")).toBe("/traces");
  });

  it("rejects open redirects and auth loops", () => {
    expect(sanitizeAuthRedirectUrl("https://evil.example/phish")).toBeNull();
    expect(sanitizeAuthRedirectUrl("//evil.example/phish")).toBeNull();
    expect(sanitizeAuthRedirectUrl("/sign-in")).toBeNull();
    expect(sanitizeAuthRedirectUrl("/login/factor-one")).toBeNull();
    expect(sanitizeAuthRedirectUrl("")).toBeNull();
    expect(sanitizeAuthRedirectUrl(null)).toBeNull();
  });
});

describe("W2.4 buildAuthClerkRedirectProps", () => {
  it("uses force only when redirect_url is safe; cross-link is fallback", () => {
    const signIn = buildAuthClerkRedirectProps("/traces", "sign-in");
    expect(signIn.forceRedirectUrl).toBe("/traces");
    expect(signIn.fallbackRedirectUrl).toBe(AUTH_SIGN_IN_FALLBACK);
    expect(signIn.crossLinkUrl).toContain("/sign-up?redirect_url=");
    expect(signIn.crossLinkUrl).toContain(encodeURIComponent("/traces"));
    expect(signIn.crossLinkFallbackRedirectUrl).toBe("/traces");

    const bare = buildAuthClerkRedirectProps(undefined, "sign-in");
    expect(bare.forceRedirectUrl).toBeUndefined();
    expect(bare.fallbackRedirectUrl).toBe(AUTH_SIGN_IN_FALLBACK);
    expect(bare.crossLinkUrl).toBe("/sign-up");
    expect(bare.crossLinkFallbackRedirectUrl).toBe(AUTH_SIGN_UP_FALLBACK);
  });

  it("sign-up mode defaults to dashboard fallback (tour is opt-in)", () => {
    const signUp = buildAuthClerkRedirectProps(null, "sign-up");
    expect(signUp.fallbackRedirectUrl).toBe(AUTH_SIGN_UP_FALLBACK);
    expect(AUTH_SIGN_UP_FALLBACK).toBe("/dashboard");
    expect(signUp.crossLinkUrl).toBe("/sign-in");
    expect(signUp.crossLinkFallbackRedirectUrl).toBe(AUTH_SIGN_IN_FALLBACK);
  });
});

describe("W2.4 isAuthPath (F3 cookie banner)", () => {
  it.each([
    "/sign-in",
    "/sign-in/factor-one",
    "/sign-up",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/invite/abc",
  ])("treats %s as auth", (path) => {
    expect(isAuthPath(path)).toBe(true);
  });

  it.each(["/", "/dashboard", "/pricing", "/traces"])(
    "treats %s as non-auth",
    (path) => {
      expect(isAuthPath(path)).toBe(false);
    },
  );
});

describe("W2.4 soft-degraded health (console 503 noise)", () => {
  const degradedQdrantBody = {
    status: "degraded",
    version: "0.1.0",
    postgres: "connected",
    qdrant: "error: [Errno 99] Cannot assign requested address",
  };

  it("flags soft degraded for UI HTTP rewrite", () => {
    expect(isSoftDegradedHealth(degradedQdrantBody)).toBe(true);
    expect(isSoftDegradedHealth({ status: "unhealthy" })).toBe(false);
    expect(isSoftDegradedHealth(null)).toBe(false);
  });

  it("still maps soft-degraded body to degraded UI state at 200", () => {
    expect(mapHealthResponse(200, degradedQdrantBody)).toBe("degraded");
    expect(mapHealthResponse(200, degradedQdrantBody)).not.toBe("ok");
  });
});

describe("W2.4 /api/health soft rewrite", () => {
  it("route rewrites upstream 503 + soft body to HTTP 200 (source)", () => {
    const src = read("app/api/health/route.ts");
    expect(src).toContain("isSoftDegradedHealth");
    expect(src).toContain("response.status === 503");
    expect(src).toMatch(/status:\s*200/);
    expect(src).toContain('status: "degraded"');
  });

  it("soft predicate drives 200 rewrite; hard unhealthy stays 503", () => {
    const softBody = {
      status: "degraded",
      postgres: "connected",
      qdrant: "error: [Errno 99] Cannot assign requested address",
    };
    const hardBody = { status: "unhealthy", postgres: "down" };
    expect(isSoftDegradedHealth(softBody)).toBe(true);
    expect(isSoftDegradedHealth(hardBody)).toBe(false);
    // Mirror route.ts branch: soft 503 → 200; hard 503 stays 503.
    const softOut = 503 === 503 && isSoftDegradedHealth(softBody) ? 200 : 503;
    const hardOut = 503 === 503 && isSoftDegradedHealth(hardBody) ? 200 : 503;
    expect(softOut).toBe(200);
    expect(hardOut).toBe(503);
    expect(mapHealthResponse(softOut, softBody)).toBe("degraded");
  });
});

describe("W2.4 public /status + /health (no portal soft-404)", () => {
  it("marketing status page exists and maps health honestly", () => {
    const src = read("app/(marketing)/status/page.tsx");
    expect(src).toContain("forwardToBackend");
    expect(src).toContain("mapHealthResponse");
    expect(src).toContain("Partial degradation");
    expect(src).not.toContain("PortalChrome");
    expect(src).toContain('data-health-state={state}');
  });

  it("marketing /health aliases /status", () => {
    const src = read("app/(marketing)/health/page.tsx");
    expect(src).toContain('redirect("/status")');
  });

  it("Clerk public matcher includes /status and /health", () => {
    const src = read("proxy.ts");
    expect(src).toContain('"/status(.*)"');
    expect(src).toContain('"/health(.*)"');
    expect(src).toContain('"/api/health"');
  });

  it("portal catch-all soft-404 route is removed", () => {
    expect(() => read("app/(portal)/[...notFound]/page.tsx")).toThrow();
  });
});

describe("W2.4 auth page source guards", () => {
  it("sign-in pages use redirect helper + signUpFallback (not force)", () => {
    for (const rel of [
      "app/sign-in/[[...sign-in]]/page.tsx",
      "app/(auth)/login/[[...login]]/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain("buildAuthClerkRedirectProps");
      expect(src).toContain("signUpFallbackRedirectUrl");
      expect(src).not.toContain("signUpForceRedirectUrl");
      expect(src).not.toContain("signInForceRedirectUrl");
    }
  });

  it("sign-up pages use redirect helper + signInFallback (not force)", () => {
    for (const rel of [
      "app/sign-up/[[...sign-up]]/page.tsx",
      "app/(auth)/signup/[[...signup]]/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain("buildAuthClerkRedirectProps");
      expect(src).toContain("signInFallbackRedirectUrl");
      expect(src).not.toContain("signUpForceRedirectUrl");
      expect(src).not.toContain("signInForceRedirectUrl");
    }
  });

  it("cookie consent imports shared isAuthPath and tracks pathname", () => {
    const src = read("components/cookie-consent.tsx");
    expect(src).toContain('from "@/lib/auth-redirect"');
    expect(src).toContain("usePathname");
    expect(src).toContain("onAuthRoute");
  });

  it("cookie consent auto-collapses on short pages and reserves banner offset", () => {
    const src = read("components/cookie-consent.tsx");
    expect(src).toContain("SHORT_PAGE_MAX_SCROLLABLE_PX");
    expect(src).toContain("FULL_BANNER_OFFSET_PX");
    // Short pages must collapse — never force collapsed=false when
    // there is no scroll room (that occluded primary CTAs).
    expect(src).toMatch(
      /scrollable\s*<=\s*SHORT_PAGE_MAX_SCROLLABLE_PX[\s\S]*?setCollapsed\(true\)/,
    );
    // Home Shell 2A: after choice render null — no fixed preferences pill.
    expect(src).toMatch(
      /if\s*\(\s*ready\s*&&\s*hasChoice\s*&&\s*!visible\s*\)\s*return\s*null/,
    );
    expect(src).not.toContain("Compact re-open control after a choice");
    expect(src).toContain("OPEN_COOKIE_PREFERENCES_EVENT");
  });

  it("reset-password CTA matches forgot-password touch target", () => {
    const reset = read("app/(auth)/reset-password/page.tsx");
    expect(reset).toContain("min-h-11");
  });
});
