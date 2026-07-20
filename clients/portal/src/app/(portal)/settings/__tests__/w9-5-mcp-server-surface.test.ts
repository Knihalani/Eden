/**
 * W9.5 — Portal MCP settings/keys surface: org-scoped key mint + UI hygiene.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W9.5 MCP settings surface", () => {
  it("createMcpKey posts to path-scoped /orgs/{orgId}/mcp/keys", () => {
    const src = read("lib/api/resources.ts");
    expect(src).toMatch(
      /createMcpKey:[\s\S]*?`\/orgs\/\$\{orgId\}\/mcp\/keys`/,
    );
  });

  it("mcp-tab clears minted raw key on org switch (no cross-tenant bleed)", () => {
    const src = read("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(src).toContain("useEffect");
    expect(src).toMatch(/setRawKey\(null\)/);
    expect(src).toMatch(/\[org\?\.id\]/);
  });

  it("mcp-tab createMcpKey uses selected org.id (not header-only)", () => {
    const src = read("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(src).toMatch(/api\.createMcpKey\(org\.id/);
    expect(src).toMatch(/if\s*\(\s*!org\s*\|\|\s*!canManageKeys\s*\)\s*return/);
  });

  it("mcp-tab surfaces create errors via toast (not silent)", () => {
    const src = read("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(src).toContain("toast.error");
    expect(src).toContain("Failed to create MCP key");
  });
});
