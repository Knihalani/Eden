/**
 * W5-B — Invite / auth fallback / forgot-password polish guards.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5-B invite ErrorState", () => {
  it("uses shared ErrorState for verify and accept failures", () => {
    const src = read("app/(auth)/invite/[token]/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("ErrorState");
    expect(src).toContain("Could not accept invitation");
    expect(src).toContain("Try again");
  });
});

describe("W5-B clerk auth fallback retry", () => {
  it("offers Try again reload when Clerk mount fails", () => {
    const src = read("components/auth/clerk-auth-fallback.tsx");
    expect(src).toContain("Try again");
    expect(src).toContain("window.location.reload()");
  });
});

describe("W5-B forgot-password loading copy", () => {
  it("aligns loading title with redirect page", () => {
    const loading = read("app/(auth)/forgot-password/loading.tsx");
    const page = read("app/(auth)/forgot-password/page.tsx");
    expect(loading).toContain("Password reset moved");
    expect(page).toContain("Password reset moved");
    expect(page).toContain("min-h-11");
  });
});
