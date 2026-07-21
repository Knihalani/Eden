/**
 * Wave 2 — Personal/team chrome gates (M5↓): Members invite soft-hide +
 * transfer ownership null for personal; evidence marker on empty state.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canInviteMembers,
  canTransferOwnership,
  isPersonalWorkspace,
} from "@/lib/workspace-mode";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS2 personal chrome — helpers", () => {
  it("canInviteMembers / canTransferOwnership false for personal", () => {
    expect(isPersonalWorkspace({ is_personal: true })).toBe(true);
    expect(canInviteMembers({ is_personal: true })).toBe(false);
    expect(canTransferOwnership({ is_personal: true })).toBe(false);
    expect(canInviteMembers({ is_personal: false })).toBe(true);
    expect(canTransferOwnership({ is_personal: false })).toBe(true);
  });
});

describe("WS2 personal chrome — Members tab", () => {
  const src = read("app/(portal)/settings/_components/members-tab.tsx");

  it("gates invite UI with canInviteMembers", () => {
    expect(src).toContain('from "@/lib/workspace-mode"');
    expect(src).toContain("canInviteMembers");
    expect(src).toMatch(
      /canInvite\s*=\s*[\s\S]*?hasPermission\("members:invite"\)\s*&&\s*canInviteMembers\(\s*org\s*\)/,
    );
    expect(src).toMatch(/\{canInvite && \(/);
    expect(src).toMatch(/\{canInvite && <InvitePanel/);
  });

  it("personal empty state teaches upgrade + data-ws2-personal-members", () => {
    expect(src).toContain("data-ws2-personal-members");
    expect(src).toContain("EmptyState");
    expect(src).toContain("Create a team workspace");
    expect(src).toContain('href="/settings?tab=org"');
    expect(src).toContain("isPersonalWorkspace");
    expect(src).toMatch(/if\s*\(\s*isPersonal\s*\)\s*\{/);
  });
});

describe("WS2 personal chrome — transfer ownership", () => {
  it("returns null when canTransferOwnership is false", () => {
    const transfer = read(
      "app/(portal)/settings/_components/transfer-ownership-section.tsx",
    );
    expect(transfer).toContain("canTransferOwnership");
    expect(transfer).toMatch(
      /if\s*\(\s*!canTransferOwnership\(\s*org\s*\)\s*\)\s*return\s*null/,
    );
  });
});
