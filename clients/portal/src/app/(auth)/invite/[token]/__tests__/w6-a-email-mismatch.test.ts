/**
 * W6-A — Invite page must surface ErrorState when signed-in email
 * does not match the invitation email (no silent accept failure).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = resolve(__dirname, "../page.tsx");

function read(): string {
  return readFileSync(page, "utf8");
}

describe("W6-A invite email mismatch", () => {
  it("compares signed-in email to invite email and shows ErrorState", () => {
    const src = read();
    expect(src).toContain("useUser");
    expect(src).toContain("signedInPrimaryEmail");
    expect(src).toContain("emailMismatch");
    expect(src).toContain("Wrong account for this invite");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("ErrorState");
    expect(src).toMatch(/signedInEmail\s*!==\s*inviteEmail/);
    expect(src).toContain("Switch account");
  });

  it("does not render Accept invitation when emails mismatch", () => {
    const src = read();
    // Mismatch branch returns early with ErrorState before Accept CTA.
    const mismatchIdx = src.indexOf("Wrong account for this invite");
    const acceptIdx = src.indexOf("Accept invitation");
    expect(mismatchIdx).toBeGreaterThan(-1);
    expect(acceptIdx).toBeGreaterThan(-1);
    expect(mismatchIdx).toBeLessThan(acceptIdx);
  });

  it("signs out back to invite instead of linking to /sign-in while signed in", () => {
    const src = read();
    expect(src).toContain("handleSwitchAccount");
    expect(src).toContain("useClerk");
    expect(src).toMatch(/signOut\(\{\s*redirectUrl:\s*`\/invite\/\$\{token\}`\s*\}\)/);
    const mismatchBlock = src.slice(
      src.indexOf("Wrong account for this invite"),
      src.indexOf("const acceptBlockedByOrgList"),
    );
    expect(mismatchBlock).toContain("handleSwitchAccount");
    // Dead-end: /sign-in while already signed in bounces to dashboard.
    expect(mismatchBlock).not.toMatch(/href=["']\/sign-in["']/);
  });

  it("waits for useUser before deciding mismatch vs accept", () => {
    const src = read();
    expect(src).toContain("userLoaded");
    expect(src).toContain("sessionReady");
    expect(src).toMatch(/!isSignedIn\s*\|\|\s*userLoaded/);
  });
});
